/*
 * server.js: the board's HTTP service, a static page and a JSON API.
 *
 * The page lists every published track with its times; Fly opens the
 * simulator with ?share=<id>, the one link between the two sites. The
 * writes are a publish, a time, a card animation, a freestyle run, a
 * name claim, a bug report and a statistics event. The paths, status
 * codes, bodies and refusal sentences here are what the simulator, the
 * builder, the landing page and the board's own page are written
 * against; tests/server-golden.js pins them.
 *
 * Nothing is ambiently authenticated and no cookie is ever set, which is
 * why reflecting any origin in CORS grants nothing curl does not already
 * have. The one credential is a bearer token the Admin panel attaches by
 * hand (or BOARD_ADMIN_TOKEN, for scripts); see cors() and src/admin.js.
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
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import {
  dirname, extname, join, normalize, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLap } from '../vendor/fdfpv/src/game/verify.js';
import { verifyTimeSignature } from '../vendor/fdfpv/src/share/identity.js';
import {
  adminCount, checkPassword, mintSession, normaliseEmail, readSession, PASSWORD_MAX,
} from './admin.js';
import { attachLive } from './live.js';
import { keyLinkMessage, nameClaimMessage, verifyKeySignature } from './pilotkeys.js';
import {
  sourceKey, sponsorLink, sponsorList, sponsorName,
} from './sponsors.js';
import { openStore } from './store.js';
import {
  inspectAuth, inspectBugCreate, inspectBugPatch, inspectCraft, inspectDocument, inspectGhost, inspectGif,
  inspectRun, inspectStatsEvent, inspectTags, normaliseCountry, normaliseLapMs, normaliseName,
  normaliseThreeMs, statsDay,
  BUG_ID_RE, BUG_KINDS, BUG_STATUSES, MAX_BUG_IMAGE_BYTES, MAX_BUG_IMAGES, MAX_GIF_BASE64_CHARS, RETIRED_RUN_MAPS, RUN_MAPS, TAGS,
  TIME_ID_RE, TRACK_ID_RE,
} from './validate.js';

/* ================================================================== */
/* Configuration                                                       */
/* ================================================================== */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = resolve(repoRoot, 'public');
const env = process.env;
const port = Number(env.PORT || 3180);
/* All interfaces for a host like Render; 127.0.0.1 behind a proxy on the
 * same machine (the owner's VM), so the only way in sets the forwarded
 * headers BOARD_TRUST_PROXY believes. */
const listenHost = env.BOARD_HOST || '0.0.0.0';
const trimSlashes = (origin) => origin.replace(/\/+$/, '');
const simOrigin = trimSlashes(env.SIM_ORIGIN || 'http://127.0.0.1:8000');
const publicOrigin = trimSlashes(env.BOARD_PUBLIC_ORIGIN || '');
const trustProxy = () => env.BOARD_TRUST_PROXY === '1';
const bugsToken = String(env.BUGS_TOKEN || '');
/* A way past an edit key for scripts, which have no browser to sign in
 * from (the simulator's scripts/boardgif.js holds it). Unset, no script
 * can remove or replace anything; a signed in admin still can. */
const adminToken = String(env.BOARD_ADMIN_TOKEN || '');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  /* The credits' pilot photographs; without these they go out as
   * octet-stream and show as broken images. */
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/*
 * What is running, for GET /api/version: the simulator's
 * deploy/vm/deploy-board.sh writes REVISION ("<board commit> vendor/fdfpv
 * <simulator commit>") before restarting the board, and it is read once so
 * the answer names the code this process loaded. No file (a checkout, or
 * another kind of host) answers nulls. A file that is not that line stops
 * the board at start: a deploy that wrote it wrong is a bug to see.
 */
async function loadRevision() {
  let text;
  try {
    text = await readFile(join(repoRoot, 'REVISION'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { commit: null, fdfpv: null };
    }
    throw err;
  }
  const parts = text.trim().match(/^([0-9a-f]{40}) vendor\/fdfpv ([0-9a-f]{40})$/);
  if (!parts) {
    throw new Error(`REVISION is not "<commit> vendor/fdfpv <commit>": ${JSON.stringify(text.slice(0, 120))}`);
  }
  return { commit: parts[1], fdfpv: parts[2] };
}

const revision = await loadRevision();
const store = await openStore();

/* ================================================================== */
/* Answers                                                             */
/* ================================================================== */

/*
 * Every response reflects the asking origin. That is the same grant as
 * '*' only because nothing here is ambient: no cookie, no HTTP auth, and
 * access-control-allow-credentials is never sent. The admin token is
 * attached by the board page's own script, never by the browser on another
 * site's behalf. Add a cookie and this has to name one origin instead.
 */
function allowOrigin(req, res) {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('vary', 'origin');
}

function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const refuse = (res, status, error) => reply(res, status, { error });

function replyBytes(res, headers, bytes) {
  res.writeHead(200, { ...headers, 'content-length': bytes.length });
  res.end(bytes);
}

/* A refusal this code raises on purpose, with a sentence fit for a
 * stranger; anything else becomes a bare 500. `close` marks a body that
 * was too big to drain, so the socket cannot carry another request. */
class Refusal extends Error {
  constructor(status, message, { close = false } = {}) {
    super(message);
    this.status = status;
    this.close = close;
  }
}

const UNUSABLE_ADDRESS = 'That address is not usable.';
const TRACK_GONE = 'That track is not on the board.';
const NOT_JSON = 'That request was not JSON.';
const NOT_AN_OBJECT = 'That request was not a JSON object.';

/* ================================================================== */
/* Reading requests                                                    */
/* ================================================================== */

/*
 * The body as text, bounded. Past the limit the rest is read and thrown
 * away before refusing: killing the socket showed the client a reset
 * instead of the message, and leaving the tail unread broke the next
 * request on a kept-alive connection (a browser's, or Caddy's pool on the
 * VM). Draining stops at four times the limit; past that the refusal goes
 * out at once and the connection closes.
 *
 * 660 kB by default, for a publish: above validate.js's document cap plus
 * the envelope it travels in, so a track that would pass is never refused
 * here for its size.
 */
const DRAIN_FACTOR = 4;

async function bodyText(req, limit = 660_000, tooBig = 'That track is too large to publish.') {
  const kept = [];
  let seen = 0;
  for await (const chunk of req) {
    seen += chunk.length;
    if (seen <= limit) {
      kept.push(chunk);
    } else if (seen > limit * DRAIN_FACTOR) {
      req.pause();
      throw new Refusal(413, tooBig, { close: true });
    }
  }
  if (seen > limit) {
    throw new Refusal(413, tooBig);
  }
  return Buffer.concat(kept).toString('utf8');
}

/* { json } or { unreadable: parser message }; size refusals propagate.
 * Routes word an unreadable body their own way. */
async function bodyJson(req, limit, tooBig) {
  const text = await bodyText(req, limit, tooBig);
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { unreadable: err.message };
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stringOr = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

function pathPart(raw, pattern) {
  try {
    const decoded = decodeURIComponent(raw);
    /* The shape check matters: the file store keys tracks in a plain
     * object, so 'constructor' or '__proto__' would otherwise find
     * something on its prototype. */
    return pattern.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/* The board's own origin as the asker sees it, for the page's links. The
 * forwarded host and scheme are believed only behind a trusted proxy. */
function boardOrigin(req) {
  if (publicOrigin) {
    return publicOrigin;
  }
  const forwarded = (name) => (trustProxy() ? req.headers[name] : undefined);
  const firstOf = (value) => String(value).split(',')[0].trim();
  const host = firstOf(forwarded('x-forwarded-host') || req.headers.host || `127.0.0.1:${port}`);
  if (!/^[A-Za-z0-9.[\]:_-]+$/.test(host)) {
    return `http://127.0.0.1:${port}`;
  }
  const proto = forwarded('x-forwarded-proto');
  return `${proto && firstOf(proto) === 'https' ? 'https' : 'http'}://${host}`;
}

function clientAddress(req) {
  const forwarded = trustProxy() ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  if (forwarded) {
    return forwarded.slice(0, 80);
  }
  return req.socket?.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

/* ================================================================== */
/* Who is asking                                                       */
/* ================================================================== */

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/*
 * An admin is BOARD_ADMIN_TOKEN (a script) or a signed session (a person
 * on the whitelist). Both open the same doors; who it was is returned so a
 * removal can be logged against it.
 */
function adminOf(req) {
  const offered = bearerToken(req);
  if (!offered) {
    return null;
  }
  if (adminToken && sameSecret(offered, adminToken)) {
    return { kind: 'token', email: '' };
  }
  const session = readSession(offered);
  return session ? { kind: 'session', email: session.email, expiresUtc: session.expiresUtc } : null;
}

/* Tickets are open when BUGS_TOKEN is unset. Otherwise the token (header
 * or ?token=) or an admin: whoever may take a track down may read a
 * ticket, without holding a second secret. */
function mayReadTickets(req, url) {
  if (!bugsToken || adminOf(req)) {
    return true;
  }
  return sameSecret(bearerToken(req), bugsToken) || sameSecret(url.searchParams.get('token') || '', bugsToken);
}

/* The sponsors and the link each is handed, for the Admin panel only:
 * the list includes sponsors with no traffic yet, which is commercial,
 * while each sponsor's numbers are public on the statistics tab. */
function sponsorsWithLinks() {
  return sponsorList().map((s) => ({ ...s, link: sponsorLink(simOrigin, s.slug) }));
}

/* ================================================================== */
/* Flood gates                                                         */
/* ================================================================== */

/*
 * Posts per address per route in a sliding ten minutes. Checked before a
 * body is read and spent only after it is accepted, so malformed attempts
 * never lock out the next good one. Process local: a speed bump, not a
 * guarantee. What actually bounds the public tables is elsewhere (one run
 * per pilot per map, closed vocabularies for statistics).
 */
const FLOOD_WINDOW_MS = 10 * 60 * 1000;
const floodLog = new Map();

function overLimit(key, limit = 8) {
  const now = Date.now();
  const recent = (stamps) => stamps.filter((t) => now - t < FLOOD_WINDOW_MS);
  /* Forget quiet addresses once there are many, rather than keeping every
   * address that ever posted. */
  if (floodLog.size > 256) {
    for (const [who, stamps] of floodLog) {
      if (recent(stamps).length === 0) {
        floodLog.delete(who);
      }
    }
  }
  const stamps = recent(floodLog.get(key) || []);
  floodLog.set(key, stamps);
  return stamps.length >= limit;
}

function spend(key) {
  floodLog.set(key, [...(floodLog.get(key) || []), Date.now()]);
}

/* ================================================================== */
/* Statistics state that is not stored                                 */
/* ================================================================== */

/*
 * "Flying now": each flying tab's random handle and when its last flush
 * came, held in memory three minutes and counted. Never stored, never
 * shared between instances; a number called "now" needs no history, and a
 * history of who flew when is what the page promises not to keep.
 */
const FLYING_FOR_MS = 3 * 60 * 1000;
const FLYING_MAX = 4096;
const flying = new Map();

function forgetLanded(now) {
  for (const [tab, at] of flying) {
    if (now - at >= FLYING_FOR_MS) {
      flying.delete(tab);
    }
  }
}

function sawFlying(tab) {
  const now = Date.now();
  /* The sweep only runs on a read, so heartbeats on an unwatched board are
   * capped too, dropping the oldest, which was nearest expiry anyway. */
  if (flying.size >= FLYING_MAX) {
    forgetLanded(now);
    if (flying.size >= FLYING_MAX) {
      flying.delete(flying.keys().next().value);
    }
  }
  flying.delete(tab);
  flying.set(tab, now);
}

function flyingCount() {
  forgetLanded(Date.now());
  return flying.size;
}

/*
 * GET /api/stats is cached twenty seconds here and in the browser: every
 * reader polls every thirty seconds and the answer only changes by
 * counting, so a hundred readers cost what one does and each still sees
 * their own effect within a tick. Thirty days is the only window.
 */
const STATS_CACHE_MS = 20_000;
const STATS_DAYS = 30;
let statsCache = { at: 0, body: '' };

/* A club night is thirty pilots behind one address, each flushing once a
 * minute; this allows fifty. It stops a script hammering the database,
 * nothing more. */
const STATS_EVENTS_PER_WINDOW = 600;

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

/* A bug report: 40 kB of words and context plus four screenshots at their
 * base64 cap with a data: prefix each, derived from validate.js's caps so
 * it cannot fall under them. */
const BUG_BODY_MAX = 40_000 + MAX_BUG_IMAGES * (Math.ceil(MAX_BUG_IMAGE_BYTES / 3) * 4 + 64);

async function trackGet({ res, params }, read, missing = TRACK_GONE) {
  const id = pathPart(params[0], TRACK_ID_RE);
  if (!id) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const found = await read(id);
  return found ? reply(res, 200, found) : refuse(res, 404, missing);
}

/*
 * The one route that reads a password. Every failure gets one sentence,
 * and checkPassword spends the same scrypt run on an unknown address, so
 * neither the words nor the timing say which addresses are admins.
 * Failures (only) spend the flood allowance.
 */
async function signIn({ req, res }) {
  const gate = `admin:${clientAddress(req)}`;
  if (overLimit(gate)) {
    return refuse(res, 429, 'Too many sign in attempts from here. Try again in a few minutes.');
  }
  if (!adminCount()) {
    return refuse(res, 503, 'This board has no admin accounts.');
  }
  const { json, unreadable } = await bodyJson(req, 4_000, 'That sign in was too large.');
  if (unreadable !== undefined) {
    return refuse(res, 400, NOT_JSON);
  }
  if (!isPlainObject(json)) {
    return refuse(res, 400, NOT_AN_OBJECT);
  }
  const email = normaliseEmail(json.email);
  const password = stringOr(json.password);
  const admin = email && password && password.length <= PASSWORD_MAX ? checkPassword(email, password) : null;
  if (!admin) {
    spend(gate);
    return refuse(res, 401, 'That email and password do not open this board.');
  }
  const token = mintSession(admin);
  return reply(res, 200, {
    token, email: admin, expiresUtc: readSession(token)?.expiresUtc ?? null, sponsors: sponsorsWithLinks(),
  });
}

/* The Admin panel asks on load with the token it kept, so a reload needs
 * no second sign in and a revoked token is found out quietly. */
function whoAmI({ req, res }) {
  const admin = adminOf(req);
  if (!admin) {
    return refuse(res, 401, 'Not signed in.');
  }
  return reply(res, 200, {
    email: admin.email, kind: admin.kind, expiresUtc: admin.expiresUtc || null, sponsors: sponsorsWithLinks(),
  });
}

function noContent(res) {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

/*
 * One event added to a daily total. No cookie, no address stored (it is
 * read for the flood gate and dropped), no tab handle stored, nothing finer
 * than a day. A browser that sends Global Privacy Control is answered the
 * same 204 as an accepted event and nothing is counted: a different
 * answer would tell a script the signal was seen. A beacon cannot set a
 * content type, so none is required.
 *
 * The country is the edge's two letters, believed only behind a trusted
 * proxy: x-fdfpv-country (set by the simulator's edge Worker) and then
 * Cloudflare's own cf-ipcountry, which the Worker forwards either way and
 * which saved the first day of counts when the Worker in front was old.
 */
async function countEvent({ req, res }) {
  if (String(req.headers['sec-gpc'] || '') === '1') {
    return noContent(res);
  }
  const gate = `stats:${clientAddress(req)}`;
  if (overLimit(gate, STATS_EVENTS_PER_WINDOW)) {
    return refuse(res, 429, 'Too many events from here.');
  }
  const { json, unreadable } = await bodyJson(req, 2_000, 'That event is too large.');
  if (unreadable !== undefined) {
    return refuse(res, 400, 'That event was not readable.');
  }
  const checked = inspectStatsEvent(json, sourceKey);
  if (checked.error) {
    return refuse(res, 400, checked.error);
  }
  spend(gate);
  if (checked.event.kind === 'flush') {
    sawFlying(checked.event.tab);
  }
  const edge = trustProxy() ? (req.headers['x-fdfpv-country'] || req.headers['cf-ipcountry']) : '';
  await store.recordStats(checked.event, { day: statsDay(), country: normaliseCountry(edge) });
  return noContent(res);
}

async function readCounters({ res }) {
  const now = Date.now();
  if (!statsCache.body || now - statsCache.at >= STATS_CACHE_MS) {
    const [counts, board] = await Promise.all([store.readStats({ days: STATS_DAYS, now }), store.boardFacts()]);
    statsCache = {
      at: now,
      body: JSON.stringify({
        ...counts,
        sources: counts.sources.map((row) => ({ ...row, name: sponsorName(row.key) })),
        live: { flying: flyingCount() },
        board,
      }),
    };
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${Math.round(STATS_CACHE_MS / 1000)}`,
  });
  res.end(statsCache.body);
}

/* The tag vocabulary rides with the list so the page offers exactly what
 * this board accepts; validate.js is the copy of record for both. */
async function listTracks({ res }) {
  reply(res, 200, { tracks: await store.listTracks(), tags: TAGS });
}

/* A card animation, as an image. Hard cached: the card's src carries
 * gifUtc, so a replaced animation is a new address. */
async function animation({ res, params }) {
  const id = pathPart(params[0], TRACK_ID_RE);
  if (!id) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const found = await store.getGif(id);
  if (!found) {
    return refuse(res, 404, 'That track has no animation.');
  }
  return replyBytes(res, { 'content-type': 'image/gif', 'cache-control': 'public, max-age=31536000, immutable' }, found.bytes);
}

/*
 * Uploading one: the publishing browser's edit key, or an admin (for the
 * rooms published from browsers nobody still has). POST, because the
 * CORS grant names GET, POST and OPTIONS and widening it buys nothing.
 * The class rule is read off the stored document, not the upload.
 */
async function uploadAnimation({ req, res, params }) {
  const id = pathPart(params[0], TRACK_ID_RE);
  if (!id) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const { json, unreadable } = await bodyJson(req, MAX_GIF_BASE64_CHARS + 4_000, 'That animation is too large for this board.');
  if (unreadable !== undefined) {
    return refuse(res, 400, 'That upload was not readable.');
  }
  const held = await store.getDocument(id);
  if (!held) {
    return refuse(res, 404, TRACK_GONE);
  }
  /* `null` and a list parse as JSON too; neither carries an animation. */
  const upload = isPlainObject(json) ? json : {};
  const checked = inspectGif({ base64: upload.gif, document: held.document });
  if (checked.error) {
    return refuse(res, 400, checked.error);
  }
  const done = await store.setGif({
    id, bytes: checked.bytes, editKey: stringOr(upload.editKey), admin: Boolean(adminOf(req)),
  });
  if (!done) {
    return refuse(res, 404, TRACK_GONE);
  }
  if (done.error) {
    return refuse(res, done.status || 400, done.error);
  }
  return reply(res, 200, { id, gifUtc: done.gifUtc, bytes: checked.bytes.length });
}

/*
 * Taking a track and every time on it off the board: admin only, never an
 * edit key (src/store.js says why). Authority is checked before the id so
 * a stranger learns nothing about which ids exist. The log line is the
 * only one this server writes about a write, because it is the only write
 * that destroys other people's work.
 */
async function removeTrack({ req, res, params }) {
  const admin = adminOf(req);
  if (!admin) {
    return refuse(res, 403, 'Removing a track from this board needs an admin.');
  }
  const id = pathPart(params[0], TRACK_ID_RE);
  if (!id) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const gone = await store.removeTrack(id);
  if (!gone) {
    return refuse(res, 404, TRACK_GONE);
  }
  console.log(`removed ${gone.id} "${gone.name}" by ${gone.author}, ${gone.times} time(s), by ${admin.email || 'BOARD_ADMIN_TOKEN'}`);
  return reply(res, 200, {
    id: gone.id, name: gone.name, author: gone.author, times: gone.times,
  });
}

/*
 * A publish. Tags travel in the envelope beside the author, not in the
 * document: they are the author's intent, not layout, so they need no
 * schema version, stay out of the layout hash, and an old builder or an
 * old board simply sends or ignores them.
 */
async function publish({ req, res }) {
  const { json, unreadable } = await bodyJson(req);
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  if (!isPlainObject(json)) {
    return refuse(res, 400, NOT_AN_OBJECT);
  }
  const author = normaliseName(json.author);
  if (!author) {
    return refuse(res, 400, 'A published track needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.');
  }
  const inspected = inspectDocument(json.document);
  if (inspected.error) {
    return refuse(res, 400, inspected.error);
  }
  const tagged = inspectTags(json.tags);
  if (tagged.error) {
    return refuse(res, 400, tagged.error);
  }
  const result = await store.publish({
    inspected, author, editKey: stringOr(json.editKey), tags: tagged.tags,
  });
  if (result.error) {
    return reply(res, result.status || 400, { error: result.error, conflict: Boolean(result.conflict) });
  }
  return reply(res, result.updated ? 200 : 201, result);
}

/*
 * A time. In order: the body's shape, the ghost (required, and refused
 * loudly when malformed: the simulator proves its encoding before sending,
 * so a bad blob is a bug to hear about), the address, the aircraft (a
 * plane's lap files on the plane board), the signature over exactly this
 * post (microseconds, so before the lap), the lap itself through the
 * simulator's own gate detector against the track as published, and then
 * the name claim. The three lap total is optional and never refuses.
 */
async function postTime({ req, res, params }) {
  const { json, unreadable } = await bodyJson(req, 660_000, 'That time is too large to post.');
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  if (!isPlainObject(json)) {
    return refuse(res, 400, NOT_AN_OBJECT);
  }
  const name = normaliseName(json.name);
  const lapMs = normaliseLapMs(json.lapMs);
  if (!name) {
    return refuse(res, 400, 'A time on the board needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.');
  }
  if (lapMs === null) {
    return refuse(res, 400, 'That lap time is not usable.');
  }
  const ghost = inspectGhost(json.ghost, lapMs);
  if (ghost.error) {
    return refuse(res, 400, ghost.error);
  }
  if (!ghost.ghost) {
    return refuse(res, 400, 'A time on the board comes with its ghost. The simulator records one for every lap; post from there.');
  }
  const trackId = pathPart(params[0], TRACK_ID_RE);
  if (!trackId) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const craft = inspectCraft(json.craft);
  if (craft.error) {
    return refuse(res, 400, craft.error);
  }
  const auth = inspectAuth(json);
  if (auth.error) {
    return refuse(res, 400, auth.error);
  }
  const signed = await verifyTimeSignature({
    key: auth.key, sig: auth.sig, trackId, lapMs, ghost: ghost.ghost, craft: craft.craft,
  });
  if (!signed) {
    return refuse(res, 401, 'That signature does not match this post.');
  }
  const published = await store.getDocument(trackId);
  if (!published) {
    return refuse(res, 404, 'No track with that id is on the board.');
  }
  const verdict = checkLap(published.document, new Uint8Array(Buffer.from(ghost.ghost, 'base64')), lapMs, craft.craft);
  if (!verdict.ok) {
    return refuse(res, 422, `That lap does not hold up against the track: ${verdict.reason}.`);
  }
  const claim = await store.claimName(name, auth.key);
  if (claim.error) {
    return refuse(res, claim.status || 403, claim.error);
  }
  const result = await store.addTime({
    trackId, name, lapMs, threeMs: normaliseThreeMs(json.threeMs, lapMs), ghost: ghost.ghost, key: auth.key, craft: craft.craft,
  });
  if (result.error) {
    return refuse(res, result.status || 400, result.error);
  }
  return reply(res, 201, result);
}

async function ghostOf({ res, params }) {
  const trackId = pathPart(params[0], TRACK_ID_RE);
  const timeId = pathPart(params[1], TIME_ID_RE);
  if (!trackId || !timeId) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const row = await store.getGhost(trackId, timeId);
  if (!row) {
    return refuse(res, 404, 'That time is not on the board.');
  }
  if (!row.ghost) {
    return refuse(res, 404, 'That time was posted without a ghost.');
  }
  return reply(res, 200, row);
}

/*
 * A name claimed ahead of any time, or every name and time of one pilot
 * key handed to another (src/pilotkeys.js says when). Twenty a window per
 * address: a pilot picks a callsign or signs in a computer now and then.
 */
async function pilotKeys({ req, res, url }) {
  const gate = `pilot:${clientAddress(req)}`;
  if (overLimit(gate, 20)) {
    return refuse(res, 429, 'Too many name changes from here. Try again shortly.');
  }
  const { json, unreadable } = await bodyJson(req, 4_000, 'That request is too large.');
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  spend(gate);
  if (!json || typeof json !== 'object') {
    return refuse(res, 400, 'That request was not usable.');
  }
  return url.pathname.replace(/\/+$/, '') === '/api/pilots' ? claimName(res, json) : linkKeys(res, json);
}

async function claimName(res, json) {
  const name = normaliseName(json.name);
  if (!name) {
    return refuse(res, 400, 'A pilot name is 2 to 24 letters, numbers, spaces, dots, underscores or hyphens.');
  }
  const auth = inspectAuth(json);
  if (auth.error) {
    return refuse(res, 400, auth.error);
  }
  if (!(await verifyKeySignature({ key: auth.key, sig: auth.sig, message: nameClaimMessage(name) }))) {
    return refuse(res, 401, 'That signature does not match this name.');
  }
  const claim = await store.claimName(name, auth.key);
  if (claim.error) {
    return refuse(res, claim.status || 403, claim.error);
  }
  return reply(res, claim.claimed ? 201 : 200, { name, claimed: claim.claimed });
}

async function linkKeys(res, json) {
  const from = inspectAuth({ key: json.from, sig: json.fromSig });
  const to = inspectAuth({ key: json.to, sig: json.toSig });
  if (from.error || to.error || from.key === to.key) {
    return refuse(res, 400, 'A link names two different pilot keys, each with its signature.');
  }
  const message = keyLinkMessage(from.key, to.key);
  const bothSigned = await verifyKeySignature({ key: from.key, sig: from.sig, message })
    && await verifyKeySignature({ key: to.key, sig: to.sig, message });
  if (!bothSigned) {
    return refuse(res, 401, 'Both pilot keys must sign a link.');
  }
  return reply(res, 200, await store.moveKey(from.key, to.key));
}

async function listRuns({ res, url }) {
  const map = url.searchParams.get('map') || '';
  if (map && !RUN_MAPS.includes(map) && !RETIRED_RUN_MAPS.includes(map)) {
    return refuse(res, 400, 'That is not a map this board keeps scores for.');
  }
  return reply(res, 200, { runs: await store.listRuns({ map }), tags: TAGS, maps: RUN_MAPS });
}

/* A public write with no owner, so it has the flood gate; what really
 * bounds the table is one row per pilot per map. A run that did not beat
 * the pilot's own is a 200 with improved: false, not a 201. */
async function postRun({ req, res }) {
  const gate = `run:${clientAddress(req)}`;
  if (overLimit(gate)) {
    return refuse(res, 429, 'Too many runs posted from here. Fly another and try again shortly.');
  }
  const { json, unreadable } = await bodyJson(req, 20_000, 'That run is too large to post.');
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  const checked = inspectRun(json);
  if (checked.error) {
    return refuse(res, 400, checked.error);
  }
  spend(gate);
  const result = await store.addRun(checked.run);
  if (result.error) {
    return refuse(res, result.status || 400, result.error);
  }
  return reply(res, result.improved ? 201 : 200, result);
}

async function listTickets({ req, res, url }) {
  if (!mayReadTickets(req, url)) {
    return refuse(res, 401, 'A token is needed to read tickets.');
  }
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  if (status && !BUG_STATUSES.includes(status)) {
    return refuse(res, 400, 'Status is open, in_progress, fixed, wontfix or duplicate.');
  }
  if (kind && !BUG_KINDS.includes(kind)) {
    return refuse(res, 400, 'Kind is crash, blocking, wrong, visual, feel or other.');
  }
  return reply(res, 200, { bugs: await store.listBugs({ status, kind, limit: url.searchParams.get('limit') }) });
}

async function fileTicket({ req, res }) {
  const gate = clientAddress(req);
  if (overLimit(gate)) {
    return refuse(res, 429, 'Too many reports from here. Try again in a few minutes.');
  }
  const { json, unreadable } = await bodyJson(req, BUG_BODY_MAX, 'That report is too large.');
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  const checked = inspectBugCreate(json);
  if (checked.error) {
    return refuse(res, 400, checked.error);
  }
  spend(gate);
  return reply(res, 201, await store.addBug(checked));
}

/*
 * A ticket's screenshot, behind the ticket's own gate, fetched by the
 * inbox with the bearer header and shown from a blob (an <img src> could
 * not carry the header, and a query token lands in history). The type is
 * the one read off the bytes, and nosniff holds the browser to it.
 */
async function ticketImage({ req, res, url, params }) {
  if (!mayReadTickets(req, url)) {
    return refuse(res, 401, 'A token is needed to read tickets.');
  }
  const id = pathPart(params[0], BUG_ID_RE);
  const n = Number(params[1]);
  if (!id || !Number.isInteger(n) || n < 1 || n > MAX_BUG_IMAGES) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  const shot = await store.getBugImage(id, n);
  if (!shot) {
    return refuse(res, 404, 'That ticket has no such image.');
  }
  return replyBytes(res, { 'content-type': shot.type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }, shot.bytes);
}

async function ticket({ req, res, url, params }) {
  if (!mayReadTickets(req, url)) {
    return refuse(res, 401, 'A token is needed to read or update tickets.');
  }
  const id = pathPart(params[0], BUG_ID_RE);
  if (!id) {
    return refuse(res, 400, UNUSABLE_ADDRESS);
  }
  if (req.method === 'GET') {
    const found = await store.getBug(id);
    return found ? reply(res, 200, found) : refuse(res, 404, 'That ticket is not on the board.');
  }
  const { json, unreadable } = await bodyJson(req, 20_000, 'That update is too large.');
  if (unreadable !== undefined) {
    return refuse(res, 400, unreadable || NOT_JSON);
  }
  const patch = inspectBugPatch(json);
  if (patch.error) {
    return refuse(res, 400, patch.error);
  }
  const result = await store.updateBug(id, patch);
  if (result.error) {
    return refuse(res, result.status || 400, result.error);
  }
  return reply(res, 200, result);
}

/*
 * The API, first match wins. A path is compared without trailing slashes;
 * `methods` lists what a route answers, and anything else falls through to
 * the 404 at the end, as an unknown path does.
 */
const ROUTES = [
  [['GET'], '/api/health', ({ res }) => reply(res, 200, { ok: true, store: store.kind })],
  [['GET'], '/api/version', ({ res }) => reply(res, 200, revision)],
  [['GET'], '/api/config', ({ req, res }) => reply(res, 200, { simOrigin, boardOrigin: boardOrigin(req) })],
  [['POST'], '/api/admin/login', signIn],
  [['GET'], '/api/admin/session', whoAmI],
  [['POST'], '/api/stats/events', countEvent],
  [['GET'], '/api/stats', readCounters],
  [['GET'], '/api/tracks', listTracks],
  [['GET'], /^\/api\/tracks\/([^/]+)$/, (ctx) => trackGet(ctx, (id) => store.getTrack(id))],
  [['GET'], /^\/api\/tracks\/([^/]+)\/document$/, (ctx) => trackGet(ctx, (id) => store.getDocument(id))],
  [['GET'], /^\/api\/tracks\/([^/]+)\/gif$/, animation],
  [['POST'], /^\/api\/tracks\/([^/]+)\/gif$/, uploadAnimation],
  [['POST'], /^\/api\/tracks\/([^/]+)\/remove$/, removeTrack],
  [['POST'], '/api/tracks', publish],
  [['POST'], /^\/api\/tracks\/([^/]+)\/times$/, postTime],
  [['GET'], /^\/api\/tracks\/([^/]+)\/times\/([^/]+)\/ghost$/, ghostOf],
  [['POST'], /^\/api\/pilots(\/link)?$/, pilotKeys],
  [['GET'], '/api/runs', listRuns],
  [['POST'], '/api/runs', postRun],
  [['GET'], '/api/bugs', listTickets],
  [['POST'], '/api/bugs', fileTicket],
  [['GET'], /^\/api\/bugs\/([^/]+)\/images\/([0-9]+)$/, ticketImage],
  [['GET', 'POST'], /^\/api\/bugs\/([^/]+)$/, ticket],
];

function routeFor(method, path) {
  for (const [methods, pattern, handler] of ROUTES) {
    const params = typeof pattern === 'string' ? (pattern === path ? [] : null) : path.match(pattern)?.slice(1);
    if (params && methods.includes(method)) {
      return { handler, params };
    }
  }
  return null;
}

async function api(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = routeFor(req.method, path);
  if (!route) {
    return refuse(res, 404, 'Nothing at that address.');
  }
  return route.handler({
    req, res, url, params: route.params,
  });
}

/* ================================================================== */
/* The page                                                            */
/* ================================================================== */

async function staticFile(res, url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return reply(res, 400, 'bad path', 'text/plain; charset=utf-8');
  }
  let rel = normalize(decoded).replace(/^[/\\]+/, '');
  if (rel === '' || rel === '.') {
    rel = 'index.html';
  } else if (rel === 'bugs') {
    rel = 'bugs.html';
  }
  const file = resolve(publicDir, rel);
  const inside = file === publicDir || file.startsWith(publicDir + sep);
  if (!inside || relative(publicDir, file).split(sep).includes('..')) {
    return reply(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  }
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return reply(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  return res.end(bytes);
}

const server = http.createServer(async (req, res) => {
  allowOrigin(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      refuse(res, 400, UNUSABLE_ADDRESS);
      return;
    }
    await (url.pathname.startsWith('/api/') ? api(req, res, url) : staticFile(res, url));
  } catch (err) {
    /* Only a Refusal has a message meant for a stranger. Anything else is
     * a stack from pg or the filesystem, and echoing it would describe the
     * schema and the paths to the internet. */
    if (err instanceof Refusal) {
      if (err.close) {
        res.setHeader('connection', 'close');
      }
      refuse(res, err.status, err.message);
      return;
    }
    console.error(err);
    refuse(res, 500, 'The board failed.');
  }
});

/* Live rooms share the port as a WebSocket upgrade; see live.js. */
attachLive(server, store);

if (env.BOARD_LISTEN !== '0') {
  server.listen(port, listenHost, () => {
    console.log(`FDFPV leaderboard: http://127.0.0.1:${port}/`);
    console.log(`Store: ${store.kind}. Simulator: ${simOrigin}`);
  });
}

export { server, store };
