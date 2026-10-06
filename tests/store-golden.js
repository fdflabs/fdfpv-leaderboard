/*
 * store-golden.js: everything src/store.js answers and keeps, pinned.
 *
 * The store is where the board's data lives, so its contract is wider
 * than its return values: board.json is a file format a checkout keeps
 * between versions, and the Postgres tables are a production database
 * whose rows must read back unchanged after any deploy. This script runs
 * one fixed sequence of writes and reads against a store (publishes,
 * republishes, animations, times on both boards, names and keys, runs,
 * bug tickets with screenshots, statistics counters, removals) and
 * compares every answer with a golden file per backend:
 *
 *   tests/golden/store-file.json   always
 *   tests/golden/store-pg.json     when BOARD_SELFTEST_DATABASE_URL names a
 *                                  Postgres it may create a database on
 *
 * The file run also pins board.json as written after the sequence, and
 * reads back tests/fixtures/board-v1.json, a board.json written by the
 * store this golden was taken from, so a newer store is held to reading
 * an older one's file. Legacy files (no bugs, no runs, no stats, corrupt)
 * are opened too.
 *
 * Timestamps and random ids cannot be pinned, so they are replaced with
 * placeholders before comparing: an id becomes its prefix and the order it
 * first appeared in. `planes` is the vendored simulator's answer and moves
 * when vendor/fdfpv is re-pinned, so it is checked against planesFor
 * itself rather than against the golden.
 *
 *   node tests/store-golden.js           compare
 *   node tests/store-golden.js --write   regenerate (only on purpose)
 *
 * This file is part of the Paraguayan Drone Combat Simulator.
 *
 * The Paraguayan Drone Combat Simulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * The Paraguayan Drone Combat Simulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with the Paraguayan Drone Combat Simulator. If not, see <https://www.gnu.org/licenses/>.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyStatsDay, openStore, planeBoardOf, rowToSummary, shapeStats, statsDayKeys, summaryOf,
} from '../src/store.js';
import { inspectBugCreate, inspectDocument } from '../src/validate.js';
import { planesFor } from '../vendor/fdfpv/src/game/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const WRITE = process.argv.includes('--write');
let failures = 0;

/* ---- documents ---- */

const gate = (id, x, y, extra = {}) => ({
  id, type: 'gate', name: 'Gate', position: { x, y, z: 0 }, yaw: 0, dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 }, ...extra,
});

function fieldDoc(id, name, xs, extra = {}) {
  const elements = xs.map((x, i) => gate(`el-${i + 1}`, x, 10 + i));
  return {
    schemaVersion: 2,
    id,
    name,
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 1, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: { logos: [] },
    elements,
    sequence: elements.map((el, i) => ({ id: `sq-${i + 1}`, elementId: el.id, apertureIndex: 0, entry: 0 })),
    ...extra,
  };
}

const roomDoc = () => ({
  ...fieldDoc('trk-20000001', 'Sala', [1, 2]),
  schemaVersion: 3,
  trackClass: 'micro',
  field: { width: 5, depth: 6, gridSize: 0.0254 },
  credit: { designer: 'Mbói', series: 'Rooms' },
});

const mapDoc = () => {
  const els = [[0, 0], [120, 30], [200, -40]].map(([x, y], i) => ({
    id: `el-${i + 1}`,
    type: 'wideGate5',
    position: { x, y, z: 30 },
    orientation: { w: 1, x: 0, y: 0, z: 0 },
    dims: {},
  }));
  return {
    schemaVersion: 4,
    id: 'trk-30000001',
    name: 'Valle Alto',
    trackClass: 'full',
    map: 'swiss2',
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 1, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: { logos: [] },
    credit: null,
    elements: els,
    sequence: els.map((el, i) => ({ id: `sq-${i + 1}`, elementId: el.id, apertureIndex: 0, entry: 0 })),
  };
};

function must(inspected) {
  if (inspected.error) {
    throw new Error(`fixture document refused: ${inspected.error}`);
  }
  return inspected;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPoeXYYAAQ3AjaAIZITAAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
const GIF = (() => {
  const b = Buffer.alloc(40);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(160, 6);
  b.writeUInt16LE(100, 8);
  return b;
})();

const pause = () => new Promise((r) => setTimeout(r, 5));

/* ---- the sequence ---- */

/*
 * Each step is [label, fn]; fn gets the store and a scratch object for
 * values later steps need (edit keys, ids). Steps run one at a time with a
 * pause between them, so every timestamp is distinct and every order by
 * time is the same on every run.
 */
const STEPS = [
  ['publish field', async (s, c) => {
    const r = await s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera', [10, 20, 30]))), author: 'Ada', editKey: '', tags: ['race'] });
    c.fieldKey = r.editKey;
    return r;
  }],
  ['publish field again, no key', (s) => s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera', [10, 20, 30]))), author: 'Ada', editKey: '' })],
  ['publish field again, wrong key', (s) => s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera', [10, 20, 30]))), author: 'Ada', editKey: 'f'.repeat(32) })],
  ['publish room', async (s, c) => {
    const r = await s.publish({ inspected: must(inspectDocument(roomDoc())), author: 'Bo', editKey: '', tags: ['skills', 'beginner'] });
    c.roomKey = r.editKey;
    return r;
  }],
  ['publish map', async (s, c) => {
    const r = await s.publish({ inspected: must(inspectDocument(mapDoc())), author: 'Cy', editKey: '' });
    c.mapKey = r.editKey;
    return r;
  }],
  ['time Ada 42000', (s) => s.addTime({ trackId: 'trk-10000001', name: 'Ada', lapMs: 42000, key: 'K-ada' })],
  ['time Bo 41000 with ghost and three', (s) => s.addTime({ trackId: 'trk-10000001', name: 'Bo', lapMs: 41000, threeMs: 125000, ghost: 'R0hPU1Q=', key: 'K-bo' })],
  ['time Cy 41000 ties later', (s) => s.addTime({ trackId: 'trk-10000001', name: 'Cy', lapMs: 41000, key: 'K-cy' })],
  ['time on a missing track', (s) => s.addTime({ trackId: 'trk-0000dead', name: 'Ada', lapMs: 1000 })],
  ['parallel times', async (s) => {
    const r = await Promise.all([
      s.addTime({ trackId: 'trk-10000001', name: 'Di', lapMs: 50000 }),
      s.addTime({ trackId: 'trk-10000001', name: 'Ev', lapMs: 50500 }),
    ]);
    return r.map((x) => ({ name: x.name, times: x.times })).sort((a, b) => a.name.localeCompare(b.name));
  }],
  ['quad time on map', (s) => s.addTime({ trackId: 'trk-30000001', name: 'Cy', lapMs: 90000 })],
  ['plane time on map', (s) => s.addTime({ trackId: 'trk-30000001', name: 'Ada', lapMs: 95000, craft: 'sky1800' })],
  ['faster plane time on map', (s) => s.addTime({ trackId: 'trk-30000001', name: 'Bo', lapMs: 80000, craft: 'cub1400' })],
  ['room time with three', (s) => s.addTime({ trackId: 'trk-20000001', name: 'Bo', lapMs: 9000, threeMs: 27500 })],
  ['get field', (s) => s.getTrack('trk-10000001')],
  ['get map', (s) => s.getTrack('trk-30000001')],
  ['get missing', (s) => s.getTrack('trk-0000dead')],
  ['list', (s) => s.listTracks()],
  ['document', (s) => s.getDocument('trk-20000001')],
  ['document missing', (s) => s.getDocument('trk-0000dead')],
  ['ghost', async (s) => {
    const t = await s.getTrack('trk-10000001');
    return s.getGhost('trk-10000001', t.times.find((x) => x.name === 'Bo').id);
  }],
  ['ghost of a time without one', async (s) => {
    const t = await s.getTrack('trk-10000001');
    return s.getGhost('trk-10000001', t.times.find((x) => x.name === 'Ada').id);
  }],
  ['ghost missing', (s) => s.getGhost('trk-10000001', 'tm-00000000')],
  ['gif by owner', (s, c) => s.setGif({ id: 'trk-20000001', bytes: GIF, editKey: c.roomKey })],
  ['gif by a stranger', (s) => s.setGif({ id: 'trk-20000001', bytes: GIF, editKey: 'nope' })],
  ['gif with no key', (s) => s.setGif({ id: 'trk-20000001', bytes: GIF })],
  ['gif by admin', (s) => s.setGif({ id: 'trk-10000001', bytes: GIF, admin: true })],
  ['gif on a missing track', (s) => s.setGif({ id: 'trk-0000dead', bytes: GIF, admin: true })],
  ['get gif', (s) => s.getGif('trk-20000001')],
  ['get gif missing', (s) => s.getGif('trk-30000001')],
  ['rename keeps times and gif', (s, c) => s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera Norte', [10, 20, 30]))), author: 'Ada', editKey: c.fieldKey, tags: ['race', 'technical'] })],
  ['after rename', (s) => s.getTrack('trk-10000001')],
  ['new author renames their times', (s, c) => s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera Norte', [10, 20, 30]))), author: 'Ada Two', editKey: c.fieldKey })],
  ['after new author', (s) => s.getTrack('trk-10000001')],
  ['relayout clears times and gif', (s, c) => s.publish({ inspected: must(inspectDocument(fieldDoc('trk-10000001', 'Costanera Norte', [10, 25, 30]))), author: 'Ada Two', editKey: c.fieldKey })],
  ['after relayout', (s) => s.getTrack('trk-10000001')],
  ['gif after relayout', (s) => s.getGif('trk-10000001')],
  ['time after relayout', (s) => s.addTime({ trackId: 'trk-10000001', name: 'Ada Two', lapMs: 39000, key: 'K-ada' })],
  ['claim new', (s) => s.claimName('Ada', 'K-ada')],
  ['claim again same key', (s) => s.claimName('Ada', 'K-ada')],
  ['claim other case', (s) => s.claimName(' ADA ', 'K-ada')],
  ['claim by another key', (s) => s.claimName('ada', 'K-bo')],
  ['claim second name', (s) => s.claimName('Ada Two', 'K-ada')],
  ['move key', (s) => s.moveKey('K-ada', 'K-ada2')],
  ['move key nothing', (s) => s.moveKey('K-none', 'K-x')],
  ['claim after move, old key', (s) => s.claimName('Ada', 'K-ada')],
  ['claim after move, new key', (s) => s.claimName('Ada', 'K-ada2')],
  ['run first', (s) => s.addRun({ name: 'Ada', map: 'alps', style: 'expert', score: 5000, durationMs: 120000, tricks: 20, unique: 8, bestCombo: 2000, bestTrick: 800, crashes: 1, signature: 'Matty flip' })],
  ['run worse', (s) => s.addRun({ name: 'ADA', map: 'alps', style: 'arcade', score: 4000, durationMs: 120000, tricks: 20, unique: 8, bestCombo: 2000, bestTrick: 800, crashes: 1, signature: '' })],
  ['run equal', (s) => s.addRun({ name: 'ada', map: 'alps', style: 'expert', score: 5000, durationMs: 120000, tricks: 20, unique: 8, bestCombo: 2000, bestTrick: 800, crashes: 1, signature: '' })],
  ['run other pilot same score', (s) => s.addRun({ name: 'Bo', map: 'alps', style: 'expert', score: 5000, durationMs: 100000, tricks: 10, unique: 5, bestCombo: 900, bestTrick: 700, crashes: 0, signature: 'Power loop' })],
  ['run better', (s) => s.addRun({ name: 'Ada', map: 'alps', style: 'expert', score: 9000, durationMs: 110000, tricks: 30, unique: 12, bestCombo: 3000, bestTrick: 850, crashes: 2, signature: 'Split S' })],
  ['run other map', (s) => s.addRun({ name: 'Ada', map: 'swiss2', style: 'arcade', score: 100, durationMs: 5000, tricks: 1, unique: 1, bestCombo: 100, bestTrick: 100, crashes: 0, signature: '' })],
  ['runs all', (s) => s.listRuns()],
  ['runs alps', (s) => s.listRuns({ map: 'alps' })],
  ['runs none', (s) => s.listRuns({ map: 'yellowstone' })],
  ['bug one', (s) => s.addBug(inspectBugCreate({
    kind: 'feel', title: 'Yaw feels late', what: 'A right yaw stick takes a beat before the quad turns.', reporter: 'Ada', context: { map: 'field', gpu: 'x' },
  }))],
  ['bug with shots', (s) => s.addBug(inspectBugCreate({
    kind: 'visual', title: 'Gate draws black', what: 'The third gate draws completely black at dusk.', images: [PNG.toString('base64'), JPEG.toString('base64')],
  }))],
  ['bug no context', (s) => s.addBug(inspectBugCreate({ kind: 'crash', title: 'Crash on load', what: 'The page crashed while loading the alps map.' }))],
  ['bugs all', (s) => s.listBugs()],
  ['bugs open visual', (s) => s.listBugs({ status: 'open', kind: 'visual' })],
  ['bugs limit 1', (s) => s.listBugs({ limit: 1 })],
  ['bugs limit junk', (s) => s.listBugs({ limit: 'x' })],
  ['bug get', async (s) => s.getBug((await s.listBugs({ kind: 'visual' }))[0].id)],
  ['bug image 1', async (s) => s.getBugImage((await s.listBugs({ kind: 'visual' }))[0].id, 1)],
  ['bug image 2', async (s) => s.getBugImage((await s.listBugs({ kind: 'visual' }))[0].id, 2)],
  ['bug image 3', async (s) => s.getBugImage((await s.listBugs({ kind: 'visual' }))[0].id, 3)],
  ['bug update status', async (s) => s.updateBug((await s.listBugs({ kind: 'feel' }))[0].id, { status: 'fixed', resolution: 'Rates.' })],
  ['bug update resolution only', async (s) => s.updateBug((await s.listBugs({ kind: 'visual' }))[0].id, { resolution: 'Looking.' })],
  ['bug update status only', async (s) => s.updateBug((await s.listBugs({ kind: 'crash' }))[0].id, { status: 'in_progress' })],
  ['bug update missing', (s) => s.updateBug('bug-00000000', { status: 'open' })],
  ['bugs fixed', (s) => s.listBugs({ status: 'fixed' })],
  ['bug get missing', (s) => s.getBug('bug-00000000')],
  ['stats', async (s) => {
    const ev = [
      [{ kind: 'visit', surface: 'board', returning: false, source: 'direct' }, '2026-10-01', 'AU'],
      [{ kind: 'visit', surface: 'sim', returning: true, source: 'acme' }, '2026-10-01', 'ZZ'],
      [{ kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad', source: 'direct' }, '2026-10-01', 'AU'],
      [{ kind: 'flush', craft: '5inch', map: 'custom', laps: 3, flightS: 50, crashes: 1, source: 'direct' }, '2026-10-01', 'AU'],
      [{ kind: 'flush', craft: '5inch', map: 'custom', laps: 0, flightS: 60, crashes: 0, source: 'direct' }, '2026-10-02', 'NZ'],
      [{ kind: 'session', craft: 'sky1800', map: 'city', input: 'keyboard', source: 'acme' }, '2026-10-05', 'NZ'],
      [{ kind: 'visit', surface: 'landing', returning: false, source: 'other' }, '2026-10-06', 'FR'],
      [{ kind: 'visit', surface: 'board', returning: false, source: 'direct' }, '2026-08-01', 'BR'],
    ];
    for (const [event, day, country] of ev) {
      await s.recordStats(event, { day, country });
    }
    return 'recorded';
  }],
  ['stats 7 days', (s) => s.readStats({ days: 7, now: Date.parse('2026-10-06T12:00:00Z') })],
  ['stats 30 days', (s) => s.readStats({ days: 30, now: Date.parse('2026-10-06T23:59:59Z') })],
  ['stats 90 days', (s) => s.readStats({ days: 90, now: Date.parse('2026-10-06T00:00:00Z') })],
  ['facts', (s) => s.boardFacts()],
  ['remove room', (s) => s.removeTrack('trk-20000001')],
  ['remove missing', (s) => s.removeTrack('trk-20000001')],
  ['list after remove', (s) => s.listTracks()],
  ['facts after remove', (s) => s.boardFacts()],
];

/* ---- the pure exports ---- */

function pure() {
  const doc = mapDoc();
  const track = {
    id: doc.id, name: doc.name, author: 'Cy', gates: 3, elements: 3, hasLogo: false, document: doc,
    publishedUtc: '2026-10-01T00:00:00.000Z', updatedUtc: '2026-10-02T00:00:00.000Z', tags: null, gif: 'R0lG', gifUtc: '2026-10-03T00:00:00.000Z',
  };
  const times = [
    { name: 'A', lapMs: 5, postedUtc: '2026-10-01T00:00:02Z' },
    { name: 'B', lapMs: 5, postedUtc: '2026-10-01T00:00:01Z' },
    { name: 'C', lapMs: 3, postedUtc: '2026-10-01T00:00:03Z', craft: 'sky1800' },
  ];
  const stale = { ...track, document: null, plan: { width: 1, depth: 2, marks: [], path: [] } };
  return {
    summaryOf: summaryOf(track, times),
    summaryOfNoDocument: summaryOf(stale, []),
    summaryOfNothing: summaryOf({ ...track, document: null, plan: null }, []),
    planeBoardField: planeBoardOf(fieldDoc('trk-10000009', 'x', [1]), 4, { name: 'A', lapMs: 1, extra: 1 }),
    planeBoardMap: planeBoardOf(doc, 2, null),
    emptyStatsDay: emptyStatsDay('2026-10-06'),
    statsDayKeys: [statsDayKeys(Date.parse('2026-03-29T01:30:00Z'), 3), statsDayKeys(0, 1), statsDayKeys('2026-10-06T23:59:59.999Z', 2)],
    shapeStats: shapeStats({
      now: Date.parse('2026-10-06T12:00:00Z'),
      days: 3,
      dayRows: new Map([['2026-10-05', { ...emptyStatsDay('2026-10-05'), visits: 2, sessions: 1 }]]),
      dimRows: [
        { dim: 'country', key: 'ZZ', visits: 9, sessions: 9, laps: 9 },
        { dim: 'country', key: 'AU', visits: 1, sessions: 1, laps: 0 },
        { dim: 'country', key: 'NZ', visits: 2, sessions: 1, laps: 0 },
        { dim: 'country', key: 'BR', visits: 2, sessions: 1, laps: 0 },
        { dim: 'craft', key: '5inch', visits: 0, sessions: 1, laps: 4 },
        { dim: 'source', key: 'direct', visits: 3, sessions: 0, laps: 0 },
      ],
      allTime: { visits: 10 },
      firstDay: undefined,
      countriesAllTime: 3,
    }),
    rowToSummary: rowToSummary({
      id: doc.id, name: doc.name, author: 'Cy', gates: 3, elements: 3, has_logo: true, document: doc,
      published_utc: '2026-10-01T00:00:00.000Z', updated_utc: '2026-10-02T00:00:00.000Z', tags: null, has_gif: null, gif_utc: undefined,
    }),
  };
}

/* ---- normalising ---- */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normaliser() {
  const seen = new Map();
  const alias = (kind, value) => {
    const k = `${kind}:${value}`;
    if (!seen.has(k)) {
      seen.set(k, `<${kind}-${[...seen.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}>`);
    }
    return seen.get(k);
  };
  const walk = (v, key) => {
    if (v instanceof Date) {
      return '<t>';
    }
    if (Buffer.isBuffer(v)) {
      return `<bytes ${v.length} ${createHash('sha256').update(v).digest('hex').slice(0, 16)}>`;
    }
    if (Array.isArray(v)) {
      return key === 'planes' ? '<planes>' : v.map((x) => walk(x));
    }
    if (v && typeof v === 'object') {
      /* Keys can be ids too (board.json files bugs by id); they are
       * aliased like values and sorted after aliasing. */
      return Object.fromEntries(Object.keys(v)
        .map((k) => [walk(k), walk(v[k], k)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    if (typeof v !== 'string') {
      return v === undefined ? '<undefined>' : v;
    }
    if (ISO.test(v)) {
      return '<t>';
    }
    const id = v.match(/^(tm|run|bug)-[0-9a-f]{8}$/);
    if (id) {
      return alias(id[1], v);
    }
    if (/^[0-9a-f]{32}$/.test(v) && key === 'editKey') {
      return alias('key', v);
    }
    if (/^[0-9a-f]{64}$/.test(v) && key === 'editKeyHash') {
      return alias('keyhash', v);
    }
    return v;
  };
  return walk;
}

/* `planes` in every summary is the simulator's own planesFor, or empty
 * off a map. */
function planesHold(value, docs) {
  let ok = true;
  const visit = (v) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!v || typeof v !== 'object') {
      return;
    }
    if ('planes' in v && typeof v.id === 'string' && docs.has(v.id)) {
      const want = docs.get(v.id).schemaVersion === 4 ? planesFor(docs.get(v.id)) : [];
      ok = ok && JSON.stringify(v.planes) === JSON.stringify(want);
    }
    Object.values(v).forEach(visit);
  };
  visit(value);
  return ok;
}

/*
 * Rows as older versions of the board wrote them: a schema 1 track with no
 * tags and no animation, times with no public id, ghost, three lap total,
 * key or craft (one pilot on two days, spelled two ways), a ticket with no
 * screenshots, steps or context, a run with no public id. They have to
 * read back as they always did.
 */
const OLD_DOC = {
  schemaVersion: 1, id: 'trk-40000001', name: 'Viejo', field: { width: 60, depth: 40, gridSize: 1 },
  settings: {}, branding: { logo: null, logoName: '' }, elements: [gate('el-1', 30, 20)],
  sequence: [{ id: 'sq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 }],
};
const OLD = {
  track: {
    id: 'trk-40000001', name: 'Viejo', author: 'Old', document: OLD_DOC, plan: { width: 60, depth: 40, marks: [] },
    layoutHash: 'a'.repeat(64), editKeyHash: 'b'.repeat(64), hasLogo: false, gates: 1, elements: 1,
    publishedUtc: '2026-01-01T00:00:00.000Z', updatedUtc: '2026-01-02T00:00:00.000Z',
  },
  times: [
    { name: 'Old A', lapMs: 30000, postedUtc: '2026-01-01T10:00:00.000Z' },
    { name: 'old a', lapMs: 29000, postedUtc: '2026-01-03T10:00:00.000Z' },
    { name: 'Once', lapMs: 31000, postedUtc: '2026-01-03T11:00:00.000Z' },
  ],
  bug: {
    id: 'bug-0000abcd', status: 'open', kind: 'other', title: 'Old ticket', what: 'Written before screenshots existed.',
    reporter: 'Anonymous', resolution: '', submittedUtc: '2026-01-04T00:00:00.000Z', updatedUtc: '2026-01-04T00:00:00.000Z',
  },
  run: {
    name: 'Old Run', map: 'yellowstone', style: 'expert', score: 300, durationMs: 60000, tricks: 3, unique: 2,
    bestCombo: 200, bestTrick: 150, crashes: 0, postedUtc: '2026-01-05T00:00:00.000Z',
  },
};

async function seedOldPg(store) {
  const q = (sql, args) => store.pool.query(sql, args);
  const t = OLD.track;
  await q(`INSERT INTO tracks (id, name, author, document, plan, layout_hash, edit_key_hash, has_logo, gates, elements, published_utc, updated_utc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [t.id, t.name, t.author, t.document, t.plan, t.layoutHash, t.editKeyHash, t.hasLogo, t.gates, t.elements, t.publishedUtc, t.updatedUtc]);
  for (const row of OLD.times) {
    await q('INSERT INTO times (track_id, name, lap_ms, posted_utc) VALUES ($1,$2,$3,$4)', [t.id, row.name, row.lapMs, row.postedUtc]);
  }
  const b = OLD.bug;
  await q(`INSERT INTO bugs (id, status, kind, title, what, reporter, submitted_utc, updated_utc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [b.id, b.status, b.kind, b.title, b.what, b.reporter, b.submittedUtc, b.updatedUtc]);
  const r = OLD.run;
  await q(`INSERT INTO runs (name, map, style, score, duration_ms, tricks, unique_tricks, best_combo, best_trick, crashes, posted_utc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [r.name, r.map, r.style, r.score, r.durationMs, r.tricks, r.unique, r.bestCombo, r.bestTrick, r.crashes, r.postedUtc]);
}

function oldBoardFile() {
  return JSON.stringify({
    tracks: { [OLD.track.id]: OLD.track },
    times: { [OLD.track.id]: OLD.times },
    bugs: { [OLD.bug.id]: OLD.bug },
    runs: [OLD.run],
  });
}

/* Everything a store can be asked to read, from whatever it holds. */
async function readAll(store) {
  const walk = normaliser();
  const tracks = await store.listTracks();
  const sheets = await Promise.all(tracks.map((t) => store.getTrack(t.id)));
  const bugs = await store.listBugs();
  return walk({
    list: tracks,
    tracks: sheets,
    documents: await Promise.all(tracks.map((t) => store.getDocument(t.id))),
    gifs: await Promise.all(tracks.map((t) => store.getGif(t.id))),
    ghosts: await Promise.all(sheets.map((sheet) => Promise.all(sheet.times.map((x) => store.getGhost(sheet.id, x.id))))),
    runs: await store.listRuns(),
    bugs: await Promise.all(bugs.map((b) => store.getBug(b.id))),
    images: await Promise.all(bugs.map((b) => store.getBugImage(b.id, 1))),
    stats: await store.readStats({ days: 30, now: Date.parse('2026-10-06T12:00:00Z') }),
    facts: await store.boardFacts(),
  });
}

async function runSteps(store) {
  const walk = normaliser();
  const ctx = {};
  const out = [];
  const docs = new Map([[mapDoc().id, mapDoc()], ['trk-10000001', fieldDoc('trk-10000001', '', [1])], [roomDoc().id, roomDoc()]]);
  for (const [label, fn] of STEPS) {
    const answer = await fn(store, ctx);
    if (!planesHold(answer, docs)) {
      failures += 1;
      console.log(`  FAIL  ${label}: planes differ from the simulator's planesFor`);
    }
    out.push([label, walk(answer)]);
    await pause();
  }
  return { out, walk };
}

async function fileBackend() {
  const dir = mkdtempSync(join(tmpdir(), 'store-golden-'));
  try {
    delete process.env.DATABASE_URL;
    process.env.BOARD_FILE = join(dir, 'board.json');
    const store = await openStore();
    const { out, walk } = await runSteps(store);
    const raw = readFileSync(process.env.BOARD_FILE, 'utf8');
    if (WRITE) {
      writeFileSync(join(here, 'fixtures', 'board-v1.json'), raw);
    }
    const result = { kind: store.kind, steps: out, file: walk(JSON.parse(raw)) };

    /* An older store's file, read back whole by this one. */
    copyFileSync(join(here, 'fixtures', 'board-v1.json'), join(dir, 'old.json'));
    process.env.BOARD_FILE = join(dir, 'old.json');
    result.oldFile = await readAll(await openStore());

    writeFileSync(join(dir, 'rows.json'), oldBoardFile());
    process.env.BOARD_FILE = join(dir, 'rows.json');
    result.oldRows = await readAll(await openStore());

    /* Files from before bugs, runs, pilots or statistics existed, and
     * files that are not a board at all. */
    const legacy = {};
    const cases = {
      bare: JSON.stringify({ tracks: {}, times: {} }),
      wrongShapes: JSON.stringify({ tracks: {}, times: {}, bugs: [], runs: {}, pilots: [], stats: { days: [], dims: null } }),
      statsArray: JSON.stringify({ tracks: {}, times: {}, stats: [] }),
      noTimes: JSON.stringify({ tracks: {} }),
      corrupt: '{ not json',
    };
    for (const [name, text] of Object.entries(cases)) {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, text);
      process.env.BOARD_FILE = path;
      const s = await openStore();
      await s.recordStats({ kind: 'visit', surface: 'board', returning: false, source: 'direct' }, { day: '2026-10-06', country: 'AU' });
      legacy[name] = {
        tracks: await s.listTracks(),
        bugs: await s.listBugs(),
        runs: await s.listRuns(),
        claim: await s.claimName('Zed', 'K-z'),
        stats: (await s.readStats({ days: 1, now: Date.parse('2026-10-06T12:00:00Z') })).today,
        file: fileState(path, walk),
      };
    }
    process.env.BOARD_FILE = join(dir, 'fresh', 'board.json');
    const fresh = await openStore();
    legacy.missing = { tracks: await fresh.listTracks(), file: JSON.parse(readFileSync(process.env.BOARD_FILE, 'utf8')) };
    result.legacy = walk(legacy);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fileState(path, walk) {
  const text = readFileSync(path, 'utf8');
  try {
    return walk(JSON.parse(text));
  } catch {
    return `<not JSON, ${text.length} characters>`;
  }
}

async function pgBackend(adminUrl) {
  const { default: pg } = await import('pg');
  const name = `store_golden_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let store;
  try {
    process.env.DATABASE_URL = url.toString();
    store = await openStore();
    const { out } = await runSteps(store);
    await seedOldPg(store);
    return { kind: store.kind, steps: out, readAll: await readAll(store) };
  } finally {
    delete process.env.DATABASE_URL;
    if (store?.pool) {
      await store.pool.end();
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

function compare(name, now) {
  const path = join(here, 'golden', name);
  const text = `${JSON.stringify(now, null, 1)}\n`;
  if (WRITE) {
    writeFileSync(path, text);
    console.log(`  wrote tests/golden/${name}`);
    return;
  }
  const want = JSON.parse(readFileSync(path, 'utf8'));
  const flat = (o, prefix = '', acc = new Map()) => {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        flat(v, `${prefix}/${k}`, acc);
      }
    } else {
      acc.set(prefix, o);
    }
    return acc;
  };
  const a = flat(want);
  const b = flat(JSON.parse(text));
  const differ = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  if (differ.length === 0) {
    console.log(`  pass  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}: ${differ.length} value(s) differ`);
  for (const k of differ.slice(0, 25)) {
    console.log(`        ${k}: want ${JSON.stringify(a.get(k))} got ${JSON.stringify(b.get(k))}`);
  }
}

console.log('store golden');
compare('store-pure.json', normaliser()(pure()));
compare('store-file.json', await fileBackend());
const pgUrl = process.env.BOARD_SELFTEST_DATABASE_URL;
if (pgUrl) {
  compare('store-pg.json', await pgBackend(pgUrl));
} else {
  console.log('  skip  store-pg.json: BOARD_SELFTEST_DATABASE_URL is not set');
}
console.log(failures ? `\nstore golden: ${failures} failed` : '\nstore golden: all match');
process.exit(failures ? 1 : 0);
