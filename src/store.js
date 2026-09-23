/*
 * store.js: published tracks and their times.
 *
 * Postgres when DATABASE_URL is set, a JSON file when it is not. The two
 * backends answer the same methods so the rest of the server never asks
 * which one is live. Local development needs no Docker. Render needs
 * nothing except the URL it already hands a web service.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  creditOf, hashEditKey, planFromDocument, trackClassOf, STATS_COUNTRY_UNKNOWN,
} from './validate.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function nowIso() {
  return new Date().toISOString();
}

function newBugId() {
  return `bug-${randomBytes(4).toString('hex')}`;
}

/* The handle a time is addressed by over the API. Minted here, like a bug
 * id, because the file store has no serial and the Postgres serial is a
 * storage detail nothing outside this file should learn. */
function newTimeId() {
  return `tm-${randomBytes(4).toString('hex')}`;
}

/*
 * A time row as the API shows it in a list: the ghost blob itself never
 * travels with a track, only the fact that one exists, or a track with
 * forty recorded laps would weigh megabytes on every open of its sheet.
 * Rows from before ghosts have no public id; they read as unfetchable,
 * which they are.
 */
function summaryTime(row) {
  return {
    id: row.id || null,
    name: row.name,
    lapMs: row.lapMs,
    /* The fastest three consecutive laps of that run, or null. Null on
     * every row posted before it existed and on every run that never put
     * three clean laps together, and the page prints nothing for both. */
    threeMs: row.threeMs == null ? null : row.threeMs,
    postedUtc: row.postedUtc,
    hasGhost: Boolean(row.ghost),
  };
}

function bugLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return 80;
  }
  return Math.min(Math.floor(n), 200);
}

function summaryBug(row) {
  const context = row.context && typeof row.context === 'object' ? row.context : {};
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

function fullBug(row) {
  return {
    ...summaryBug(row),
    what: row.what,
    expected: row.expected || '',
    steps: row.steps || '',
    context: row.context && typeof row.context === 'object' ? row.context : {},
    resolution: row.resolution || '',
  };
}

function listBugRows(rows, { status, kind, limit } = {}) {
  let list = rows.slice();
  if (status) {
    list = list.filter((row) => row.status === status);
  }
  if (kind) {
    list = list.filter((row) => row.kind === kind);
  }
  list.sort((a, b) => String(b.submittedUtc).localeCompare(String(a.submittedUtc)));
  return list.slice(0, bugLimit(limit)).map(summaryBug);
}

async function writeAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(path).catch(() => {});
    await rename(tmp, path);
  }
}

function livePlan(track) {
  /* Rebuilt from the document on every list, so a drawing fix does not
   * wait for every track to be republished. */
  if (track && track.document) {
    return planFromDocument(track.document);
  }
  return track && track.plan ? track.plan : { width: 60, depth: 40, marks: [], path: [] };
}

/*
 * Fastest first, and the earliest post wins a tie. Written out three times
 * in this file, and its SQL twins are the ORDER BY in PgStore.getTrack and
 * the comparison in addTime's rank: all five have to agree or a lap is
 * ranked one way in the list and another in the confirmation.
 */
function byLap(a, b) {
  return a.lapMs - b.lapMs || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* The answer to an upload whose key does not open the track it names. It
 * is worded as a fact about the key rather than about the track, because
 * unlike a publish there is nothing useful the stranger can do instead: a
 * copy under a new name is not an answer to "your animation was refused".
 * 403 rather than 409 for the same reason, it is not a collision. */
const NOT_YOURS = {
  error: 'That track was published from another browser, so this one cannot change its animation.',
  status: 403,
};

/* One 409, so the three publish paths cannot word it three ways. */
const CONFLICT = {
  error: 'This track is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.',
  status: 409,
  conflict: true,
};

export function summaryOf(track, times) {
  const ranked = [...times].sort(byLap);
  const best = ranked[0] || null;
  return {
    id: track.id,
    name: track.name,
    author: track.author,
    gates: track.gates,
    elements: track.elements,
    hasLogo: track.hasLogo,
    /* Derived from the stored document on every read, exactly as the plan
     * is, so there is one copy of the truth and no migration. Every track
     * published before the class existed reads as the field it was. */
    trackClass: trackClassOf(track.document),
    /* The designer, and the series the track belongs to, read off the
     * document the same way. Empty on a track whose builder left the credit
     * block alone, which is most of them. See creditOf in validate.js. */
    ...creditOf(track.document),
    plan: livePlan(track),
    publishedUtc: track.publishedUtc,
    updatedUtc: track.updatedUtc,
    times: ranked.length,
    best: best ? { name: best.name, lapMs: best.lapMs } : null,
    /* Every track published before tags existed has none, and an absent
     * list must read as an empty one rather than as undefined: the page
     * filters on it and a card prints it. */
    tags: Array.isArray(track.tags) ? track.tags : [],
    /* WHETHER THERE IS AN ANIMATION, NOT THE ANIMATION.
     *
     * The bytes are tens of kilobytes and a listing is the whole board, so
     * a list that carried them would be megabytes of base64 nobody asked
     * for. The card asks for the picture by its own address instead, which
     * is what an <img> is for and what a cache can keep. gifUtc is in the
     * flag's place so the card's src can carry it and a replaced animation
     * is not served from yesterday's cache. */
    hasGif: Boolean(track.gif),
    gifUtc: track.gifUtc || null,
  };
}

/*
 * Highest score first, and the earliest post wins a tie, so a pilot who
 * matches a score does not take the place off the pilot who got there
 * first. Its SQL twins are the ORDER BY in PgStore.listRuns and the index
 * runs_map_score in schema.sql, and like byLap's five copies they all have
 * to agree or a run is ranked one way in the list and another in the
 * confirmation the pilot is shown.
 */
function byScore(a, b) {
  return b.score - a.score || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* The handle a run is addressed by. Minted here for the same reason a time
 * id is: the file store has no serial. */
function newRunId() {
  return `run-${randomBytes(4).toString('hex')}`;
}

/* A run row as the API shows it. Every field the arcade board prints, and
 * nothing else. */
function summaryRun(row) {
  return {
    id: row.id || null,
    name: row.name,
    map: row.map,
    style: row.style,
    score: row.score,
    durationMs: row.durationMs,
    tricks: row.tricks,
    unique: row.unique,
    bestCombo: row.bestCombo,
    bestTrick: row.bestTrick,
    crashes: row.crashes,
    signature: row.signature || '',
    postedUtc: row.postedUtc,
  };
}

/* ------------------------------------------------------------------ */
/* JSON file                                                           */
/* ------------------------------------------------------------------ */

function emptyFile() {
  return {
    tracks: {}, times: {}, bugs: {}, runs: [], stats: { days: {}, dims: {} }, pilots: {},
  };
}

/* ------------------------------------------------------------------ */
/* Site statistics: counters, never events                             */
/* ------------------------------------------------------------------ */

/*
 * The shared half of the two stores' statistics. Both backends hold the
 * same two tables in their own way, so the SHAPE of the answer is written
 * once here and each backend only has to produce the rows.
 *
 * Nothing in this section can answer a question about one browser, because
 * nothing in either table is about one browser. See the header of the
 * stats_days table in schema.sql.
 */

export function emptyStatsDay(day) {
  return {
    day,
    visits: 0,
    newVisitors: 0,
    returningVisitors: 0,
    sessions: 0,
    laps: 0,
    flightS: 0,
    crashes: 0,
  };
}

/* The window's days, oldest first, ending today. Built from the day
 * strings rather than from Date arithmetic across a DST boundary, which is
 * a bug this sort of code has by default: UTC midnight plus 24 hours is
 * always the next UTC day. */
export function statsDayKeys(now, count) {
  const end = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/*
 * Rank a dimension's rows. Sessions first, because a session is the number
 * the page is ranking by; then visits, then laps, then the key, so the
 * order is stable when a young board has ties everywhere.
 *
 * ZZ is forced to the foot and never ranked. "Unknown" is not a country
 * that did better or worse than Australia: it is the rows the edge could
 * not name, and printing it third would read as a place.
 */
function byDimRow(a, b) {
  if ((a.key === STATS_COUNTRY_UNKNOWN) !== (b.key === STATS_COUNTRY_UNKNOWN)) {
    return a.key === STATS_COUNTRY_UNKNOWN ? 1 : -1;
  }
  return (b.sessions - a.sessions)
    || (b.visits - a.visits)
    || (b.laps - a.laps)
    || String(a.key).localeCompare(String(b.key));
}

/*
 * Assemble what GET /api/stats answers with, from rows either backend can
 * produce.
 *
 * `dayRows` is a Map from day string to a row; a day nobody visited is
 * simply absent and is zero filled here, so the chart always has the same
 * number of bars and a quiet Sunday is a gap in the line rather than a
 * missing tick. `dimRows` is already summed over the window.
 */
export function shapeStats({
  now, days, dayRows, dimRows, allTime, firstDay, countriesAllTime,
}) {
  const keys = statsDayKeys(now, days);
  const series = keys.map((day) => dayRows.get(day) || emptyStatsDay(day));
  const window = series.reduce((sum, d) => ({
    days,
    visits: sum.visits + d.visits,
    newVisitors: sum.newVisitors + d.newVisitors,
    returningVisitors: sum.returningVisitors + d.returningVisitors,
    sessions: sum.sessions + d.sessions,
    laps: sum.laps + d.laps,
    flightS: sum.flightS + d.flightS,
    crashes: sum.crashes + d.crashes,
    countries: 0,
  }), {
    days,
    visits: 0,
    newVisitors: 0,
    returningVisitors: 0,
    sessions: 0,
    laps: 0,
    flightS: 0,
    crashes: 0,
    countries: 0,
  });
  const of = (dim) => dimRows.filter((r) => r.dim === dim).sort(byDimRow);
  const countries = of('country');
  window.countries = countries.filter((r) => r.key !== STATS_COUNTRY_UNKNOWN).length;
  return {
    generatedUtc: new Date(now).toISOString(),
    firstDay: firstDay || null,
    today: series[series.length - 1],
    days: series,
    window,
    allTime: { ...allTime, countries: countriesAllTime },
    countries,
    sources: of('source'),
    craft: of('craft'),
    maps: of('map'),
    inputs: of('input'),
    surfaces: of('surface'),
  };
}

class FileStore {
  constructor(path) {
    this.path = path;
    this.data = emptyFile();
    this.mutex = Promise.resolve();
  }

  lock(fn) {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(() => undefined, () => undefined);
    return run;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.tracks || !parsed.times) {
        console.error('board.json is missing tracks or times; starting empty in memory and leaving the file alone.');
        this.data = emptyFile();
        return;
      }
      this.data = parsed;
      if (!this.data.bugs || typeof this.data.bugs !== 'object' || Array.isArray(this.data.bugs)) {
        this.data.bugs = {};
      }
      /* Repaired in place, NOT added to the guard above. A board.json
       * written before freestyle runs existed is not corrupt, it is old,
       * and treating it as corrupt would blank every developer's local
       * board on the next start. Same rule bugs got. */
      if (!Array.isArray(this.data.runs)) {
        this.data.runs = [];
      }
      if (!this.data.pilots || typeof this.data.pilots !== 'object' || Array.isArray(this.data.pilots)) {
        this.data.pilots = {};
      }
      /* Same rule again, for the statistics counters. A board.json written
       * before this page existed is old, not corrupt. */
      const stats = this.data.stats;
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
        this.data.stats = { days: {}, dims: {} };
      } else {
        if (!stats.days || typeof stats.days !== 'object' || Array.isArray(stats.days)) {
          stats.days = {};
        }
        if (!stats.dims || typeof stats.dims !== 'object' || Array.isArray(stats.dims)) {
          stats.dims = {};
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.data = emptyFile();
        await this.flush();
        return;
      }
      console.error('board.json could not be read; starting empty in memory and leaving the file alone.', e);
      this.data = emptyFile();
    }
  }

  async flush() {
    await writeAtomic(this.path, JSON.stringify(this.data));
  }

  async listTracks() {
    return Object.values(this.data.tracks)
      .map((track) => summaryOf(track, this.data.times[track.id] || []))
      .sort((a, b) => String(b.updatedUtc).localeCompare(String(a.updatedUtc)));
  }

  async getTrack(id) {
    const track = this.data.tracks[id];
    if (!track) {
      return null;
    }
    const times = [...(this.data.times[id] || [])]
      .sort(byLap);
    return { ...summaryOf(track, times), times: times.map(summaryTime) };
  }

  async getDocument(id) {
    const track = this.data.tracks[id];
    if (!track) {
      return null;
    }
    return {
      id: track.id,
      name: track.name,
      author: track.author,
      document: track.document,
    };
  }

  async publish({ inspected, author, editKey, tags }) {
    return this.lock(() => this.publishUnlocked({ inspected, author, editKey, tags }));
  }

  async publishUnlocked({ inspected, author, editKey, tags = [] }) {
    const existing = this.data.tracks[inspected.id];
    let key = editKey;
    let timesCleared = false;
    if (existing) {
      if (!editKey || hashEditKey(editKey) !== existing.editKeyHash) {
        return { ...CONFLICT };
      }
      if (existing.layoutHash !== inspected.layoutHash) {
        this.data.times[inspected.id] = [];
        timesCleared = true;
      } else if (existing.author !== author) {
        const times = this.data.times[inspected.id] || [];
        for (const row of times) {
          if (row.name === existing.author) {
            row.name = author;
          }
        }
      }
    } else {
      key = randomBytes(16).toString('hex');
    }
    const publishedUtc = existing ? existing.publishedUtc : nowIso();
    /* THE ANIMATION SURVIVES A RENAME AND NOT A RELAYOUT.
     *
     * It is a picture of a layout, so the moment the layout changes it is a
     * picture of a track nobody can fly, and that is exactly the case the
     * times are already cleared for. A rename, a retag or a new author
     * leaves it alone, because none of those changes what the lap looks
     * like and re-rendering it would cost the publisher a minute for a file
     * identical to the one already here. */
    const keepGif = existing && existing.layoutHash === inspected.layoutHash;
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
      gif: keepGif ? (existing.gif || null) : null,
      gifUtc: keepGif ? (existing.gifUtc || null) : null,
      publishedUtc,
      updatedUtc: nowIso(),
    };
    if (!this.data.times[inspected.id]) {
      this.data.times[inspected.id] = [];
    }
    await this.flush();
    return {
      id: inspected.id,
      name: inspected.name,
      author,
      editKey: existing ? undefined : key,
      updated: Boolean(existing),
      timesCleared,
    };
  }

  /*
   * Base64 in the file store, because a JSON file cannot hold a byte array
   * and the alternative is a second file beside it to keep in step. The SQL
   * store keeps the bytes themselves, which is what BYTEA is for.
   *
   * The key is checked HERE and not in the route, for the same reason
   * publish checks it here: the hash is a column of this table and nothing
   * outside this file has ever been given it. `admin` is the one way past,
   * and the route is what decides whether a request has earned it.
   */
  async setGif({ id, bytes, editKey = '', admin = false }) {
    return this.lock(async () => {
      const track = this.data.tracks[id];
      if (!track) {
        return null;
      }
      if (!admin && (!editKey || hashEditKey(editKey) !== track.editKeyHash)) {
        return { ...NOT_YOURS };
      }
      track.gif = Buffer.from(bytes).toString('base64');
      track.gifUtc = nowIso();
      await this.flush();
      return { id, gifUtc: track.gifUtc };
    });
  }

  async getGif(id) {
    const track = this.data.tracks[id];
    if (!track || !track.gif) {
      return null;
    }
    return { bytes: Buffer.from(track.gif, 'base64'), gifUtc: track.gifUtc || null };
  }

  /*
   * TAKING A TRACK OFF THE BOARD, WHICH IS THE ONE DESTRUCTIVE THING HERE.
   *
   * There is no edit key path and there is deliberately not one. An edit
   * key says "this browser published this track", and that is enough to
   * change a layout, because the people whose times it clears posted them
   * against a layout that no longer exists. It is NOT enough to delete
   * other pilots' times outright: a record somebody flew for is not the
   * publisher's to throw away because they tired of their own track. So
   * the only way in is BOARD_ADMIN_TOKEN, the same token that writes an
   * animation onto a track this browser did not publish, and the route is
   * what decides whether a request has earned it.
   *
   * The times go with it, because a time is a time ON a track and a row
   * pointing at a track that is not here is not a record of anything. The
   * SQL twin gets the same result from ON DELETE CASCADE. `runs` are not
   * touched: a run is scored on a named map rather than on a published
   * track, so no row in it points at this id.
   *
   * Returns the removed track's name, so the caller can say what went
   * rather than echo an id back at whoever typed it.
   */
  async removeTrack(id) {
    return this.lock(async () => {
      const track = this.data.tracks[id];
      if (!track) {
        return null;
      }
      const times = (this.data.times[id] || []).length;
      delete this.data.tracks[id];
      delete this.data.times[id];
      await this.flush();
      return { id, name: track.name, author: track.author, times };
    });
  }

  async addTime({ trackId, name, lapMs, threeMs, ghost, key }) {
    return this.lock(() => this.addTimeUnlocked({ trackId, name, lapMs, threeMs, ghost, key }));
  }

  /*
   * A name belongs to the first key that posts under it. Names compare
   * case-insensitively, so "Ada" and "ada" are one pilot. The same key
   * claiming again is a no-op; another key is refused with a 403 the pilot
   * can read. Nothing here can free a name: that is an admin's job, later.
   */
  async claimName(name, key) {
    return this.lock(async () => {
      const nameKey = String(name).trim().toLowerCase();
      const have = this.data.pilots[nameKey];
      if (!have) {
        this.data.pilots[nameKey] = { name, key, claimedUtc: nowIso() };
        await this.flush();
        return { claimed: true };
      }
      if (have.key === key) {
        return { claimed: false };
      }
      return { error: 'That name belongs to another pilot. Pick another name, or import their pilot key.', status: 403 };
    });
  }

  hasTimeId(id) {
    for (const list of Object.values(this.data.times)) {
      if (list.some((row) => row.id === id)) {
        return true;
      }
    }
    return false;
  }

  async addTimeUnlocked({ trackId, name, lapMs, threeMs, ghost, key }) {
    const track = this.data.tracks[trackId];
    if (!track) {
      return { error: 'That track is not on the board.', status: 404 };
    }
    let id = newTimeId();
    while (this.hasTimeId(id)) {
      id = newTimeId();
    }
    const row = {
      id, name, lapMs, threeMs: threeMs == null ? null : threeMs, ghost: ghost || null, key: key || null, postedUtc: nowIso(),
    };
    const list = this.data.times[trackId] || [];
    list.push(row);
    this.data.times[trackId] = list;
    await this.flush();
    const ranked = [...list].sort(byLap);
    const rank = ranked.findIndex((t) => t === row) + 1;
    return {
      id, name, lapMs, threeMs: row.threeMs, postedUtc: row.postedUtc, rank, times: ranked.length,
    };
  }

  async getGhost(trackId, timeId) {
    const list = this.data.times[trackId] || [];
    const row = list.find((t) => t.id === timeId);
    if (!row) {
      return null;
    }
    return { id: row.id, name: row.name, lapMs: row.lapMs, ghost: row.ghost || null };
  }

  async listRuns({ map } = {}) {
    const rows = (this.data.runs || []).filter((r) => !map || r.map === map);
    return rows.sort(byScore).map(summaryRun);
  }

  async addRun(run) {
    return this.lock(() => this.addRunUnlocked(run));
  }

  /*
   * ONE ROW PER PILOT PER MAP, replaced only by a better run.
   *
   * A leaderboard is a list of who is good, not a log of who pressed the
   * button. Keeping every run would let one pilot own the whole visible
   * table by flying twenty mediocre ones, which is not a thing anybody does
   * on purpose and is exactly what somebody does on purpose. It also means
   * this endpoint, which is the board's first public write with no owner
   * and no edit key, cannot be used to fill the database.
   *
   * The pilot is matched case insensitively, so a name capitalised
   * differently on Tuesday does not become a second pilot. Its SQL twin is
   * the unique index runs_pilot_map.
   */
  async addRunUnlocked(run) {
    if (!Array.isArray(this.data.runs)) {
      this.data.runs = [];
    }
    const key = run.name.toLowerCase();
    const held = this.data.runs.find((r) => r.map === run.map && r.name.toLowerCase() === key);
    if (held && held.score >= run.score) {
      const ranked = [...this.data.runs].filter((r) => r.map === run.map).sort(byScore);
      return {
        ...summaryRun(held),
        rank: ranked.indexOf(held) + 1,
        runs: ranked.length,
        improved: false,
      };
    }
    let id = newRunId();
    while (this.data.runs.some((r) => r.id === id)) {
      id = newRunId();
    }
    const row = { ...run, id, postedUtc: nowIso() };
    if (held) {
      this.data.runs[this.data.runs.indexOf(held)] = row;
    } else {
      this.data.runs.push(row);
    }
    await this.flush();
    const ranked = [...this.data.runs].filter((r) => r.map === run.map).sort(byScore);
    return {
      ...summaryRun(row),
      rank: ranked.indexOf(row) + 1,
      runs: ranked.length,
      improved: true,
    };
  }

  async listBugs({ status, kind, limit } = {}) {
    return listBugRows(Object.values(this.data.bugs || {}), { status, kind, limit });
  }

  async getBug(id) {
    const row = this.data.bugs && this.data.bugs[id];
    return row ? fullBug(row) : null;
  }

  async addBug(inspected) {
    return this.lock(() => this.addBugUnlocked(inspected));
  }

  async addBugUnlocked(inspected) {
    if (!this.data.bugs) {
      this.data.bugs = {};
    }
    let id = newBugId();
    while (this.data.bugs[id]) {
      id = newBugId();
    }
    const submittedUtc = nowIso();
    const row = {
      id,
      status: 'open',
      kind: inspected.kind,
      title: inspected.title,
      what: inspected.what,
      expected: inspected.expected,
      steps: inspected.steps,
      reporter: inspected.reporter,
      context: inspected.context || {},
      resolution: '',
      submittedUtc,
      updatedUtc: submittedUtc,
    };
    this.data.bugs[id] = row;
    await this.flush();
    return fullBug(row);
  }

  async updateBug(id, patch) {
    return this.lock(() => this.updateBugUnlocked(id, patch));
  }

  async updateBugUnlocked(id, patch) {
    const row = this.data.bugs && this.data.bugs[id];
    if (!row) {
      return { error: 'That ticket is not on the board.', status: 404 };
    }
    if (patch.status) {
      row.status = patch.status;
    }
    if (patch.resolution != null) {
      row.resolution = patch.resolution;
    }
    row.updatedUtc = nowIso();
    await this.flush();
    return fullBug(row);
  }

  /* ---------------------------------------------------------------- */
  /* Site statistics                                                    */
  /* ---------------------------------------------------------------- */

  /*
   * Add one event to the day it landed on. The store never learns anything
   * else about it: `event` has already been through inspectStatsEvent, and
   * the tab handle a flush carries is read by the server's live count and
   * deliberately not passed here.
   */
  async recordStats(event, { day, country }) {
    return this.lock(() => this.recordStatsUnlocked(event, { day, country }));
  }

  async recordStatsUnlocked(event, { day, country }) {
    if (!this.data.stats) {
      this.data.stats = { days: {}, dims: {} };
    }
    const { days, dims } = this.data.stats;
    if (!days[day]) {
      days[day] = emptyStatsDay(day);
    }
    const row = days[day];
    const bump = (dim, key, field, n) => {
      const at = `${day}|${dim}|${key}`;
      if (!dims[at]) {
        dims[at] = {
          day, dim, key, visits: 0, sessions: 0, laps: 0,
        };
      }
      dims[at][field] += n;
    };

    if (event.kind === 'visit') {
      row.visits += 1;
      if (event.returning) {
        row.returningVisitors += 1;
      } else {
        row.newVisitors += 1;
      }
      bump('surface', event.surface, 'visits', 1);
      bump('country', country, 'visits', 1);
      bump('source', event.source, 'visits', 1);
    } else if (event.kind === 'session') {
      row.sessions += 1;
      bump('craft', event.craft, 'sessions', 1);
      bump('map', event.map, 'sessions', 1);
      bump('input', event.input, 'sessions', 1);
      bump('country', country, 'sessions', 1);
      bump('source', event.source, 'sessions', 1);
    } else {
      row.laps += event.laps;
      row.flightS += event.flightS;
      row.crashes += event.crashes;
      /* A flush with no laps in it is the heartbeat that answers "flying
       * now". It moves the day's flight seconds and touches no dimension,
       * which is what keeps the dims table proportional to the flying
       * rather than to the number of minutes somebody sat on the line. */
      if (event.laps > 0) {
        bump('craft', event.craft, 'laps', event.laps);
        bump('map', event.map, 'laps', event.laps);
        bump('country', country, 'laps', event.laps);
        bump('source', event.source, 'laps', event.laps);
      }
    }
    await this.flush();
  }

  async readStats({ days = 30, now = Date.now() } = {}) {
    const stats = this.data.stats || { days: {}, dims: {} };
    const keys = new Set(statsDayKeys(now, days));
    const dayRows = new Map();
    for (const [day, row] of Object.entries(stats.days)) {
      if (keys.has(day)) {
        dayRows.set(day, { ...row });
      }
    }
    const summed = new Map();
    for (const row of Object.values(stats.dims)) {
      if (!keys.has(row.day)) {
        continue;
      }
      const at = `${row.dim}|${row.key}`;
      const held = summed.get(at) || {
        dim: row.dim, key: row.key, visits: 0, sessions: 0, laps: 0,
      };
      held.visits += row.visits;
      held.sessions += row.sessions;
      held.laps += row.laps;
      summed.set(at, held);
    }
    const allDays = Object.values(stats.days);
    const allTime = allDays.reduce((sum, d) => ({
      visits: sum.visits + d.visits,
      sessions: sum.sessions + d.sessions,
      laps: sum.laps + d.laps,
      flightS: sum.flightS + d.flightS,
      crashes: sum.crashes + d.crashes,
    }), {
      visits: 0, sessions: 0, laps: 0, flightS: 0, crashes: 0,
    });
    const named = new Set();
    for (const row of Object.values(stats.dims)) {
      if (row.dim === 'country' && row.key !== STATS_COUNTRY_UNKNOWN) {
        named.add(row.key);
      }
    }
    const first = Object.keys(stats.days).sort();
    return shapeStats({
      now,
      days,
      dayRows,
      dimRows: [...summed.values()],
      allTime,
      firstDay: first[0] || null,
      countriesAllTime: named.size,
    });
  }

  /*
   * The four numbers the statistics page takes from the BOARD's own tables
   * rather than from the counters: they are not events and never were, so
   * counting them from tracks and times is both cheaper and truer than
   * having the simulator report them.
   */
  async boardFacts() {
    const tracks = Object.keys(this.data.tracks).length;
    const byPilot = new Map();
    let times = 0;
    for (const list of Object.values(this.data.times)) {
      for (const row of list) {
        times += 1;
        const who = String(row.name || '').toLowerCase();
        const held = byPilot.get(who) || new Set();
        held.add(String(row.postedUtc || '').slice(0, 10));
        byPilot.set(who, held);
      }
    }
    let onMoreThanOneDay = 0;
    for (const days of byPilot.values()) {
      if (days.size > 1) {
        onMoreThanOneDay += 1;
      }
    }
    return {
      tracks, times, pilots: byPilot.size, pilotsOnMoreThanOneDay: onMoreThanOneDay,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

class PgStore {
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async init() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    const sql = await readFile(join(root, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async listTracks() {
    /* Named columns rather than a star, so the animations stay in the
     * database. A board of thirty tracks whose list carried every GIF would
     * be megabytes of bytes no reader asked for, and a card fetches the one
     * it wants by its own address. Everything rowToSummary reads is here,
     * plus the flag that stands in for the bytes. */
    const tracks = await this.pool.query(`
      SELECT id, name, author, document, plan, has_logo, gates, elements, tags,
             published_utc, updated_utc, gif_utc,
             (gif IS NOT NULL) AS has_gif
      FROM tracks ORDER BY updated_utc DESC
    `);
    const bests = await this.pool.query(`
      SELECT DISTINCT ON (track_id) track_id, name, lap_ms
      FROM times
      ORDER BY track_id, lap_ms ASC, posted_utc ASC
    `);
    const counts = await this.pool.query('SELECT track_id, COUNT(*)::int AS n FROM times GROUP BY track_id');
    const bestBy = new Map(bests.rows.map((r) => [r.track_id, { name: r.name, lapMs: r.lap_ms }]));
    const nBy = new Map(counts.rows.map((r) => [r.track_id, r.n]));
    return tracks.rows.map((row) => ({
      ...rowToSummary(row),
      times: nBy.get(row.id) || 0,
      best: bestBy.get(row.id) || null,
    }));
  }

  async getTrack(id) {
    const found = await this.pool.query(`
      SELECT id, name, author, document, plan, has_logo, gates, elements, tags,
             published_utc, updated_utc, gif_utc,
             (gif IS NOT NULL) AS has_gif
      FROM tracks WHERE id = $1
    `, [id]);
    if (!found.rowCount) {
      return null;
    }
    const times = await this.pool.query(
      `SELECT public_id AS id, name, lap_ms AS "lapMs", three_ms AS "threeMs", posted_utc AS "postedUtc",
              (ghost IS NOT NULL) AS "hasGhost"
       FROM times WHERE track_id = $1 ORDER BY lap_ms ASC, posted_utc ASC`,
      [id],
    );
    /* `best` too. The file store's getTrack returns it through summaryOf
     * and the board's track sheet reads it, so leaving it out here made
     * the same track render differently depending on the backend. */
    const rows = times.rows;
    return {
      ...rowToSummary(found.rows[0]),
      times: rows,
      best: rows[0] ? { name: rows[0].name, lapMs: rows[0].lapMs } : null,
    };
  }

  async getDocument(id) {
    const found = await this.pool.query(
      'SELECT id, name, author, document FROM tracks WHERE id = $1',
      [id],
    );
    if (!found.rowCount) {
      return null;
    }
    return found.rows[0];
  }

  async publish({ inspected, author, editKey, tags = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [inspected.id]);
      let key = editKey;
      let timesCleared = false;
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (!editKey || hashEditKey(editKey) !== row.edit_key_hash) {
          await client.query('ROLLBACK');
          return { ...CONFLICT };
        }
        if (row.layout_hash !== inspected.layoutHash) {
          await client.query('DELETE FROM times WHERE track_id = $1', [inspected.id]);
          timesCleared = true;
        } else if (row.author !== author) {
          await client.query(
            'UPDATE times SET name = $2 WHERE track_id = $1 AND name = $3',
            [inspected.id, author, row.author],
          );
        }
        /* The animation is a picture of a layout, so a relayout throws it
         * away for the same reason it throws the times away: it is a
         * picture of a track nobody can fly any more. A rename or a retag
         * keeps it, because neither changes what the lap looks like. The
         * file store's publishUnlocked carries the same rule. */
        if (timesCleared) {
          await client.query('UPDATE tracks SET gif = NULL, gif_utc = NULL WHERE id = $1', [inspected.id]);
        }
        await client.query(
          `UPDATE tracks SET
            name = $2, author = $3, document = $4, plan = $5, layout_hash = $6,
            has_logo = $7, gates = $8, elements = $9, tags = $10, updated_utc = NOW()
           WHERE id = $1`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, inspected.hasLogo, inspected.gates, inspected.elements,
            tags,
          ],
        );
      } else {
        key = randomBytes(16).toString('hex');
        await client.query(
          `INSERT INTO tracks (
            id, name, author, document, plan, layout_hash, edit_key_hash,
            has_logo, gates, elements, tags, published_utc, updated_utc
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, hashEditKey(key), inspected.hasLogo, inspected.gates,
            inspected.elements, tags,
          ],
        );
      }
      await client.query('COMMIT');
      return {
        id: inspected.id,
        name: inspected.name,
        author,
        editKey: existing.rowCount ? undefined : key,
        updated: Boolean(existing.rowCount),
        timesCleared,
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      if (e.code === '23505') {
        return { ...CONFLICT };
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /* The file store's twin, and the key is checked here for the same
   * reason: edit_key_hash is a column of this table. One statement, so the
   * check and the write cannot be raced apart. */
  async setGif({ id, bytes, editKey = '', admin = false }) {
    const found = await this.pool.query('SELECT edit_key_hash FROM tracks WHERE id = $1', [id]);
    if (!found.rowCount) {
      return null;
    }
    if (!admin && (!editKey || hashEditKey(editKey) !== found.rows[0].edit_key_hash)) {
      return { ...NOT_YOURS };
    }
    const done = await this.pool.query(
      'UPDATE tracks SET gif = $2, gif_utc = NOW() WHERE id = $1 RETURNING gif_utc',
      [id, Buffer.from(bytes)],
    );
    return done.rowCount ? { id, gifUtc: done.rows[0].gif_utc } : null;
  }

  async getGif(id) {
    const found = await this.pool.query('SELECT gif, gif_utc FROM tracks WHERE id = $1', [id]);
    if (!found.rowCount || !found.rows[0].gif) {
      return null;
    }
    return { bytes: found.rows[0].gif, gifUtc: found.rows[0].gif_utc || null };
  }

  /*
   * The file store's twin, and its comment is the one that explains why
   * there is no edit key path. One statement: the times are carried off by
   * `times.track_id REFERENCES tracks(id) ON DELETE CASCADE` in schema.sql,
   * and the animation is a column of the row rather than a table of its
   * own, so it goes with it. Counted first, in the same connection, so the
   * number reported is the number that was actually taken.
   */
  async removeTrack(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const counted = await client.query(
        'SELECT name, author, (SELECT COUNT(*) FROM times WHERE track_id = $1) AS times FROM tracks WHERE id = $1',
        [id],
      );
      if (!counted.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('DELETE FROM tracks WHERE id = $1', [id]);
      await client.query('COMMIT');
      const row = counted.rows[0];
      return {
        id, name: row.name, author: row.author, times: Number(row.times) || 0,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async claimName(name, key) {
    const nameKey = String(name).trim().toLowerCase();
    const inserted = await this.pool.query(
      `INSERT INTO pilots (name_key, name, public_key, claimed_utc) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (name_key) DO NOTHING RETURNING name_key`,
      [nameKey, name, key],
    );
    if (inserted.rowCount) {
      return { claimed: true };
    }
    const have = await this.pool.query('SELECT public_key FROM pilots WHERE name_key = $1', [nameKey]);
    if (have.rowCount && have.rows[0].public_key === key) {
      return { claimed: false };
    }
    return { error: 'That name belongs to another pilot. Pick another name, or import their pilot key.', status: 403 };
  }

  async addTime({ trackId, name, lapMs, threeMs, ghost, key }) {
    /* The public id is random, so an insert can collide with an existing
     * row's unique index. The whole transaction retries on a fresh id, the
     * same shape as addBug's loop; six failures in a row is not luck, it is
     * a broken random source, and deserves the throw. */
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.addTimeOnce({ trackId, name, lapMs, threeMs, ghost, key });
      if (result !== null) {
        return result;
      }
    }
    throw new Error('Could not allocate a time id.');
  }

  async addTimeOnce({ trackId, name, lapMs, threeMs, ghost, key }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT id FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'That track is not on the board.', status: 404 };
      }
      const inserted = await client.query(
        `INSERT INTO times (track_id, public_id, name, lap_ms, three_ms, ghost, pilot_key, posted_utc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id, public_id AS "publicId", name, lap_ms AS "lapMs",
                   three_ms AS "threeMs", posted_utc AS "postedUtc"`,
        [trackId, newTimeId(), name, lapMs, threeMs == null ? null : threeMs, ghost || null, key || null],
      );
      /*
       * Ranked against the stored row, by its id, and entirely inside
       * Postgres. The old form sent the returned timestamp back as a
       * parameter to compare against itself, and posted_utc is a TIMESTAMPTZ
       * with microseconds while a JS Date carries milliseconds. The value
       * that came back had been truncated, so `posted_utc <= $3` was false
       * for the row just written and the count missed itself: the fastest
       * lap on the board reported rank 0. Comparing by id never leaves the
       * database and cannot lose precision.
       */
      const rankRow = await client.query(
        `WITH mine AS (SELECT lap_ms, posted_utc FROM times WHERE id = $2)
         SELECT COUNT(*)::int AS n FROM times, mine
         WHERE times.track_id = $1
           AND (times.lap_ms < mine.lap_ms
                OR (times.lap_ms = mine.lap_ms AND times.posted_utc <= mine.posted_utc))`,
        [trackId, inserted.rows[0].id],
      );
      const count = await client.query('SELECT COUNT(*)::int AS n FROM times WHERE track_id = $1', [trackId]);
      await client.query('COMMIT');
      return {
        id: inserted.rows[0].publicId,
        name,
        lapMs,
        threeMs: inserted.rows[0].threeMs == null ? null : inserted.rows[0].threeMs,
        postedUtc: inserted.rows[0].postedUtc,
        rank: rankRow.rows[0].n,
        times: count.rows[0].n,
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      if (e.code === '23505') {
        /* The random public id landed on an existing one; the caller's
         * loop rolls a new one. */
        return null;
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async getGhost(trackId, timeId) {
    const found = await this.pool.query(
      `SELECT public_id AS id, name, lap_ms AS "lapMs", ghost
       FROM times WHERE track_id = $1 AND public_id = $2`,
      [trackId, timeId],
    );
    return found.rowCount ? found.rows[0] : null;
  }

  async listRuns({ map } = {}) {
    const found = await this.pool.query(
      `SELECT * FROM runs
       WHERE ($1::text IS NULL OR map = $1)
       ORDER BY score DESC, posted_utc ASC`,
      [map || null],
    );
    return found.rows.map(runRowToSummary);
  }

  /*
   * One row per pilot per map, replaced only by a better run. The reasoning
   * is on FileStore.addRunUnlocked; this is the same rule written in SQL.
   *
   * The upsert is on the unique index runs_pilot_map, and the WHERE on the
   * DO UPDATE is what makes it replace-if-better rather than
   * replace-always: a worse run touches nothing and the RETURNING comes
   * back empty, which the read below turns into the pilot's standing row.
   *
   * The public id is random and can collide, so the whole thing retries the
   * way addTime does. Six attempts against a four byte id is not a real
   * risk, it is the same belt this file already wears.
   */
  async addRun(run) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.addRunOnce(run);
      } catch (e) {
        if (e.code !== '23505' || String(e.constraint || '') !== 'runs_public_id') {
          throw e;
        }
      }
    }
    throw new Error('Could not allocate a run id.');
  }

  async addRunOnce(run) {
    const id = newRunId();
    const written = await this.pool.query(
      `INSERT INTO runs (
        public_id, name, map, style, score, duration_ms, tricks, unique_tricks,
        best_combo, best_trick, crashes, signature, posted_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (map, lower(name)) DO UPDATE SET
        public_id = EXCLUDED.public_id,
        name = EXCLUDED.name,
        style = EXCLUDED.style,
        score = EXCLUDED.score,
        duration_ms = EXCLUDED.duration_ms,
        tricks = EXCLUDED.tricks,
        unique_tricks = EXCLUDED.unique_tricks,
        best_combo = EXCLUDED.best_combo,
        best_trick = EXCLUDED.best_trick,
        crashes = EXCLUDED.crashes,
        signature = EXCLUDED.signature,
        posted_utc = EXCLUDED.posted_utc
      WHERE runs.score < EXCLUDED.score
      RETURNING *`,
      [
        id, run.name, run.map, run.style, run.score, run.durationMs, run.tricks,
        run.unique, run.bestCombo, run.bestTrick, run.crashes, run.signature,
      ],
    );
    const improved = written.rowCount > 0;
    const held = improved ? written.rows[0] : (await this.pool.query(
      'SELECT * FROM runs WHERE map = $1 AND lower(name) = lower($2)',
      [run.map, run.name],
    )).rows[0];
    /* The rank is asked for separately rather than computed in the insert,
     * because the ordering rule lives in one ORDER BY and this must not
     * become a sixth copy of it that could drift. */
    const ranked = await this.pool.query(
      `SELECT COUNT(*)::int AS ahead FROM runs
       WHERE map = $1
         AND (score > $2 OR (score = $2 AND posted_utc < $3))`,
      [run.map, held.score, held.posted_utc],
    );
    const total = await this.pool.query(
      'SELECT COUNT(*)::int AS n FROM runs WHERE map = $1', [run.map],
    );
    return {
      ...runRowToSummary(held),
      rank: ranked.rows[0].ahead + 1,
      runs: total.rows[0].n,
      improved,
    };
  }

  async listBugs({ status, kind, limit } = {}) {
    const found = await this.pool.query(
      `SELECT id, status, kind, title, reporter, context,
              submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
       FROM bugs
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR kind = $2)
       ORDER BY submitted_utc DESC
       LIMIT $3`,
      [status || null, kind || null, bugLimit(limit)],
    );
    return found.rows.map(summaryBug);
  }

  async getBug(id) {
    const found = await this.pool.query(
      `SELECT id, status, kind, title, what, expected, steps, reporter, context,
              resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
       FROM bugs WHERE id = $1`,
      [id],
    );
    return found.rowCount ? fullBug(found.rows[0]) : null;
  }

  async addBug(inspected) {
    for (let i = 0; i < 6; i += 1) {
      const id = newBugId();
      try {
        const inserted = await this.pool.query(
          `INSERT INTO bugs (
            id, status, kind, title, what, expected, steps, reporter, context,
            resolution, submitted_utc, updated_utc
          ) VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,'',NOW(),NOW())
          RETURNING id, status, kind, title, what, expected, steps, reporter, context,
                    resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"`,
          [
            id, inspected.kind, inspected.title, inspected.what, inspected.expected,
            inspected.steps, inspected.reporter, inspected.context || {},
          ],
        );
        return fullBug(inserted.rows[0]);
      } catch (e) {
        if (e.code === '23505') {
          continue;
        }
        throw e;
      }
    }
    throw new Error('Could not allocate a ticket id.');
  }

  async updateBug(id, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, status, kind, title, what, expected, steps, reporter, context,
                resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
         FROM bugs WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'That ticket is not on the board.', status: 404 };
      }
      const nextStatus = patch.status || found.rows[0].status;
      const nextResolution = patch.resolution != null ? patch.resolution : found.rows[0].resolution;
      const updated = await client.query(
        `UPDATE bugs SET status = $2, resolution = $3, updated_utc = NOW()
         WHERE id = $1
         RETURNING id, status, kind, title, what, expected, steps, reporter, context,
                   resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"`,
        [id, nextStatus, nextResolution],
      );
      await client.query('COMMIT');
      return fullBug(updated.rows[0]);
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Site statistics                                                    */
  /* ---------------------------------------------------------------- */

  /*
   * The same counters as FileStore.recordStatsUnlocked, written in SQL.
   *
   * One transaction, so a day row and its dimension rows either all move or
   * none do. Every write is an upsert that ADDS: two instances of this
   * service, or two requests in the same millisecond, cannot lose a count
   * between a read and a write, because there is no read.
   */
  async recordStats(event, { day, country }) {
    const dims = [];
    const bump = (dim, key, visits, sessions, laps) => dims.push([dim, key, visits, sessions, laps]);
    let visits = 0;
    let newVisitors = 0;
    let returningVisitors = 0;
    let sessions = 0;
    let laps = 0;
    let flightS = 0;
    let crashes = 0;

    if (event.kind === 'visit') {
      visits = 1;
      newVisitors = event.returning ? 0 : 1;
      returningVisitors = event.returning ? 1 : 0;
      bump('surface', event.surface, 1, 0, 0);
      bump('country', country, 1, 0, 0);
      bump('source', event.source, 1, 0, 0);
    } else if (event.kind === 'session') {
      sessions = 1;
      bump('craft', event.craft, 0, 1, 0);
      bump('map', event.map, 0, 1, 0);
      bump('input', event.input, 0, 1, 0);
      bump('country', country, 0, 1, 0);
      bump('source', event.source, 0, 1, 0);
    } else {
      laps = event.laps;
      flightS = event.flightS;
      crashes = event.crashes;
      /* See the file store: a heartbeat touches no dimension. */
      if (event.laps > 0) {
        bump('craft', event.craft, 0, 0, event.laps);
        bump('map', event.map, 0, 0, event.laps);
        bump('country', country, 0, 0, event.laps);
        bump('source', event.source, 0, 0, event.laps);
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO stats_days (
           day, visits, new_visitors, returning_visitors, sessions, laps, flight_s, crashes
         ) VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (day) DO UPDATE SET
           visits = stats_days.visits + EXCLUDED.visits,
           new_visitors = stats_days.new_visitors + EXCLUDED.new_visitors,
           returning_visitors = stats_days.returning_visitors + EXCLUDED.returning_visitors,
           sessions = stats_days.sessions + EXCLUDED.sessions,
           laps = stats_days.laps + EXCLUDED.laps,
           flight_s = stats_days.flight_s + EXCLUDED.flight_s,
           crashes = stats_days.crashes + EXCLUDED.crashes`,
        [day, visits, newVisitors, returningVisitors, sessions, laps, flightS, crashes],
      );
      for (const [dim, key, v, s, l] of dims) {
        await client.query(
          `INSERT INTO stats_dims (day, dim, key, visits, sessions, laps)
           VALUES ($1::date,$2,$3,$4,$5,$6)
           ON CONFLICT (day, dim, key) DO UPDATE SET
             visits = stats_dims.visits + EXCLUDED.visits,
             sessions = stats_dims.sessions + EXCLUDED.sessions,
             laps = stats_dims.laps + EXCLUDED.laps`,
          [day, dim, key, v, s, l],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /*
   * `to_char` rather than the DATE itself, in every one of these. node-pg
   * parses a `date` column into a JS Date at the process's LOCAL midnight,
   * so a host running behind UTC hands back the day before and every bar on
   * the chart shifts by one. The column is a day, the page wants a day, and
   * the text is the day.
   */
  async readStats({ days = 30, now = Date.now() } = {}) {
    const keys = statsDayKeys(now, days);
    const from = keys[0];
    const [series, dims, all, named] = await Promise.all([
      this.pool.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, visits,
                new_visitors AS "newVisitors", returning_visitors AS "returningVisitors",
                sessions, laps, flight_s AS "flightS", crashes
         FROM stats_days WHERE day >= $1::date ORDER BY day`,
        [from],
      ),
      this.pool.query(
        `SELECT dim, key,
                SUM(visits)::int AS visits,
                SUM(sessions)::int AS sessions,
                SUM(laps)::int AS laps
         FROM stats_dims WHERE day >= $1::date GROUP BY dim, key`,
        [from],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(visits), 0)::int AS visits,
                COALESCE(SUM(sessions), 0)::int AS sessions,
                COALESCE(SUM(laps), 0)::int AS laps,
                COALESCE(SUM(flight_s), 0)::bigint AS "flightS",
                COALESCE(SUM(crashes), 0)::int AS crashes,
                to_char(MIN(day), 'YYYY-MM-DD') AS "firstDay"
         FROM stats_days`,
      ),
      this.pool.query(
        `SELECT COUNT(DISTINCT key)::int AS n
         FROM stats_dims WHERE dim = 'country' AND key <> $1`,
        [STATS_COUNTRY_UNKNOWN],
      ),
    ]);
    const dayRows = new Map();
    for (const row of series.rows) {
      dayRows.set(row.day, {
        day: row.day,
        visits: row.visits,
        newVisitors: row.newVisitors,
        returningVisitors: row.returningVisitors,
        sessions: row.sessions,
        laps: row.laps,
        /* BIGINT comes back as a string, because it can be larger than a
         * JavaScript number can hold exactly. Flight seconds cannot, and a
         * string here would concatenate rather than add. */
        flightS: Number(row.flightS),
        crashes: row.crashes,
      });
    }
    const row = all.rows[0];
    return shapeStats({
      now,
      days,
      dayRows,
      dimRows: dims.rows,
      allTime: {
        visits: row.visits,
        sessions: row.sessions,
        laps: row.laps,
        flightS: Number(row.flightS),
        crashes: row.crashes,
      },
      firstDay: row.firstDay,
      countriesAllTime: named.rows[0].n,
    });
  }

  async boardFacts() {
    const found = await this.pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM tracks) AS tracks,
         (SELECT COUNT(*)::int FROM times) AS times,
         (SELECT COUNT(DISTINCT lower(name))::int FROM times) AS pilots,
         (SELECT COUNT(*)::int FROM (
            SELECT lower(name) FROM times
            GROUP BY lower(name)
            HAVING COUNT(DISTINCT (posted_utc AT TIME ZONE 'UTC')::date) > 1
          ) q) AS "pilotsOnMoreThanOneDay"`,
    );
    return found.rows[0];
  }
}

/*
 * The Postgres row, in the shape summaryOf produces for the file store.
 * The two are one contract with two writers, so anything added to one has
 * to be added to the other: `best` was missing here for a while.
 *
 * `row.layout` used to be consulted here and there is no such column. The
 * plan is always re-derived from the document, which is why the stored
 * `plan` column is written and never read back.
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
    /* The designer and the series, read off the stored document. The twin
     * of the same line in summaryOf, and the reason the pair is now checked
     * against each other below: this one was forgotten for a deploy, so the
     * file store named the builder and the live board went on naming the
     * publisher. */
    ...creditOf(row.document),
    plan: planFromDocument(row.document),
    publishedUtc: row.published_utc,
    updatedUtc: row.updated_utc,
    /* A column added later, so a row read back from a database that has not
     * run the migration yet answers null rather than an array. Both spellings
     * of "no tags" have to become the same empty list, or the page filters
     * on undefined and a card throws. */
    tags: Array.isArray(row.tags) ? row.tags : [],
    /* The flag, never the bytes. See summaryOf, whose contract this is the
     * other writer of. A row selected without these two columns reads as no
     * animation, which is what the publish path's own SELECT wants. */
    hasGif: Boolean(row.has_gif),
    gifUtc: row.gif_utc || null,
  };
}

/* The Postgres twin of summaryRun. Same rule as rowToSummary and summaryOf:
 * one contract, two writers. */
function runRowToSummary(row) {
  return {
    id: row.public_id || null,
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
    signature: row.signature || '',
    postedUtc: row.posted_utc,
  };
}

export async function openStore() {
  const url = process.env.DATABASE_URL;
  const path = process.env.BOARD_FILE || join(root, 'data', 'board.json');
  const store = url ? new PgStore(url) : new FileStore(path);
  await store.init();
  store.kind = url ? 'postgres' : 'file';
  return store;
}
