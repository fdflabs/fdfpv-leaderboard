/*
 * events-check.js: Flight Club's weekly event, its rules (src/events.js)
 * and its two routes on the real server over a file store.
 *
 *   node tests/events-check.js
 *
 * The weeks are ISO weeks in UTC; the pick is stable inside a week and
 * moves at the boundary; a lap outside the week is not in its standings;
 * each pilot counts once, at their best, on the board the medals were set
 * on; tiers are absolute; the stored pick does not move when a course is
 * removed; no pilot key is served in the standings.
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

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  eventFrom, medalFor, medalsOf, pickCourse, publicRow, standings, tierOf, weekOf,
} from '../src/events.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) {
    failed += 1;
  }
}

/* ---- the rules ---- */
const at = (iso) => Date.parse(iso);
check('a Wednesday is in its ISO week', weekOf(at('2026-10-07T12:00:00Z')).week === '2026-w41');
check('the week starts Monday 00:00 UTC', weekOf(at('2026-10-07T12:00:00Z')).startsUtc === '2026-10-05T00:00:00.000Z');
check('Sunday 23:59 is the same week, Monday 00:00 the next',
  weekOf(at('2026-10-11T23:59:59Z')).week === '2026-w41' && weekOf(at('2026-10-12T00:00:00Z')).week === '2026-w42');
check('ISO years at their edges', weekOf(at('2024-12-30T00:00:00Z')).week === '2025-w01' && weekOf(at('2027-01-03T12:00:00Z')).week === '2026-w53');
check('medal thresholds match the simulator (1.15, 1.35, rounded up)',
  medalFor(40000, 40000) === 'gold' && medalFor(40000, 46000) === 'silver' && medalFor(40000, 46001) === 'bronze' && medalFor(40000, 54001) === null);
check('medals read off a document', medalsOf({ medals: { goldMs: 5 } }).goldMs === 5 && medalsOf({ medals: { goldMs: -1 } }) === null && medalsOf({}) === null);
const C = [{ id: 'trk-bbbbbbbb', medals: { goldMs: 1 } }, { id: 'trk-aaaaaaaa', medals: { goldMs: 1 } }, { id: 'trk-cccccccc', medals: null }];
check('the pick rotates over courses with medals, sorted by id', pickCourse(C, 10).id === 'trk-aaaaaaaa' && pickCourse(C, 11).id === 'trk-bbbbbbbb');
check('no course with medals, no event', pickCourse([C[2]], 3) === null);
const w = weekOf(at('2026-10-07T12:00:00Z'));
const E = eventFrom(w, { id: 'trk-aaaaaaaa', name: 'Ring', map: 'swiss2', medals: { goldMs: 40000 } });
check('an event id the economy accepts', /^[a-z0-9-]{1,40}$/.test(E.id) && E.id === '2026-w41-trk-aaaaaaaa', E.id);
const K1 = 'A'.repeat(87) + '=';
const K2 = 'B'.repeat(87) + '=';
const T = [
  { name: 'Ada', key: K1, lapMs: 50000, postedUtc: '2026-10-06T10:00:00.000Z', craft: null },
  { name: 'Ada', key: K1, lapMs: 45000, postedUtc: '2026-10-07T10:00:00.000Z', craft: null },
  { name: 'Ada', key: K1, lapMs: 30000, postedUtc: '2026-10-04T23:59:59.000Z', craft: null },
  { name: 'Ada', key: K1, lapMs: 30000, postedUtc: '2026-10-12T00:00:00.000Z', craft: null },
  { name: 'Bo', key: K2, lapMs: 39000, postedUtc: '2026-10-08T10:00:00.000Z', craft: null },
  { name: 'Bo', key: K2, lapMs: 20000, postedUtc: '2026-10-08T11:00:00.000Z', craft: 'cub1400' },
  { name: 'Cy', key: null, lapMs: 60000, postedUtc: '2026-10-09T10:00:00.000Z', craft: null },
];
const S = standings(E, T);
check('each pilot once, at their best in the week, fastest first',
  JSON.stringify(S.map((r) => [r.name, r.lapMs])) === JSON.stringify([['Bo', 39000], ['Ada', 45000], ['Cy', 60000]]), JSON.stringify(S));
check('laps a second either side of the week do not count', !S.some((r) => r.lapMs === 30000));
check('a plane lap is not on a quad event', !S.some((r) => r.lapMs === 20000));
check('each row has its medal', S[0].medal === 'gold' && S[1].medal === 'silver' && S[2].medal === null);
check('tiers: gold, silver, and none without a lap', tierOf(E, T, K2) === 'gold' && tierOf(E, T, K1) === 'silver' && tierOf(E, T, 'C'.repeat(87) + '=') === null);
check('a lap slower than bronze is a finish', tierOf({ ...E, goldMs: 10000 }, T, K1) === 'finish');
check('a public row has no key', !('key' in publicRow(S[0])));

/* ---- the routes, over a file store ---- */
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'board-events-'));
const now = Date.now();
const week = weekOf(now);
const inWeek = new Date(Date.parse(week.startsUtc) + 1000).toISOString();
const before = new Date(Date.parse(week.startsUtc) - 1000).toISOString();
const doc = (id, medals) => ({
  schemaVersion: 4, id, name: id, map: 'swiss2', field: {}, elements: [], sequence: [], ...(medals ? { medals } : {}),
});
const track = (id, medals) => ({
  id, name: `Course ${id.slice(-1)}`, author: 'Ada', document: doc(id, medals), plan: {}, gates: 0, elements: 0, hasLogo: false,
  publishedUtc: inWeek, updatedUtc: inWeek, tags: [],
});
const ids = ['trk-00000001', 'trk-00000002', 'trk-00000003'];
const expected = [ids[0], ids[2]][week.index % 2];
writeFileSync(join(dir, 'board.json'), JSON.stringify({
  tracks: { [ids[0]]: track(ids[0], { goldMs: 40000 }), [ids[1]]: track(ids[1], null), [ids[2]]: track(ids[2], { goldMs: 40000 }) },
  times: Object.fromEntries([ids[0], ids[2]].map((id) => [id, [
    { id: `tm-${id.slice(-1)}a`, name: 'Ada', key: K1, lapMs: 41000, postedUtc: inWeek, craft: null },
    { id: `tm-${id.slice(-1)}b`, name: 'Ada', key: K1, lapMs: 1000, postedUtc: before, craft: null },
  ]])),
}));
const server = spawn(process.execPath, [join(root, 'src', 'server.js')], {
  cwd: root, env: { ...process.env, PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_FILE: join(dir, 'board.json'), DATABASE_URL: '' }, stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100 && !(await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const first = await get('/api/events/current');
  const ev = first.body.event;
  check(`the week's course is the rotation's pick (${expected})`, ev && ev.trackId === expected && ev.week === week.week, JSON.stringify(ev));
  check('with its window and gold', ev && ev.startsUtc === week.startsUtc && ev.endsUtc === week.endsUtc && ev.goldMs === 40000 && ev.wing === false);
  check('standings: the lap in the week, its medal, no key',
    ev && ev.standings.length === 1 && ev.standings[0].lapMs === 41000 && ev.standings[0].medal === 'silver' && !('key' in ev.standings[0]), JSON.stringify(ev && ev.standings));
  const again = await get('/api/events/current');
  check('asked again, the same event', again.body.event.id === ev.id);
  const tiers = await get(`/api/events/tiers?key=${encodeURIComponent(K1)}`);
  check('the tiers route pays silver for that lap', JSON.stringify(tiers.body.tiers) === JSON.stringify([{ id: ev.id, tier: 'silver' }]), JSON.stringify(tiers.body));
  const none = await get(`/api/events/tiers?key=${encodeURIComponent(K2)}`);
  check('a key with no lap has no tiers', none.status === 200 && none.body.tiers.length === 0);
  const bad = await get('/api/events/tiers?key=nope');
  check('an unusable key is refused', bad.status === 400 && /pilot key/.test(bad.body.error));
  const list = await get('/api/tracks');
  const listed = list.body.tracks.find((t) => t.id === ids[0]);
  check('the listing carries a course\'s medals, and none where it has none',
    listed.medals.goldMs === 40000 && !('medals' in list.body.tracks.find((t) => t.id === ids[1])));
} finally {
  server.kill();
}

/* The stored pick outlives its course. */
const port2 = port;
const raw = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'board.json'), 'utf8'));
delete raw.tracks[expected];
writeFileSync(join(dir, 'board.json'), JSON.stringify(raw));
const server2 = spawn(process.execPath, [join(root, 'src', 'server.js')], {
  cwd: root, env: { ...process.env, PORT: String(port2), BOARD_HOST: '127.0.0.1', BOARD_FILE: join(dir, 'board.json'), DATABASE_URL: '' }, stdio: 'ignore',
});
try {
  for (let i = 0; i < 100 && !(await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const kept = await fetch(`${base}/api/events/current`).then((r) => r.json());
  check('a course removed mid-week leaves the week\'s event where it was', kept.event && kept.event.trackId === expected, JSON.stringify(kept));
} finally {
  server2.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `${failed} FAILED` : 'events check: all passed');
process.exit(failed ? 1 : 0);
