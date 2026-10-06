/*
 * store.js: where the board keeps tracks, times, runs, tickets and counters.
 *
 * Two backends behind one set of methods: Postgres when DATABASE_URL is
 * set, a JSON file when it is not, so a checkout needs nothing installed
 * and the server never asks which one is live. Both are contracts with
 * data already written: board.json is read back by every later version of
 * this file, and the Postgres tables (schema.sql, additive migrations
 * only) hold the live board. Every answer has one shape whichever backend
 * gave it; tests/store-golden.js holds the two to each other.
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
import { randomBytes } from 'node:crypto';
import {
  mkdir, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planesFor } from '../vendor/fdfpv/src/game/verify.js';
import {
  creditOf, hashEditKey, mapOf, planFromDocument, trackClassOf, STATS_COUNTRY_UNKNOWN,
} from './validate.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const stamp = () => new Date().toISOString();

/* Public handles: a prefix and four random bytes. The file store has no
 * serial, and Postgres's serials are a storage detail the API never shows. */
const mintId = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;

/* ================================================================== */
/* One shape for every answer                                          */
/* ================================================================== */

/*
 * Fastest lap first, earlier post first on a tie. The same rule is the
 * ORDER BY in PgStore.getTrack and listTracks and the rank query in
 * PgStore.addTime; they must all agree or a lap is ranked one way in a
 * list and another in the confirmation its pilot sees.
 */
function fastestFirst(a, b) {
  return a.lapMs - b.lapMs || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* Highest score first, earlier post first, so a tie does not take a place
 * from the pilot who got there first. Its SQL twins are PgStore.listRuns
 * and the runs_map_score index. */
function highestFirst(a, b) {
  return b.score - a.score || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* A map track has two boards: a time naming a plane is on the plane
 * board, every other time on the track's own. Ranks, counts and records
 * are per board, so a plane never outranks a quad. */
const onPlaneBoard = (time) => Boolean(time.craft);

const record = (best) => (best ? { name: best.name, lapMs: best.lapMs } : null);

/*
 * A time in a list. The ghost itself never travels with a list, only
 * whether there is one, or a sheet with forty laps would weigh megabytes.
 * Rows from before public ids read with a null id, which is true: they
 * cannot be fetched. Rows from before three lap totals read null, not
 * undefined, so the page prints nothing rather than the word.
 */
function timeInList(row) {
  return {
    id: row.id || null,
    name: row.name,
    lapMs: row.lapMs,
    threeMs: row.threeMs ?? null,
    postedUtc: row.postedUtc,
    hasGhost: Boolean(row.ghost),
    craft: row.craft || null,
  };
}

/* The plane board of a map track: which fixed wings fit every gate (the
 * simulator's own planesFor, vendored like the lap check so the list and
 * the check that refuses a plane can never disagree), and the board's count
 * and record. A field track has none. Read off the document every time. */
export function planeBoardOf(document, times, best) {
  if (!mapOf(document)) {
    return { planes: [], wing: null };
  }
  return { planes: planesFor(document), wing: { times, best: record(best) } };
}

/* Re-derived from the document on every read, so a drawing fix reaches
 * every card without anybody republishing. */
function currentPlan(track) {
  if (track?.document) {
    return planFromDocument(track.document);
  }
  return track?.plan || { width: 60, depth: 40, marks: [], path: [] };
}

const tagList = (tags) => (Array.isArray(tags) ? tags : []);

/*
 * A track as the API lists it, from the file store's record and its
 * times. Whether there is an animation, never the animation: the card
 * fetches the picture by its own address, and gifUtc rides along so a
 * replaced animation is not served from yesterday's cache.
 */
export function summaryOf(track, times) {
  const quads = times.filter((t) => !onPlaneBoard(t)).sort(fastestFirst);
  const planes = times.filter(onPlaneBoard).sort(fastestFirst);
  return {
    id: track.id,
    name: track.name,
    author: track.author,
    gates: track.gates,
    elements: track.elements,
    hasLogo: track.hasLogo,
    trackClass: trackClassOf(track.document),
    map: mapOf(track.document),
    ...planeBoardOf(track.document, planes.length, planes[0]),
    ...creditOf(track.document),
    plan: currentPlan(track),
    publishedUtc: track.publishedUtc,
    updatedUtc: track.updatedUtc,
    times: quads.length,
    best: record(quads[0]),
    tags: tagList(track.tags),
    hasGif: Boolean(track.gif),
    gifUtc: track.gifUtc || null,
  };
}

/*
 * The same listing from a Postgres row: one contract, two writers, so a
 * field added to one is added to the other (`best` and the credit were
 * each forgotten here once). The plane board is empty until listTracks or
 * getTrack lays its counts over it. The stored `plan` column is written
 * and never read back; the plan is always re-derived.
 */
export function rowToSummary(row) {
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    gates: row.gates,
    elements: row.elements,
    hasLogo: row.has_logo,
    trackClass: trackClassOf(row.document),
    map: mapOf(row.document),
    ...planeBoardOf(row.document, 0, null),
    ...creditOf(row.document),
    plan: planFromDocument(row.document),
    publishedUtc: row.published_utc,
    updatedUtc: row.updated_utc,
    tags: tagList(row.tags),
    hasGif: Boolean(row.has_gif),
    gifUtc: row.gif_utc || null,
  };
}

/* A freestyle run as the API shows it: what the arcade board prints. */
function runOut(run) {
  return {
    id: run.id || null,
    name: run.name,
    map: run.map,
    style: run.style,
    score: run.score,
    durationMs: run.durationMs,
    tricks: run.tricks,
    unique: run.unique,
    bestCombo: run.bestCombo,
    bestTrick: run.bestTrick,
    crashes: run.crashes,
    signature: run.signature || '',
    postedUtc: run.postedUtc,
  };
}

function runFromRow(row) {
  return runOut({
    id: row.public_id,
    name: row.name,
    map: row.map,
    style: row.style,
    score: row.score,
    durationMs: row.duration_ms,
    tricks: row.tricks,
    unique: row.unique_tricks,
    bestCombo: row.best_combo,
    bestTrick: row.best_trick,
    crashes: row.crashes,
    signature: row.signature,
    postedUtc: row.posted_utc,
  });
}

const contextOf = (row) => (row.context && typeof row.context === 'object' ? row.context : {});

function ticketLine(row) {
  const context = contextOf(row);
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    title: row.title,
    reporter: row.reporter,
    map: context.map ? String(context.map) : '',
    submittedUtc: row.submittedUtc,
    updatedUtc: row.updatedUtc,
  };
}

/* A whole ticket. Screenshots are listed by number (from one, as the form
 * labels them), type and size; the bytes are fetched one at a time behind
 * the same gate as the ticket. */
function ticketOut(row) {
  return {
    ...ticketLine(row),
    what: row.what,
    expected: row.expected || '',
    steps: row.steps || '',
    context: contextOf(row),
    resolution: row.resolution || '',
    images: (row.images || []).map((img, i) => ({ n: i + 1, type: img.type, size: img.size })),
  };
}

const TICKETS_DEFAULT = 80;
const TICKETS_MAX = 200;

function ticketLimit(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), TICKETS_MAX) : TICKETS_DEFAULT;
}

/* The refusals the stores share, worded once. A key that does not open a
 * track is a 403 for an animation (nothing to collide with, nothing to do
 * instead) and a 409 for a publish (a copy under a new name is the way
 * out). */
const NOT_YOURS = {
  error: 'That track was published from another browser, so this one cannot change its animation.',
  status: 403,
};
const CONFLICT = {
  error: 'This track is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.',
  status: 409,
  conflict: true,
};
const NO_TRACK = { error: 'That track is not on the board.', status: 404 };
const NO_TICKET = { error: 'That ticket is not on the board.', status: 404 };
const NAME_TAKEN = { error: 'That name belongs to another pilot. Pick another name, or import their pilot key.', status: 403 };

const opens = (editKey, hash) => Boolean(editKey) && hashEditKey(editKey) === hash;

/* ================================================================== */
/* Statistics: counters, never events                                  */
/* ================================================================== */

/*
 * Both stores hold the same two tables, a total per UTC day and a total
 * per day per dimension value, and nothing finer: no row can answer a
 * question about one browser. The arithmetic of an event and the shape of
 * the answer live here once; each backend only stores and sums.
 */
export function emptyStatsDay(day) {
  return {
    day, visits: 0, newVisitors: 0, returningVisitors: 0, sessions: 0, laps: 0, flightS: 0, crashes: 0,
  };
}

/* The window's days, oldest first, ending today, stepped in whole UTC days
 * from UTC midnight so no daylight saving change can skip or repeat one. */
export function statsDayKeys(now, count) {
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const DAY_MS = 86_400_000;
  return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/*
 * What one event adds: to its day, and to each dimension it names. A
 * flush with no laps is the "flying now" heartbeat; it adds flight time to
 * the day and touches no dimension, so that table grows with flying, not
 * with minutes spent idling on the line.
 */
function countsFor(event, country) {
  const day = emptyStatsDay(undefined);
  const dims = [];
  const add = (field, n, names) => {
    for (const [dim, key] of names) {
      dims.push({
        dim, key, visits: 0, sessions: 0, laps: 0, [field]: n,
      });
    }
  };
  if (event.kind === 'visit') {
    day.visits = 1;
    day[event.returning ? 'returningVisitors' : 'newVisitors'] = 1;
    add('visits', 1, [['surface', event.surface], ['country', country], ['source', event.source]]);
  } else if (event.kind === 'session') {
    day.sessions = 1;
    add('sessions', 1, [['craft', event.craft], ['map', event.map], ['input', event.input], ['country', country], ['source', event.source]]);
  } else {
    day.laps = event.laps;
    day.flightS = event.flightS;
    day.crashes = event.crashes;
    if (event.laps > 0) {
      add('laps', event.laps, [['craft', event.craft], ['map', event.map], ['country', country], ['source', event.source]]);
    }
  }
  return { day, dims };
}

const DAY_FIELDS = ['visits', 'newVisitors', 'returningVisitors', 'sessions', 'laps', 'flightS', 'crashes'];

/*
 * A dimension ranked by sessions, then visits, then laps, then key, so a
 * young board full of ties still orders the same way twice. ZZ goes last
 * and unranked: "unknown" is the rows the edge could not name, not a place
 * that came third.
 */
function rankDimRows(a, b) {
  const unknownA = a.key === STATS_COUNTRY_UNKNOWN;
  const unknownB = b.key === STATS_COUNTRY_UNKNOWN;
  if (unknownA !== unknownB) {
    return unknownA ? 1 : -1;
  }
  return (b.sessions - a.sessions) || (b.visits - a.visits) || (b.laps - a.laps)
    || String(a.key).localeCompare(String(b.key));
}

/*
 * GET /api/stats's answer, from rows either backend produces. `dayRows`
 * maps a day to its row and a quiet day is simply absent, zero filled
 * here so the chart always has one bar per day. `dimRows` are already
 * summed over the window.
 */
export function shapeStats({
  now, days, dayRows, dimRows, allTime, firstDay, countriesAllTime,
}) {
  const series = statsDayKeys(now, days).map((day) => dayRows.get(day) || emptyStatsDay(day));
  const window = { days, countries: 0 };
  for (const field of DAY_FIELDS) {
    window[field] = series.reduce((sum, row) => sum + row[field], 0);
  }
  const dimension = (name) => dimRows.filter((row) => row.dim === name).sort(rankDimRows);
  const countries = dimension('country');
  window.countries = countries.filter((row) => row.key !== STATS_COUNTRY_UNKNOWN).length;
  return {
    generatedUtc: new Date(now).toISOString(),
    firstDay: firstDay || null,
    today: series[series.length - 1],
    days: series,
    window,
    allTime: { ...allTime, countries: countriesAllTime },
    countries,
    sources: dimension('source'),
    craft: dimension('craft'),
    maps: dimension('map'),
    inputs: dimension('input'),
    surfaces: dimension('surface'),
  };
}

/* ================================================================== */
/* The JSON file                                                        */
/* ================================================================== */

/*
 * board.json, as written: { tracks: {id: track}, times: {trackId: [time]},
 * bugs: {id: ticket}, runs: [run], stats: { days: {day: row}, dims:
 * {"day|dim|key": row} }, pilots: {lowercased name: claim} }. Binary
 * (animations, screenshots) is base64, since JSON cannot hold bytes and a
 * second file would have to be kept in step. `data` is read by the
 * selftest directly, so its layout is part of the contract too.
 */
function freshBoard() {
  return {
    tracks: {}, times: {}, bugs: {}, runs: [], stats: { days: {}, dims: {} }, pilots: {},
  };
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* A board.json from before tickets, runs, pilots or statistics existed is
 * old, not corrupt: the missing parts are filled in rather than the file
 * being treated as damaged, which would blank a developer's board. */
function upgrade(board) {
  if (!isMap(board.bugs)) {
    board.bugs = {};
  }
  if (!Array.isArray(board.runs)) {
    board.runs = [];
  }
  if (!isMap(board.pilots)) {
    board.pilots = {};
  }
  if (!isMap(board.stats)) {
    board.stats = { days: {}, dims: {} };
  }
  for (const part of ['days', 'dims']) {
    if (!isMap(board.stats[part])) {
      board.stats[part] = {};
    }
  }
  return board;
}

/* Write beside, then rename over, so a crash mid-write leaves the old
 * file whole. Windows refuses to rename onto an existing file, hence the
 * second attempt after removing it. */
async function replaceFile(path, text) {
  const beside = `${path}.${process.pid}.tmp`;
  await writeFile(beside, text, 'utf8');
  try {
    await rename(beside, path);
  } catch {
    await unlink(path).catch(() => {});
    await rename(beside, path);
  }
}

/* An id with a given prefix that `taken` does not already hold. */
function freshId(prefix, taken) {
  let id = mintId(prefix);
  while (taken(id)) {
    id = mintId(prefix);
  }
  return id;
}

class FileStore {
  constructor(path) {
    this.path = path;
    this.data = freshBoard();
    /* Writes run one at a time, in arrival order: each is a read, a change
     * and a whole-file write, and two interleaved would lose one. */
    this.queue = Promise.resolve();
  }

  serially(task) {
    const turn = this.queue.then(task, task);
    this.queue = turn.catch(() => {});
    return turn;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('board.json could not be read; starting empty in memory and leaving the file alone.', err);
        return;
      }
      await this.save();
      return;
    }
    let board;
    try {
      board = JSON.parse(text);
    } catch (err) {
      console.error('board.json could not be read; starting empty in memory and leaving the file alone.', err);
      return;
    }
    if (!board?.tracks || !board.times) {
      console.error('board.json is missing tracks or times; starting empty in memory and leaving the file alone.');
      return;
    }
    this.data = upgrade(board);
  }

  save() {
    return replaceFile(this.path, JSON.stringify(this.data));
  }

  timesOf(trackId) {
    return this.data.times[trackId] || [];
  }

  /* ---- tracks ---- */

  async listTracks() {
    return Object.values(this.data.tracks)
      .map((track) => summaryOf(track, this.timesOf(track.id)))
      .sort((a, b) => String(b.updatedUtc).localeCompare(String(a.updatedUtc)));
  }

  async getTrack(id) {
    const track = this.data.tracks[id];
    if (!track) {
      return null;
    }
    const times = [...this.timesOf(id)].sort(fastestFirst);
    return { ...summaryOf(track, times), times: times.map(timeInList) };
  }

  async getDocument(id) {
    const track = this.data.tracks[id];
    return track ? { id: track.id, name: track.name, author: track.author, document: track.document } : null;
  }

  /*
   * A new track gets an edit key, kept by the browser that published it;
   * only that key republishes. A republish that moves the layout clears
   * the times, which were flown on a track that no longer exists, and the
   * animation, which is a picture of it. One that only renames, retags or
   * changes author keeps both, and a new author's own times follow the
   * new name.
   */
  publish({ inspected, author, editKey, tags = [] }) {
    return this.serially(async () => {
      const before = this.data.tracks[inspected.id];
      if (before && !opens(editKey, before.editKeyHash)) {
        return { ...CONFLICT };
      }
      const sameLayout = Boolean(before) && before.layoutHash === inspected.layoutHash;
      if (before && !sameLayout) {
        this.data.times[inspected.id] = [];
      } else if (before && before.author !== author) {
        for (const time of this.timesOf(inspected.id)) {
          if (time.name === before.author) {
            time.name = author;
          }
        }
      }
      const key = before ? editKey : randomBytes(16).toString('hex');
      this.data.tracks[inspected.id] = {
        id: inspected.id,
        name: inspected.name,
        author,
        document: inspected.document,
        plan: inspected.plan,
        layoutHash: inspected.layoutHash,
        editKeyHash: hashEditKey(key),
        hasLogo: inspected.hasLogo,
        gates: inspected.gates,
        elements: inspected.elements,
        tags,
        gif: sameLayout ? before.gif || null : null,
        gifUtc: sameLayout ? before.gifUtc || null : null,
        publishedUtc: before ? before.publishedUtc : stamp(),
        updatedUtc: stamp(),
      };
      this.data.times[inspected.id] ??= [];
      await this.save();
      return {
        id: inspected.id,
        name: inspected.name,
        author,
        editKey: before ? undefined : key,
        updated: Boolean(before),
        timesCleared: Boolean(before) && !sameLayout,
      };
    });
  }

  /* The key is checked here, where its hash lives; `admin` is the one way
   * past it, and the route decides who has earned that. */
  setGif({ id, bytes, editKey = '', admin = false }) {
    return this.serially(async () => {
      const track = this.data.tracks[id];
      if (!track) {
        return null;
      }
      if (!admin && !opens(editKey, track.editKeyHash)) {
        return { ...NOT_YOURS };
      }
      track.gif = Buffer.from(bytes).toString('base64');
      track.gifUtc = stamp();
      await this.save();
      return { id, gifUtc: track.gifUtc };
    });
  }

  async getGif(id) {
    const track = this.data.tracks[id];
    return track?.gif ? { bytes: Buffer.from(track.gif, 'base64'), gifUtc: track.gifUtc || null } : null;
  }

  /*
   * Taking a track down, the one destructive write, and admin only: an
   * edit key is enough to change a layout but not to throw away records
   * other pilots flew. The times go with the track (in Postgres by ON
   * DELETE CASCADE); runs are scored on maps, not tracks, and stay.
   */
  removeTrack(id) {
    return this.serially(async () => {
      const track = this.data.tracks[id];
      if (!track) {
        return null;
      }
      const times = this.timesOf(id).length;
      delete this.data.tracks[id];
      delete this.data.times[id];
      await this.save();
      return { id, name: track.name, author: track.author, times };
    });
  }

  /* ---- times, names and keys ---- */

  addTime({ trackId, name, lapMs, threeMs, ghost, key, craft }) {
    return this.serially(async () => {
      if (!this.data.tracks[trackId]) {
        return { ...NO_TRACK };
      }
      const taken = (id) => Object.values(this.data.times).some((list) => list.some((t) => t.id === id));
      const time = {
        id: freshId('tm', taken),
        name,
        lapMs,
        threeMs: threeMs ?? null,
        ghost: ghost || null,
        key: key || null,
        postedUtc: stamp(),
        craft: craft || null,
      };
      const list = this.timesOf(trackId);
      list.push(time);
      this.data.times[trackId] = list;
      await this.save();
      const board = list.filter((t) => onPlaneBoard(t) === onPlaneBoard(time)).sort(fastestFirst);
      return {
        id: time.id,
        name,
        lapMs,
        threeMs: time.threeMs,
        postedUtc: time.postedUtc,
        rank: board.indexOf(time) + 1,
        times: board.length,
        craft: time.craft,
      };
    });
  }

  async getGhost(trackId, timeId) {
    const time = this.timesOf(trackId).find((t) => t.id === timeId);
    return time ? { id: time.id, name: time.name, lapMs: time.lapMs, ghost: time.ghost || null } : null;
  }

  /*
   * A name belongs to the first pilot key that posts it, compared without
   * case. The same key again changes nothing; another key is refused.
   * Nothing here frees a name.
   */
  claimName(name, key) {
    return this.serially(async () => {
      const lower = String(name).trim().toLowerCase();
      const held = this.data.pilots[lower];
      if (held) {
        return held.key === key ? { claimed: false } : { ...NAME_TAKEN };
      }
      this.data.pilots[lower] = { name, key, claimedUtc: stamp() };
      await this.save();
      return { claimed: true };
    });
  }

  /* Hand every name and time of one key to another (src/pilotkeys.js says
   * when that is allowed); answers how many of each moved. */
  moveKey(from, to) {
    return this.serially(async () => {
      const claims = Object.values(this.data.pilots).filter((claim) => claim.key === from);
      const times = Object.values(this.data.times).flat().filter((time) => time.key === from);
      for (const owned of [...claims, ...times]) {
        owned.key = to;
      }
      if (claims.length + times.length > 0) {
        await this.save();
      }
      return { names: claims.length, times: times.length };
    });
  }

  /* ---- freestyle runs ---- */

  async listRuns({ map } = {}) {
    return this.data.runs.filter((run) => !map || run.map === map).sort(highestFirst).map(runOut);
  }

  /*
   * One run per pilot per map (pilot compared without case), replaced only
   * by a better one. A leaderboard says who is good, not who pressed the
   * button most: keeping every run would let one pilot fill the table and
   * would let this unowned endpoint fill the disk. Postgres keeps the same
   * rule with the runs_pilot_map index.
   */
  addRun(run) {
    return this.serially(async () => {
      const runs = this.data.runs;
      const pilot = run.name.toLowerCase();
      const held = runs.find((r) => r.map === run.map && r.name.toLowerCase() === pilot);
      const improved = !held || held.score < run.score;
      let standing = held;
      if (improved) {
        standing = { ...run, id: freshId('run', (id) => runs.some((r) => r.id === id)), postedUtc: stamp() };
        if (held) {
          runs[runs.indexOf(held)] = standing;
        } else {
          runs.push(standing);
        }
        await this.save();
      }
      const board = runs.filter((r) => r.map === run.map).sort(highestFirst);
      return { ...runOut(standing), rank: board.indexOf(standing) + 1, runs: board.length, improved };
    });
  }

  /* ---- bug tickets ---- */

  async listBugs({ status, kind, limit } = {}) {
    return Object.values(this.data.bugs)
      .filter((row) => (!status || row.status === status) && (!kind || row.kind === kind))
      .sort((a, b) => String(b.submittedUtc).localeCompare(String(a.submittedUtc)))
      .slice(0, ticketLimit(limit))
      .map(ticketLine);
  }

  async getBug(id) {
    const row = this.data.bugs[id];
    return row ? ticketOut(row) : null;
  }

  addBug(inspected) {
    return this.serially(async () => {
      const at = stamp();
      const row = {
        id: freshId('bug', (id) => Boolean(this.data.bugs[id])),
        status: 'open',
        kind: inspected.kind,
        title: inspected.title,
        what: inspected.what,
        expected: inspected.expected,
        steps: inspected.steps,
        reporter: inspected.reporter,
        context: inspected.context || {},
        images: (inspected.images || []).map((img) => ({
          type: img.type, size: img.bytes.length, data: Buffer.from(img.bytes).toString('base64'),
        })),
        resolution: '',
        submittedUtc: at,
        updatedUtc: at,
      };
      this.data.bugs[row.id] = row;
      await this.save();
      return ticketOut(row);
    });
  }

  async getBugImage(id, n) {
    const shots = this.data.bugs[id]?.images;
    const shot = Array.isArray(shots) ? shots[n - 1] : null;
    return shot ? { type: shot.type, bytes: Buffer.from(shot.data, 'base64') } : null;
  }

  updateBug(id, patch) {
    return this.serially(async () => {
      const row = this.data.bugs[id];
      if (!row) {
        return { ...NO_TICKET };
      }
      if (patch.status) {
        row.status = patch.status;
      }
      if (patch.resolution != null) {
        row.resolution = patch.resolution;
      }
      row.updatedUtc = stamp();
      await this.save();
      return ticketOut(row);
    });
  }

  /* ---- statistics ---- */

  /* `event` has been through inspectStatsEvent already; a flush's tab
   * handle is the server's business and never reaches here. */
  recordStats(event, { day, country }) {
    return this.serially(async () => {
      const { days, dims } = this.data.stats;
      const counts = countsFor(event, country);
      days[day] ??= emptyStatsDay(day);
      /* Only the fields this event moves are touched, as they always were,
       * so a day row written before a field existed is not turned to NaN. */
      for (const field of DAY_FIELDS.filter((f) => counts.day[f] !== 0)) {
        days[day][field] += counts.day[field];
      }
      for (const add of counts.dims) {
        const row = (dims[`${day}|${add.dim}|${add.key}`] ??= {
          day, dim: add.dim, key: add.key, visits: 0, sessions: 0, laps: 0,
        });
        row.visits += add.visits;
        row.sessions += add.sessions;
        row.laps += add.laps;
      }
      await this.save();
    });
  }

  async readStats({ days = 30, now = Date.now() } = {}) {
    const { days: byDay, dims } = this.data.stats;
    const inWindow = new Set(statsDayKeys(now, days));
    const dayRows = new Map(Object.entries(byDay).filter(([day]) => inWindow.has(day)).map(([day, row]) => [day, { ...row }]));
    const summed = new Map();
    for (const row of Object.values(dims)) {
      if (!inWindow.has(row.day)) {
        continue;
      }
      const total = summed.get(`${row.dim}|${row.key}`) ?? {
        dim: row.dim, key: row.key, visits: 0, sessions: 0, laps: 0,
      };
      total.visits += row.visits;
      total.sessions += row.sessions;
      total.laps += row.laps;
      summed.set(`${row.dim}|${row.key}`, total);
    }
    const allTime = { visits: 0, sessions: 0, laps: 0, flightS: 0, crashes: 0 };
    for (const row of Object.values(byDay)) {
      for (const field of Object.keys(allTime)) {
        allTime[field] += row[field];
      }
    }
    const named = new Set(Object.values(dims)
      .filter((row) => row.dim === 'country' && row.key !== STATS_COUNTRY_UNKNOWN)
      .map((row) => row.key));
    return shapeStats({
      now,
      days,
      dayRows,
      dimRows: [...summed.values()],
      allTime,
      firstDay: Object.keys(byDay).sort()[0] || null,
      countriesAllTime: named.size,
    });
  }

  /*
   * Four numbers the statistics page reads from the board itself rather
   * than from counters: tracks, times, distinct pilots (by name, without
   * case) and how many of them posted on more than one UTC day.
   */
  async boardFacts() {
    const daysByPilot = new Map();
    const all = Object.values(this.data.times).flat();
    for (const time of all) {
      const who = String(time.name || '').toLowerCase();
      if (!daysByPilot.has(who)) {
        daysByPilot.set(who, new Set());
      }
      daysByPilot.get(who).add(String(time.postedUtc || '').slice(0, 10));
    }
    return {
      tracks: Object.keys(this.data.tracks).length,
      times: all.length,
      pilots: daysByPilot.size,
      pilotsOnMoreThanOneDay: [...daysByPilot.values()].filter((d) => d.size > 1).length,
    };
  }
}

/* ================================================================== */
/* Postgres                                                            */
/* ================================================================== */

/* Every column a listing reads, by name so an animation never leaves the
 * database with a list; `has_gif` stands in for the bytes. */
const TRACK_COLUMNS = `id, name, author, document, plan, has_logo, gates, elements, tags,
  published_utc, updated_utc, gif_utc, (gif IS NOT NULL) AS has_gif`;

const TICKET_COLUMNS = `id, status, kind, title, what, expected, steps, reporter, context,
  resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"`;

const UNIQUE_VIOLATION = '23505';

/* Random public ids can land on a taken one. Six collisions in a row on
 * four random bytes is not luck but a broken random source, and throws. */
const ID_ATTEMPTS = 6;

class PgStore {
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async init() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    /* schema.sql is idempotent and only ever adds, so it runs on every
     * start and an older database catches up by itself. */
    await this.pool.query(await readFile(join(repoRoot, 'schema.sql'), 'utf8'));
  }

  /* Runs `work(client)` in a transaction. `work` may answer early with
   * { rollback: value } to undo and return value. */
  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await work(client);
      if (outcome && Object.hasOwn(outcome, 'rollback')) {
        await client.query('ROLLBACK');
        return outcome.rollback;
      }
      await client.query('COMMIT');
      return outcome;
    } catch (err) {
      /* The connection may already be gone; the original error is the one
       * worth propagating. */
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---- tracks ---- */

  async listTracks() {
    const [tracks, bests, counts] = await Promise.all([
      this.pool.query(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY updated_utc DESC`),
      this.pool.query(`
        SELECT DISTINCT ON (track_id, craft IS NOT NULL)
               track_id, craft IS NOT NULL AS plane, name, lap_ms
        FROM times
        ORDER BY track_id, craft IS NOT NULL, lap_ms, posted_utc`),
      this.pool.query(`
        SELECT track_id, craft IS NOT NULL AS plane, COUNT(*)::int AS n
        FROM times GROUP BY track_id, craft IS NOT NULL`),
    ]);
    const board = (row) => `${row.track_id}/${row.plane ? 'planes' : 'quads'}`;
    const best = new Map(bests.rows.map((row) => [board(row), { name: row.name, lapMs: row.lap_ms }]));
    const count = new Map(counts.rows.map((row) => [board(row), row.n]));
    return tracks.rows.map((row) => ({
      ...rowToSummary(row),
      times: count.get(`${row.id}/quads`) || 0,
      best: best.get(`${row.id}/quads`) || null,
      ...planeBoardOf(row.document, count.get(`${row.id}/planes`) || 0, best.get(`${row.id}/planes`)),
    }));
  }

  async getTrack(id) {
    const [found, times] = await Promise.all([
      this.pool.query(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = $1`, [id]),
      this.pool.query(`
        SELECT public_id AS id, name, lap_ms AS "lapMs", three_ms AS "threeMs", posted_utc AS "postedUtc",
               (ghost IS NOT NULL) AS "hasGhost", craft
        FROM times WHERE track_id = $1 ORDER BY lap_ms, posted_utc`, [id]),
    ]);
    if (found.rowCount === 0) {
      return null;
    }
    const row = found.rows[0];
    const planes = times.rows.filter(onPlaneBoard);
    return {
      ...rowToSummary(row),
      times: times.rows,
      best: record(times.rows.find((t) => !onPlaneBoard(t))),
      ...planeBoardOf(row.document, planes.length, planes[0]),
    };
  }

  async getDocument(id) {
    const found = await this.pool.query('SELECT id, name, author, document FROM tracks WHERE id = $1', [id]);
    return found.rows[0] || null;
  }

  /* FileStore.publish has the rules; this is them in SQL, under a row lock
   * so two republishes cannot interleave. */
  async publish({ inspected, author, editKey, tags = [] }) {
    try {
      return await this.transaction(async (db) => {
        const locked = await db.query('SELECT author, layout_hash, edit_key_hash FROM tracks WHERE id = $1 FOR UPDATE', [inspected.id]);
        const before = locked.rows[0];
        if (before && !opens(editKey, before.edit_key_hash)) {
          return { rollback: { ...CONFLICT } };
        }
        const fields = [
          inspected.id, inspected.name, author, inspected.document, inspected.plan, inspected.layoutHash,
          inspected.hasLogo, inspected.gates, inspected.elements, tags,
        ];
        if (!before) {
          const key = randomBytes(16).toString('hex');
          await db.query(`
            INSERT INTO tracks (id, name, author, document, plan, layout_hash, has_logo, gates, elements, tags,
                                edit_key_hash, published_utc, updated_utc)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`, [...fields, hashEditKey(key)]);
          return { id: inspected.id, name: inspected.name, author, editKey: key, updated: false, timesCleared: false };
        }
        const relaid = before.layout_hash !== inspected.layoutHash;
        if (relaid) {
          await db.query('DELETE FROM times WHERE track_id = $1', [inspected.id]);
        } else if (before.author !== author) {
          await db.query('UPDATE times SET name = $2 WHERE track_id = $1 AND name = $3', [inspected.id, author, before.author]);
        }
        await db.query(`
          UPDATE tracks SET name = $2, author = $3, document = $4, plan = $5, layout_hash = $6,
                 has_logo = $7, gates = $8, elements = $9, tags = $10, updated_utc = NOW(),
                 gif = CASE WHEN $11 THEN NULL ELSE gif END,
                 gif_utc = CASE WHEN $11 THEN NULL ELSE gif_utc END
          WHERE id = $1`, [...fields, relaid]);
        return { id: inspected.id, name: inspected.name, author, editKey: undefined, updated: true, timesCleared: relaid };
      });
    } catch (err) {
      /* Two first publishes of one id raced and the other won. */
      if (err.code === UNIQUE_VIOLATION) {
        return { ...CONFLICT };
      }
      throw err;
    }
  }

  async setGif({ id, bytes, editKey = '', admin = false }) {
    const found = await this.pool.query('SELECT edit_key_hash FROM tracks WHERE id = $1', [id]);
    if (found.rowCount === 0) {
      return null;
    }
    if (!admin && !opens(editKey, found.rows[0].edit_key_hash)) {
      return { ...NOT_YOURS };
    }
    const done = await this.pool.query('UPDATE tracks SET gif = $2, gif_utc = NOW() WHERE id = $1 RETURNING gif_utc', [id, Buffer.from(bytes)]);
    return done.rowCount ? { id, gifUtc: done.rows[0].gif_utc } : null;
  }

  async getGif(id) {
    const found = await this.pool.query('SELECT gif, gif_utc FROM tracks WHERE id = $1', [id]);
    const row = found.rows[0];
    return row?.gif ? { bytes: row.gif, gifUtc: row.gif_utc || null } : null;
  }

  /* See FileStore.removeTrack. The times go by ON DELETE CASCADE and are
   * counted first, in the same transaction, so the count is what went. */
  removeTrack(id) {
    return this.transaction(async (db) => {
      const found = await db.query(`
        SELECT name, author, (SELECT COUNT(*) FROM times WHERE track_id = $1) AS times
        FROM tracks WHERE id = $1`, [id]);
      if (found.rowCount === 0) {
        return { rollback: null };
      }
      await db.query('DELETE FROM tracks WHERE id = $1', [id]);
      const { name, author, times } = found.rows[0];
      return { id, name, author, times: Number(times) || 0 };
    });
  }

  /* ---- times, names and keys ---- */

  async addTime(time) {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      try {
        return await this.insertTime(time);
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION) {
          throw err;
        }
      }
    }
    throw new Error('Could not allocate a time id.');
  }

  insertTime({ trackId, name, lapMs, threeMs, ghost, key, craft }) {
    return this.transaction(async (db) => {
      const track = await db.query('SELECT id FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      if (track.rowCount === 0) {
        return { rollback: { ...NO_TRACK } };
      }
      const written = await db.query(`
        INSERT INTO times (track_id, public_id, name, lap_ms, three_ms, ghost, pilot_key, craft, posted_utc)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id, public_id, three_ms, posted_utc, craft`,
      [trackId, mintId('tm'), name, lapMs, threeMs ?? null, ghost || null, key || null, craft || null]);
      const row = written.rows[0];
      /*
       * Ranked against the stored row by its serial, inside Postgres:
       * posted_utc has microseconds and a JS Date only milliseconds, so
       * sending the timestamp back to compare with itself once made the
       * fastest lap on the board rank 0.
       */
      const standing = await db.query(`
        WITH mine AS (SELECT lap_ms, posted_utc, craft FROM times WHERE id = $2)
        SELECT COUNT(*) FILTER (WHERE t.lap_ms < mine.lap_ms
                                  OR (t.lap_ms = mine.lap_ms AND t.posted_utc <= mine.posted_utc))::int AS rank,
               COUNT(*)::int AS times
        FROM times t, mine
        WHERE t.track_id = $1 AND (t.craft IS NULL) = (mine.craft IS NULL)`, [trackId, row.id]);
      return {
        id: row.public_id,
        name,
        lapMs,
        threeMs: row.three_ms ?? null,
        postedUtc: row.posted_utc,
        rank: standing.rows[0].rank,
        times: standing.rows[0].times,
        craft: row.craft || null,
      };
    });
  }

  async getGhost(trackId, timeId) {
    const found = await this.pool.query(`
      SELECT public_id AS id, name, lap_ms AS "lapMs", ghost
      FROM times WHERE track_id = $1 AND public_id = $2`, [trackId, timeId]);
    return found.rows[0] || null;
  }

  async claimName(name, key) {
    const lower = String(name).trim().toLowerCase();
    const won = await this.pool.query(`
      INSERT INTO pilots (name_key, name, public_key, claimed_utc) VALUES ($1, $2, $3, NOW())
      ON CONFLICT (name_key) DO NOTHING`, [lower, name, key]);
    if (won.rowCount) {
      return { claimed: true };
    }
    const held = await this.pool.query('SELECT public_key FROM pilots WHERE name_key = $1', [lower]);
    return held.rows[0]?.public_key === key ? { claimed: false } : { ...NAME_TAKEN };
  }

  moveKey(from, to) {
    return this.transaction(async (db) => {
      const names = await db.query('UPDATE pilots SET public_key = $2 WHERE public_key = $1', [from, to]);
      const times = await db.query('UPDATE times SET pilot_key = $2 WHERE pilot_key = $1', [from, to]);
      return { names: names.rowCount, times: times.rowCount };
    });
  }

  /* ---- freestyle runs ---- */

  async listRuns({ map } = {}) {
    const found = await this.pool.query(`
      SELECT * FROM runs WHERE ($1::text IS NULL OR map = $1)
      ORDER BY score DESC, posted_utc ASC`, [map || null]);
    return found.rows.map(runFromRow);
  }

  /* FileStore.addRun's rule as one upsert on runs_pilot_map: the WHERE on
   * DO UPDATE makes it replace only a lower score, and an empty RETURNING
   * means the pilot's standing run stays. */
  async addRun(run) {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      try {
        return await this.upsertRun(run);
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION || err.constraint !== 'runs_public_id') {
          throw err;
        }
      }
    }
    throw new Error('Could not allocate a run id.');
  }

  async upsertRun(run) {
    const written = await this.pool.query(`
      INSERT INTO runs (public_id, name, map, style, score, duration_ms, tricks, unique_tricks,
                        best_combo, best_trick, crashes, signature, posted_utc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (map, lower(name)) DO UPDATE SET
        public_id = EXCLUDED.public_id, name = EXCLUDED.name, style = EXCLUDED.style,
        score = EXCLUDED.score, duration_ms = EXCLUDED.duration_ms, tricks = EXCLUDED.tricks,
        unique_tricks = EXCLUDED.unique_tricks, best_combo = EXCLUDED.best_combo,
        best_trick = EXCLUDED.best_trick, crashes = EXCLUDED.crashes,
        signature = EXCLUDED.signature, posted_utc = EXCLUDED.posted_utc
      WHERE runs.score < EXCLUDED.score
      RETURNING *`, [
      mintId('run'), run.name, run.map, run.style, run.score, run.durationMs, run.tricks,
      run.unique, run.bestCombo, run.bestTrick, run.crashes, run.signature,
    ]);
    const improved = written.rowCount > 0;
    const standing = improved
      ? written.rows[0]
      : (await this.pool.query('SELECT * FROM runs WHERE map = $1 AND lower(name) = lower($2)', [run.map, run.name])).rows[0];
    const place = await this.pool.query(`
      SELECT COUNT(*) FILTER (WHERE score > $2 OR (score = $2 AND posted_utc < $3))::int AS ahead,
             COUNT(*)::int AS runs
      FROM runs WHERE map = $1`, [run.map, standing.score, standing.posted_utc]);
    return {
      ...runFromRow(standing), rank: place.rows[0].ahead + 1, runs: place.rows[0].runs, improved,
    };
  }

  /* ---- bug tickets ---- */

  async listBugs({ status, kind, limit } = {}) {
    const found = await this.pool.query(`
      SELECT id, status, kind, title, reporter, context,
             submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
      FROM bugs
      WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)
      ORDER BY submitted_utc DESC
      LIMIT $3`, [status || null, kind || null, ticketLimit(limit)]);
    return found.rows.map(ticketLine);
  }

  /* A ticket's screenshots as { type, size } in order, from either the
   * pool or a transaction's client. */
  async shotsOf(db, id) {
    const found = await db.query('SELECT type, octet_length(bytes) AS size FROM bug_images WHERE bug_id = $1 ORDER BY n', [id]);
    return found.rows;
  }

  async getBug(id) {
    const found = await this.pool.query(`SELECT ${TICKET_COLUMNS} FROM bugs WHERE id = $1`, [id]);
    if (found.rowCount === 0) {
      return null;
    }
    return ticketOut({ ...found.rows[0], images: await this.shotsOf(this.pool, id) });
  }

  async getBugImage(id, n) {
    const found = await this.pool.query('SELECT type, bytes FROM bug_images WHERE bug_id = $1 AND n = $2', [id, n]);
    return found.rows[0] || null;
  }

  /* The ticket and its screenshots in one transaction: never a ticket
   * missing the pictures its reporter attached, never a picture without
   * its ticket. */
  async addBug(inspected) {
    const shots = inspected.images || [];
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      try {
        return await this.transaction(async (db) => {
          const id = mintId('bug');
          const written = await db.query(`
            INSERT INTO bugs (id, status, kind, title, what, expected, steps, reporter, context, resolution,
                              submitted_utc, updated_utc)
            VALUES ($1, 'open', $2, $3, $4, $5, $6, $7, $8, '', NOW(), NOW())
            RETURNING ${TICKET_COLUMNS}`, [
            id, inspected.kind, inspected.title, inspected.what, inspected.expected,
            inspected.steps, inspected.reporter, inspected.context || {},
          ]);
          for (let n = 1; n <= shots.length; n += 1) {
            await db.query('INSERT INTO bug_images (bug_id, n, type, bytes) VALUES ($1, $2, $3, $4)', [id, n, shots[n - 1].type, shots[n - 1].bytes]);
          }
          return ticketOut({ ...written.rows[0], images: shots.map((s) => ({ type: s.type, size: s.bytes.length })) });
        });
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION) {
          throw err;
        }
      }
    }
    throw new Error('Could not allocate a ticket id.');
  }

  updateBug(id, patch) {
    return this.transaction(async (db) => {
      const found = await db.query(`SELECT status, resolution FROM bugs WHERE id = $1 FOR UPDATE`, [id]);
      if (found.rowCount === 0) {
        return { rollback: { ...NO_TICKET } };
      }
      const before = found.rows[0];
      const updated = await db.query(`
        UPDATE bugs SET status = $2, resolution = $3, updated_utc = NOW()
        WHERE id = $1 RETURNING ${TICKET_COLUMNS}`, [
        id, patch.status || before.status, patch.resolution != null ? patch.resolution : before.resolution,
      ]);
      return ticketOut({ ...updated.rows[0], images: await this.shotsOf(db, id) });
    });
  }

  /* ---- statistics ---- */

  /*
   * Every write adds to a total in place (an upsert that sums), so two
   * instances or two requests at once cannot lose a count between a read
   * and a write: there is no read. One transaction, so a day and its
   * dimensions move together.
   */
  recordStats(event, { day, country }) {
    const counts = countsFor(event, country);
    return this.transaction(async (db) => {
      const d = counts.day;
      await db.query(`
        INSERT INTO stats_days (day, visits, new_visitors, returning_visitors, sessions, laps, flight_s, crashes)
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (day) DO UPDATE SET
          visits = stats_days.visits + EXCLUDED.visits,
          new_visitors = stats_days.new_visitors + EXCLUDED.new_visitors,
          returning_visitors = stats_days.returning_visitors + EXCLUDED.returning_visitors,
          sessions = stats_days.sessions + EXCLUDED.sessions,
          laps = stats_days.laps + EXCLUDED.laps,
          flight_s = stats_days.flight_s + EXCLUDED.flight_s,
          crashes = stats_days.crashes + EXCLUDED.crashes`,
      [day, d.visits, d.newVisitors, d.returningVisitors, d.sessions, d.laps, d.flightS, d.crashes]);
      for (const add of counts.dims) {
        await db.query(`
          INSERT INTO stats_dims (day, dim, key, visits, sessions, laps)
          VALUES ($1::date, $2, $3, $4, $5, $6)
          ON CONFLICT (day, dim, key) DO UPDATE SET
            visits = stats_dims.visits + EXCLUDED.visits,
            sessions = stats_dims.sessions + EXCLUDED.sessions,
            laps = stats_dims.laps + EXCLUDED.laps`,
        [day, add.dim, add.key, add.visits, add.sessions, add.laps]);
      }
    });
  }

  /*
   * Days are read as text with to_char: node-pg turns a DATE into a JS Date
   * at the process's local midnight, which behind UTC is the day before and
   * would shift every bar by one. BIGINT sums arrive as strings (they can
   * exceed what a double holds exactly) and are made numbers before they
   * are added to anything.
   */
  async readStats({ days = 30, now = Date.now() } = {}) {
    const from = statsDayKeys(now, days)[0];
    const [series, dims, totals, countries] = await Promise.all([
      this.pool.query(`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, visits, new_visitors AS "newVisitors",
               returning_visitors AS "returningVisitors", sessions, laps, flight_s AS "flightS", crashes
        FROM stats_days WHERE day >= $1::date ORDER BY day`, [from]),
      this.pool.query(`
        SELECT dim, key, SUM(visits)::int AS visits, SUM(sessions)::int AS sessions, SUM(laps)::int AS laps
        FROM stats_dims WHERE day >= $1::date GROUP BY dim, key`, [from]),
      this.pool.query(`
        SELECT COALESCE(SUM(visits), 0)::int AS visits, COALESCE(SUM(sessions), 0)::int AS sessions,
               COALESCE(SUM(laps), 0)::int AS laps, COALESCE(SUM(flight_s), 0)::bigint AS "flightS",
               COALESCE(SUM(crashes), 0)::int AS crashes, to_char(MIN(day), 'YYYY-MM-DD') AS "firstDay"
        FROM stats_days`),
      this.pool.query(`
        SELECT COUNT(DISTINCT key)::int AS n FROM stats_dims WHERE dim = 'country' AND key <> $1`,
      [STATS_COUNTRY_UNKNOWN]),
    ]);
    const dayRows = new Map(series.rows.map((row) => [row.day, { ...row, flightS: Number(row.flightS) }]));
    const { firstDay, ...sums } = totals.rows[0];
    return shapeStats({
      now,
      days,
      dayRows,
      dimRows: dims.rows,
      allTime: { ...sums, flightS: Number(sums.flightS) },
      firstDay,
      countriesAllTime: countries.rows[0].n,
    });
  }

  async boardFacts() {
    const found = await this.pool.query(`
      WITH pilots AS (
        SELECT lower(name) AS who, COUNT(DISTINCT (posted_utc AT TIME ZONE 'UTC')::date) AS days
        FROM times GROUP BY lower(name)
      )
      SELECT (SELECT COUNT(*)::int FROM tracks) AS tracks,
             (SELECT COUNT(*)::int FROM times) AS times,
             (SELECT COUNT(*)::int FROM pilots) AS pilots,
             (SELECT COUNT(*)::int FROM pilots WHERE days > 1) AS "pilotsOnMoreThanOneDay"`);
    return found.rows[0];
  }
}

export async function openStore() {
  const url = process.env.DATABASE_URL;
  const store = url
    ? new PgStore(url)
    : new FileStore(process.env.BOARD_FILE || join(repoRoot, 'data', 'board.json'));
  await store.init();
  store.kind = url ? 'postgres' : 'file';
  return store;
}
