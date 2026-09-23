/*
 * server.js: the public board.
 *
 * A static page and a small JSON API. The page lists every published
 * track. Expanding one shows its times. Fly opens the simulator in
 * another tab with ?share=id, which is the only link the two sites
 * need. Publish and post-time are the writes. Testers also POST bug
 * tickets here; agents GET them.
 *
 * One person can sign in: an address on the whitelist in src/admin.js,
 * which is what the Admin button on the page opens. That is the only
 * credential this API reads, it is never a cookie, and it exists because
 * taking a track off the board used to mean curl and a token.
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

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openStore } from './store.js';
import {
  adminCount, checkPassword, mintSession, normaliseEmail, readSession, PASSWORD_MAX,
} from './admin.js';
import {
  inspectBugCreate, inspectBugPatch, inspectDocument, inspectGhost, inspectGif, inspectRun,
  inspectStatsEvent, inspectTags, normaliseCountry, normaliseLapMs, normaliseName,
  normaliseThreeMs, statsDay,
  BUG_ID_RE, BUG_KINDS, BUG_STATUSES, MAX_GIF_BASE64_CHARS, RUN_MAPS, TAGS,
  TIME_ID_RE, TRACK_ID_RE,
} from './validate.js';
import { sourceKey, sponsorLink, sponsorList, sponsorName } from './sponsors.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3100);
const simOrigin = (process.env.SIM_ORIGIN || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const boardPublic = (process.env.BOARD_PUBLIC_ORIGIN || '').replace(/\/+$/, '');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  /* The credits roll's pilot faces are photographs, so they are JPEG.
     Without a row here they go out as application/octet-stream and the
     one page that shows a person's face shows four broken images. */
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
]);

const store = await openStore();
const bugsToken = String(process.env.BUGS_TOKEN || '');
/*
 * A way past an edit key, and there are two things it opens.
 *
 * It exists because the rooms already on the board were published from
 * browsers nobody still has, and the alternative to a token was leaving
 * them with an empty plan for ever: that is the animation upload. Taking a
 * track off the board is the other, and it has no edit key path at all.
 *
 * IT IS NO LONGER THE ONLY WAY PAST, and that changed with the admin login
 * in src/admin.js. Unset used to mean nothing on the board could ever be
 * removed; now it means no SCRIPT can remove anything, and a person on the
 * whitelist still can once they have signed in. That is the point of the
 * login, and it is written here because the old sentence was the kind
 * somebody relies on without checking whether it is still true.
 *
 * It stays because a script has no browser: scripts/boardgif.js in the
 * simulator's repository holds this and nothing else.
 */
const adminToken = String(process.env.BOARD_ADMIN_TOKEN || '');

/* ------------------------------------------------------------------ */
/* Site statistics                                                     */
/* ------------------------------------------------------------------ */

/*
 * HOW MANY ARE FLYING RIGHT NOW, and it is the one number on the statistics
 * page that is not a stored counter.
 *
 * A flying tab sends a heartbeat once a minute carrying a random handle it
 * made at page load. This map holds those handles for three minutes and
 * counts them. It is IN MEMORY AND NOWHERE ELSE: no table, no file, no
 * column, nothing that survives a restart, which is the point. A number
 * called "now" does not need a history and a history of who was flying when
 * is exactly the thing this page promises not to keep.
 *
 * It is process local, so on a host running two instances each would count
 * its own half, and on Render's free tier it starts empty after a sleep.
 * Both are undercounts of a number that is decoration on a page of counters,
 * and both are better than a shared table keyed by a per browser handle.
 */
const FLYING_WINDOW_MS = 3 * 60 * 1000;
const FLYING_MAX_TABS = 4096;
const flyingTabs = new Map();

function sweepFlying(now) {
  for (const [tab, at] of flyingTabs) {
    if (now - at >= FLYING_WINDOW_MS) {
      flyingTabs.delete(tab);
    }
  }
}

function markFlying(tab) {
  const now = Date.now();
  /* A cap as well as a sweep, because the sweep only runs on a read and a
   * board nobody is looking at still takes heartbeats. Dropping the oldest
   * is right: it is the one closest to expiring anyway. */
  if (flyingTabs.size >= FLYING_MAX_TABS) {
    sweepFlying(now);
    if (flyingTabs.size >= FLYING_MAX_TABS) {
      flyingTabs.delete(flyingTabs.keys().next().value);
    }
  }
  flyingTabs.delete(tab);
  flyingTabs.set(tab, now);
}

function flyingNow() {
  const now = Date.now();
  sweepFlying(now);
  return flyingTabs.size;
}

/*
 * The read is cached for twenty seconds, and it is the second response on
 * this board that is not no-store.
 *
 * Every visitor on the statistics tab polls this every thirty seconds while
 * they are looking at it, and the answer is four aggregate queries over
 * tables that only change by counting. Twenty seconds is under the poll
 * interval, so a reader still sees their own effect on the numbers within
 * one tick, and it is enough that a hundred readers cost the database what
 * one does.
 *
 * STATS_WINDOW_DAYS is the chart's width and the only window this route
 * offers. A `?days=` would be a second thing to validate and a second cache
 * key for a page that asks for one number.
 */
const STATS_CACHE_MS = 20_000;
const STATS_WINDOW_DAYS = 30;
let statsCache = { at: 0, body: '' };

/*
 * How many events one address may post in ten minutes.
 *
 * A flying tab spends one a minute, so a PILOT never gets near this. A
 * ROOM does: a club night is thirty pilots behind one public address, each
 * flushing once a minute, which is three hundred in ten minutes, and a
 * gate of two hundred would have silenced the room seven minutes in. Six
 * hundred is fifty pilots on one address, which is a big night.
 *
 * It is not the defence against a stranger inflating a public number, and
 * it is not meant to be: the bounds on a flush and the fold on every
 * dimension are, and the page says it counts what it is told. This stops a
 * script hammering the database, and nothing else.
 */
const STATS_FLOOD_LIMIT = 600;

/*
 * GLOBAL PRIVACY CONTROL, and it is honoured on the server as well as in
 * the page.
 *
 * The client checks navigator.globalPrivacyControl and sends nothing, so
 * this is the belt to that braces: a browser that sets the header without
 * exposing the property, an extension that adds it, or a page of this
 * product that has not learned to check yet. The answer is the same 204 an
 * accepted event gets, deliberately, because a different status would tell
 * a script whether the signal was seen and there is nothing here to tell.
 */
/*
 * The sponsors, with the link each one is given, for the Admin panel.
 *
 * Admin only, and the reason is not that a slug is secret: it is printed on
 * a poster and it arrives in a query string. It is that the LIST is the set
 * of sponsors including the ones with no traffic yet, which is a commercial
 * fact rather than a public one. The per sponsor NUMBERS are public on the
 * statistics tab, deliberately, because a sponsor should be able to check
 * them without asking anybody.
 */
function adminSponsors() {
  return sponsorList().map((s) => ({ ...s, link: sponsorLink(simOrigin, s.slug) }));
}

function privacySignalled(req) {
  return String(req.headers['sec-gpc'] || '') === '1';
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/*
 * WHO IS ASKING, and there are two kinds of admin now.
 *
 * BOARD_ADMIN_TOKEN is a string in an environment. It is what
 * scripts/boardgif.js in the simulator's repository holds, and a script has
 * no browser to sign in from, so it stays exactly as it was.
 *
 * A session is a PERSON: an address on the whitelist in src/admin.js that
 * typed its password into the board's own Admin panel recently. That is the
 * one a browser can have, and it is why the board finally has an admin
 * screen rather than a curl command in the README.
 *
 * Both open the same doors. The identity is returned rather than a boolean
 * so that anything wanting to say WHO removed a track has it to hand.
 */
function adminIdentity(req) {
  const offered = bearer(req);
  if (!offered) {
    return null;
  }
  if (adminToken && sameSecret(offered, adminToken)) {
    return { kind: 'token', email: '' };
  }
  const session = readSession(offered);
  return session ? { kind: 'session', email: session.email, expiresUtc: session.expiresUtc } : null;
}

function adminAuthorized(req) {
  return Boolean(adminIdentity(req));
}
const bugHits = new Map();

/*
 * The board is public and no response here is AMBIENTLY authenticated:
 * there is no cookie, no session cookie and no HTTP auth realm, and
 * access-control-allow-credentials is never sent. Reflecting the request
 * origin is therefore still the same grant as '*', which is the invariant
 * this function exists to keep.
 *
 * The admin login does not change that, and the reason is worth writing
 * down. Its token lives in the board page's own sessionStorage and is
 * attached by that page's script, by hand, to the requests that need it. A
 * browser never sends it on anybody else's behalf. So another site's script
 * calling this API gets exactly what curl gets, which is an unauthenticated
 * request, and the reflected origin hands it nothing it did not already
 * have.
 *
 * What would break the invariant is a cookie, so do not add one. The moment
 * a credential is sent by the browser rather than by the page, reflecting
 * the origin becomes a standing grant to every site on the internet, and
 * this header has to name one origin instead.
 */
function cors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('vary', 'origin');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function requestOrigin(req) {
  if (boardPublic) {
    return boardPublic;
  }
  const trust = process.env.BOARD_TRUST_PROXY === '1';
  const rawHost = (trust && req.headers['x-forwarded-host']) || req.headers.host || `127.0.0.1:${port}`;
  const host = String(rawHost).split(',')[0].trim();
  if (!/^[A-Za-z0-9.[\]:_-]+$/.test(host)) {
    return `http://127.0.0.1:${port}`;
  }
  const proto = (trust && req.headers['x-forwarded-proto'])
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : 'http';
  const scheme = proto === 'https' ? 'https' : 'http';
  return `${scheme}://${host}`;
}

function decodePathPart(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return null;
  }
}

/*
 * A track id out of the path, or null. The shape check is not decoration.
 * The file store keeps its tracks in a plain object, so an id of
 * 'constructor' or '__proto__' used to find something on Object.prototype:
 * the lookup came back truthy and the request went on to read a track out
 * of a function, which is a 500 rather than the 404 it should be. Every id
 * the board holds passed this same expression through inspectDocument at
 * publish time, so nothing real can fail it.
 */
function trackIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && TRACK_ID_RE.test(id) ? id : null;
}

function bugIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && BUG_ID_RE.test(id) ? id : null;
}

function timeIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && TIME_ID_RE.test(id) ? id : null;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function bugsAuthorized(req, url) {
  if (!bugsToken) {
    return true;
  }
  /* An admin of the board reads the inbox without a second secret. Somebody
   * trusted to take a track off the board is trusted to read a bug ticket,
   * and making them hold two strings to do one job is how one of the two
   * ends up written down somewhere it should not be. */
  if (adminAuthorized(req)) {
    return true;
  }
  const query = url.searchParams.get('token') || '';
  return sameSecret(bearer(req), bugsToken) || sameSecret(query, bugsToken);
}

function clientIp(req) {
  if (process.env.BOARD_TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) {
      return forwarded.slice(0, 80);
    }
  }
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

/*
 * The flood gate, in two halves so a REJECTED post does not spend the
 * allowance: the check runs before the body is read, the record only after
 * validation passes. In one piece, eight malformed attempts (an over-long
 * title, say) locked a tester out for ten minutes without a single ticket
 * landing. Spam of invalid posts stays free, and stays harmless: it stores
 * nothing.
 *
 * `who` is the client address with the route folded into it, so a tester
 * filing bugs and a pilot posting scores do not spend each other's
 * allowance. It was written for bugs and the freestyle board is the second
 * caller: a public write with no owner and no edit key, which is the same
 * shape of exposure and wants the same gate.
 *
 * It is process local, so on a host that runs two instances or spins one
 * down it is a speed bump rather than a guarantee. What does the real work
 * on the freestyle board is that a pilot holds ONE row per map: see
 * addRunUnlocked in src/store.js.
 */
/*
 * `limit` is an argument because the statistics route is a different shape
 * of caller: a tab that is flying sends one heartbeat a minute on purpose,
 * so eight in ten minutes would silence an honest pilot after eight
 * minutes. Its allowance is set where it is spent, at the route.
 */
function bugFlooded(ip, limit = 8) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  /* The map used to keep every IP that ever posted, forever; a stale entry
   * was only dropped when that same IP came back. Sweep the whole map once
   * it grows, which on this board's traffic is almost never. */
  if (bugHits.size > 256) {
    for (const [who, times] of bugHits) {
      if (!times.some((t) => now - t < windowMs)) {
        bugHits.delete(who);
      }
    }
  }
  const hits = (bugHits.get(ip) || []).filter((t) => now - t < windowMs);
  bugHits.set(ip, hits);
  return hits.length >= limit;
}

function recordBugHit(ip) {
  const hits = bugHits.get(ip) || [];
  hits.push(Date.now());
  bugHits.set(ip, hits);
}

/*
 * 660_000, up from 500_000. The publish route is the only caller that takes
 * the default, and what it carries is a document capped at MAX_DOCUMENT_CHARS
 * in validate.js, which grew when a track went from one sponsor's logo to
 * five. This has to stay above that cap plus the envelope the document
 * travels in (author, edit key, JSON string escaping), or a track that
 * validate.js would accept is refused here before anything reads it, and
 * the message would blame its size rather than this number. The other two
 * callers pass their own, much smaller, limits.
 *
 * tooBig is the message for THIS route's payload. It used to be hardcoded
 * to the publish wording, so a tester whose bug context ran long was told
 * their track was too large to publish, from a form with no track in it.
 */
async function readBody(req, limit = 660_000, tooBig = 'That track is too large to publish.') {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      /* Pause, do not destroy. Killing the socket here meant the client saw
       * a connection reset instead of the message, so an oversized publish
       * looked like the board being down. The error path answers, and the
       * request is left for Node to tear down after the response. */
      req.pause();
      const err = new Error(tooBig);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/api/health') {
    send(res, 200, { ok: true, store: store.kind });
    return;
  }

  if (req.method === 'GET' && path === '/api/config') {
    send(res, 200, {
      simOrigin,
      boardOrigin: requestOrigin(req),
    });
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Signing in                                                         */
  /* ---------------------------------------------------------------- */

  /*
   * THE ONE ROUTE ON THIS BOARD THAT READS A PASSWORD.
   *
   * An address off the whitelist in src/admin.js, its password, and a
   * signed token back. The token is what the Admin panel on the board's own
   * page then sends on the admin routes, and it expires on its own.
   *
   * ONE MESSAGE FOR EVERY FAILURE, deliberately. A wrong password, an
   * address that is not an admin and an address that is not an address all
   * answer the same sentence, so this route cannot be asked which addresses
   * are worth attacking. checkPassword runs scrypt against a decoy record
   * for an unknown address for the same reason, so the answers take about
   * the same time as well as saying the same thing.
   *
   * Rate limited on the same gate the bug form and the freestyle board use,
   * and recorded only on a FAILURE: an admin signing in twice in a morning
   * is not spending an allowance, and somebody working through a word list
   * is. Process local, so it is a speed bump rather than a guarantee; what
   * does the real work is scrypt, which makes each guess cost tens of
   * milliseconds whether it is made here or offline.
   */
  if (req.method === 'POST' && path === '/api/admin/login') {
    const ip = clientIp(req);
    if (bugFlooded(`admin:${ip}`)) {
      send(res, 429, { error: 'Too many sign in attempts from here. Try again in a few minutes.' });
      return;
    }
    if (!adminCount()) {
      send(res, 503, { error: 'This board has no admin accounts.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 4_000, 'That sign in was too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: 'That request was not JSON.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'That request was not a JSON object.' });
      return;
    }
    const email = normaliseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const who = (email && password && password.length <= PASSWORD_MAX)
      ? checkPassword(email, password)
      : null;
    if (!who) {
      recordBugHit(`admin:${ip}`);
      send(res, 401, { error: 'That email and password do not open this board.' });
      return;
    }
    const token = mintSession(who);
    const session = readSession(token);
    send(res, 200, {
      token,
      email: who,
      expiresUtc: session ? session.expiresUtc : null,
      sponsors: adminSponsors(),
    });
    return;
  }

  /*
   * Who the caller is, if anybody. The Admin panel asks this on load, with
   * the token it kept in sessionStorage, so a reload does not cost a second
   * sign in and a token that has expired or been revoked is found out
   * quietly rather than at the moment somebody tries to remove a track.
   *
   * It answers for BOARD_ADMIN_TOKEN too, with no address, because that
   * identity is a string rather than a person and the panel has something
   * honest to print either way.
   */
  if (req.method === 'GET' && path === '/api/admin/session') {
    const who = adminIdentity(req);
    if (!who) {
      send(res, 401, { error: 'Not signed in.' });
      return;
    }
    send(res, 200, {
      email: who.email,
      kind: who.kind,
      expiresUtc: who.expiresUtc || null,
      sponsors: adminSponsors(),
    });
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Site statistics                                                    */
  /* ---------------------------------------------------------------- */

  /*
   * ONE EVENT, ADDED TO A DAILY TOTAL.
   *
   * The whole privacy argument for this page is in what this route does not
   * do. It does not set a cookie. It does not store an address: clientIp is
   * read for the flood gate below and goes out of scope with the request.
   * It does not store the tab handle a flush carries, which lives in memory
   * for three minutes and answers one number. It does not store a
   * timestamp finer than the day, a user agent, a referrer, a screen size,
   * a pilot name or a track id, and there is no field in the wire format
   * for any of them.
   *
   * 204 for everything it accepts, and 204 for a request that asked not to
   * be counted, because the sender has nothing to do with either answer.
   */
  if (req.method === 'POST' && path === '/api/stats/events') {
    if (privacySignalled(req)) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const ip = clientIp(req);
    if (bugFlooded(`stats:${ip}`, STATS_FLOOD_LIMIT)) {
      send(res, 429, { error: 'Too many events from here.' });
      return;
    }
    let body;
    try {
      /* Small, because the largest honest event is about two hundred
       * characters. text/plain arrives here as readily as JSON: a beacon
       * cannot set a content type header and this route never reads one. */
      body = JSON.parse(await readBody(req, 2_000, 'That event is too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: 'That event was not readable.' });
      return;
    }
    const inspected = inspectStatsEvent(body, sourceKey);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    /* Spent only on an event that was actually stored, the same rule the
     * bug form follows: eight malformed posts should not lock out a pilot
     * who then sends a good one. */
    recordBugHit(`stats:${ip}`);
    if (inspected.event.kind === 'flush') {
      markFlying(inspected.event.tab);
    }
    /*
     * The country comes from the edge and only when something in front of
     * this process is trusted to set headers, exactly like the forwarded
     * host. A client can send these headers; without BOARD_TRUST_PROXY they
     * are ignored, so a direct instance cannot be told where its visitors
     * are.
     *
     * TWO HEADERS, IN ORDER. x-fdfpv-country is the one the Worker in
     * edge/router.js sets on purpose. cf-ipcountry is Cloudflare's own,
     * put on every proxied request when the zone's geolocation is on, and
     * the Worker forwards it with the rest of the headers whether or not it
     * has learned to set the first. That is the case this fallback exists
     * for: the Worker is deployed by hand, a push to main does not touch
     * it, and the first day of this page counted every visitor as Unknown
     * because the Worker in front of it was the one from before. Both are
     * the same two letters from the same edge, and both are believed under
     * the same rule.
     */
    const country = normaliseCountry(
      process.env.BOARD_TRUST_PROXY === '1'
        ? (req.headers['x-fdfpv-country'] || req.headers['cf-ipcountry'])
        : '',
    );
    await store.recordStats(inspected.event, { day: statsDay(), country });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  /*
   * What the statistics page reads. Counters, and four numbers off the
   * board's own tables, which are not events and never were.
   *
   * Cached for twenty seconds in process AND in the browser. This is the
   * only response besides a card animation that is not no-store, which is
   * why the header is written here rather than through send.
   */
  if (req.method === 'GET' && path === '/api/stats') {
    const now = Date.now();
    if (!statsCache.body || now - statsCache.at >= STATS_CACHE_MS) {
      const [counts, board] = await Promise.all([
        store.readStats({ days: STATS_WINDOW_DAYS, now }),
        store.boardFacts(),
      ]);
      statsCache = {
        at: now,
        body: JSON.stringify({
          ...counts,
          /* The sponsor's printed name travels with its row, so the page
           * never has to hold a second copy of the list to read one. */
          sources: counts.sources.map((row) => ({ ...row, name: sponsorName(row.key) })),
          live: { flying: flyingNow() },
          board,
        }),
      };
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${Math.round(STATS_CACHE_MS / 1000)}`,
    });
    res.end(statsCache.body);
    return;
  }

  /* The tag vocabulary rides along with the list rather than having a
   * request of its own. It used to ride the freestyle board's request, and
   * the page that read it no longer asks for that. One request, and the
   * vocabulary the page offers cannot drift from the one this board
   * accepts, because validate.js is the copy of record for both. */
  if (req.method === 'GET' && path === '/api/tracks') {
    send(res, 200, { tracks: await store.listTracks(), tags: TAGS });
    return;
  }

  const one = path.match(/^\/api\/tracks\/([^/]+)$/);
  if (req.method === 'GET' && one) {
    const id = trackIdFrom(one[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const track = await store.getTrack(id);
    if (!track) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    send(res, 200, track);
    return;
  }

  const doc = path.match(/^\/api\/tracks\/([^/]+)\/document$/);
  if (req.method === 'GET' && doc) {
    const id = trackIdFrom(doc[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const payload = await store.getDocument(id);
    if (!payload) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    send(res, 200, payload);
    return;
  }

  /* ---------------------------------------------------------------- */
  /* The card animation                                                 */
  /* ---------------------------------------------------------------- */

  /*
   * THE ONE ROUTE ON THIS BOARD THAT DOES NOT ANSWER IN JSON.
   *
   * It is an image, fetched by an <img> in the card grid, so it answers
   * with the bytes and the type. Everything else about it is ordinary: the
   * id is validated the same way, a track with no animation is a 404, and
   * the board still renders nothing.
   *
   * Cached hard, and it is safe to: the card's src carries gifUtc, so a
   * replaced animation is a different URL and an old one is never served
   * for a new layout. This is the only response on the board that is not
   * no-store, which is why the header is written here rather than in send.
   */
  const gif = path.match(/^\/api\/tracks\/([^/]+)\/gif$/);
  if (req.method === 'GET' && gif) {
    const id = trackIdFrom(gif[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const found = await store.getGif(id);
    if (!found) {
      send(res, 404, { error: 'That track has no animation.' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/gif',
      'content-length': found.bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(found.bytes);
    return;
  }

  /*
   * Uploading one. POST rather than PUT because the CORS grant above names
   * GET, POST and OPTIONS, and a fourth method would widen it for one
   * route that does nothing a POST cannot.
   *
   * Two ways in. The browser that published the track holds its edit key,
   * which is how the builder uploads an animation seconds after publishing
   * one. BOARD_ADMIN_TOKEN is the other, for the rooms published before
   * any of this existed, and it is unset by default.
   */
  if (req.method === 'POST' && gif) {
    const id = trackIdFrom(gif[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(
        req,
        MAX_GIF_BASE64_CHARS + 4_000,
        'That animation is too large for this board.',
      ));
    } catch (e) {
      if (e.status) {
        throw e;
      }
      send(res, 400, { error: 'That upload was not readable.' });
      return;
    }
    /* The class rule is read off the STORED document, not off anything the
     * uploader said about it. See inspectGif. */
    const held = await store.getDocument(id);
    if (!held) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    const checked = inspectGif({ base64: body.gif, document: held.document });
    if (checked.error) {
      send(res, 400, { error: checked.error });
      return;
    }
    const done = await store.setGif({
      id,
      bytes: checked.bytes,
      editKey: typeof body.editKey === 'string' ? body.editKey : '',
      admin: adminAuthorized(req),
    });
    if (!done) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    if (done.error) {
      send(res, done.status || 400, { error: done.error });
      return;
    }
    send(res, 200, { id, gifUtc: done.gifUtc, bytes: checked.bytes.length });
    return;
  }

  /*
   * TAKING A TRACK OFF THE BOARD.
   *
   * POST rather than DELETE, for the same reason the upload above is a POST
   * rather than a PUT: the CORS grant names GET, POST and OPTIONS, and a
   * fourth method would widen it for one route that does nothing a POST
   * cannot. Nothing in a browser calls this anyway.
   *
   * ADMIN ONLY, AND THE EDIT KEY IS NOT A WAY IN. See removeTrack in
   * src/store.js for why: an edit key is enough to clear times against a
   * layout that no longer exists, and it is not enough to delete other
   * pilots' records outright. Admin means BOARD_ADMIN_TOKEN or a signed in
   * address off the whitelist in src/admin.js, which is what the Admin
   * panel on the board's own page holds.
   *
   * The 404 and the 403 are told apart on purpose. An unauthorised caller
   * learns nothing about which ids exist, because adminAuthorized is checked
   * FIRST and answers the same way whether the id is real or not.
   */
  const remove = path.match(/^\/api\/tracks\/([^/]+)\/remove$/);
  if (req.method === 'POST' && remove) {
    const who = adminIdentity(req);
    if (!who) {
      send(res, 403, { error: 'Removing a track from this board needs an admin.' });
      return;
    }
    const id = trackIdFrom(remove[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const gone = await store.removeTrack(id);
    if (!gone) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    /*
     * The only line this server logs about a write, because it is the only
     * write that destroys somebody else's work: a track, and every time
     * flown on it, gone with no undo. A host's log is the only record that
     * it happened and who did it, so it says both.
     */
    console.log(`removed ${gone.id} "${gone.name}" by ${gone.author}, ${gone.times} time(s), by ${who.email || 'BOARD_ADMIN_TOKEN'}`);
    send(res, 200, {
      id: gone.id, name: gone.name, author: gone.author, times: gone.times,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/tracks') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      /* An oversize body carries its own status and its own message; only
       * a JSON parse failure is this route's 400. Swallowing the status
       * here used to turn every 413 into a 400. */
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    /* 'null', '7' and '[]' all parse. Reading .author off them threw a
     * TypeError that came back as a 500. */
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'That request was not a JSON object.' });
      return;
    }
    const author = normaliseName(body.author);
    if (!author) {
      send(res, 400, { error: 'A published track needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.' });
      return;
    }
    const inspected = inspectDocument(body.document);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    /*
     * TAGS TRAVEL IN THE ENVELOPE, BESIDE THE AUTHOR, NOT INSIDE THE
     * DOCUMENT, and that is the whole reason this is a two line change
     * rather than a deploy dance.
     *
     * A tag says what the author MEANT the track for. It is not part of the
     * layout, it is not something the simulator reads to fly the track, and
     * it is not something a visitor loading a shared document needs. Putting
     * it in the document would mean a schemaVersion bump, which means
     * DEPLOY.md's rule that the board ships before the simulator, which
     * means a simulator deployed first publishes tracks this board refuses
     * with a message about a version number rather than about anything the
     * author did. It would also have to be kept out of layoutHash by hand,
     * and layoutHash getting that wrong silently clears every republished
     * track's times.
     *
     * In the envelope it is none of those things: an old builder sends no
     * tags and gets an empty list, a new builder sends tags to an old board
     * and they are ignored, and nobody's lap times move.
     */
    const tagged = inspectTags(body.tags);
    if (tagged.error) {
      send(res, 400, { error: tagged.error });
      return;
    }
    const result = await store.publish({
      inspected,
      author,
      editKey: typeof body.editKey === 'string' ? body.editKey : '',
      tags: tagged.tags,
    });
    if (result.error) {
      send(res, result.status || 400, { error: result.error, conflict: Boolean(result.conflict) });
      return;
    }
    send(res, result.updated ? 200 : 201, result);
    return;
  }

  const times = path.match(/^\/api\/tracks\/([^/]+)\/times$/);
  if (req.method === 'POST' && times) {
    let body;
    try {
      body = JSON.parse(await readBody(req, 660_000, 'That time is too large to post.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    /* 'null', '7' and '[]' all parse. Reading .author off them threw a
     * TypeError that came back as a 500. */
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'That request was not a JSON object.' });
      return;
    }
    const name = normaliseName(body.name);
    const lapMs = normaliseLapMs(body.lapMs);
    if (!name) {
      send(res, 400, { error: 'A time on the board needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.' });
      return;
    }
    if (lapMs == null) {
      send(res, 400, { error: 'That lap time is not usable.' });
      return;
    }
    /* The ghost is optional and refused loudly when malformed rather than
     * silently dropped: the simulator proves its own encoding before it
     * sends, so a bad blob here is a bug someone needs to hear about. */
    const ghost = inspectGhost(body.ghost, lapMs);
    if (ghost.error) {
      send(res, 400, { error: ghost.error });
      return;
    }
    const trackId = trackIdFrom(times[1]);
    if (!trackId) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const result = await store.addTime({
      trackId,
      name,
      lapMs,
      /*
       * The RaceGOW metric, and it is OPTIONAL rather than validated into an
       * error. A time posted from the sixty metre field has no such number
       * and never will; a time posted from a room has one only when the run
       * put three clean laps together. Absent, null and unusable all mean
       * the same thing to the board, which is that there is nothing to
       * print, and refusing the whole post over it would lose a good lap.
       */
      threeMs: normaliseThreeMs(body.threeMs, lapMs),
      ghost: ghost.ghost,
    });
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    send(res, 201, result);
    return;
  }

  const ghostPath = path.match(/^\/api\/tracks\/([^/]+)\/times\/([^/]+)\/ghost$/);
  if (req.method === 'GET' && ghostPath) {
    const trackId = trackIdFrom(ghostPath[1]);
    const timeId = timeIdFrom(ghostPath[2]);
    if (!trackId || !timeId) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const row = await store.getGhost(trackId, timeId);
    if (!row) {
      send(res, 404, { error: 'That time is not on the board.' });
      return;
    }
    if (!row.ghost) {
      send(res, 404, { error: 'That time was posted without a ghost.' });
      return;
    }
    send(res, 200, row);
    return;
  }

  /* ---------------------------------------------------------------- */
  /* The freestyle board                                                */
  /* ---------------------------------------------------------------- */

  if (req.method === 'GET' && path === '/api/runs') {
    const map = url.searchParams.get('map') || '';
    if (map && !RUN_MAPS.includes(map)) {
      send(res, 400, { error: 'That is not a map this board keeps scores for.' });
      return;
    }
    send(res, 200, { runs: await store.listRuns({ map }), tags: TAGS, maps: RUN_MAPS });
    return;
  }

  /*
   * The first public write on this board with no owner and no edit key, so
   * it carries every guard the bug route carries and one the bug route does
   * not need: a pilot holds one row per map, replaced only by a better run.
   * That, rather than the flood gate, is what stops a table being filled.
   */
  if (req.method === 'POST' && path === '/api/runs') {
    const ip = clientIp(req);
    if (bugFlooded(`run:${ip}`)) {
      send(res, 429, { error: 'Too many runs posted from here. Fly another and try again shortly.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000, 'That run is too large to post.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const inspected = inspectRun(body);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    recordBugHit(`run:${ip}`);
    const result = await store.addRun(inspected.run);
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    /*
     * 200 rather than 201 when the pilot already held a better run: nothing
     * was created, and the body says so with `improved: false` so the
     * simulator can tell a pilot they did not beat themselves rather than
     * congratulating them on a score that is not on the board.
     */
    send(res, result.improved ? 201 : 200, result);
    return;
  }

  if (req.method === 'GET' && path === '/api/bugs') {
    if (!bugsAuthorized(req, url)) {
      send(res, 401, { error: 'A token is needed to read tickets.' });
      return;
    }
    const status = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    if (status && !BUG_STATUSES.includes(status)) {
      send(res, 400, { error: 'Status is open, in_progress, fixed, wontfix or duplicate.' });
      return;
    }
    if (kind && !BUG_KINDS.includes(kind)) {
      send(res, 400, { error: 'Kind is crash, blocking, wrong, visual, feel or other.' });
      return;
    }
    send(res, 200, { bugs: await store.listBugs({ status, kind, limit: url.searchParams.get('limit') }) });
    return;
  }

  if (req.method === 'POST' && path === '/api/bugs') {
    const ip = clientIp(req);
    if (bugFlooded(ip)) {
      send(res, 429, { error: 'Too many reports from here. Try again in a few minutes.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 40_000, 'That report is too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const inspected = inspectBugCreate(body);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    recordBugHit(ip);
    send(res, 201, await store.addBug(inspected));
    return;
  }

  const bugOne = path.match(/^\/api\/bugs\/([^/]+)$/);
  if (bugOne && (req.method === 'GET' || req.method === 'POST')) {
    if (!bugsAuthorized(req, url)) {
      send(res, 401, { error: 'A token is needed to read or update tickets.' });
      return;
    }
    const id = bugIdFrom(bugOne[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    if (req.method === 'GET') {
      const ticket = await store.getBug(id);
      if (!ticket) {
        send(res, 404, { error: 'That ticket is not on the board.' });
        return;
      }
      send(res, 200, ticket);
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000, 'That update is too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const patch = inspectBugPatch(body);
    if (patch.error) {
      send(res, 400, { error: patch.error });
      return;
    }
    const result = await store.updateBug(id, patch);
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: 'Nothing at that address.' });
}

async function handleStatic(req, res, url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch (e) {
    send(res, 400, 'bad path', 'text/plain; charset=utf-8');
    return;
  }
  let rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (rel === '' || rel === '.') {
    rel = 'index.html';
  }
  if (rel === 'bugs') {
    rel = 'bugs.html';
  }
  const root = resolve(publicDir);
  const path = resolve(root, rel);
  const inside = path === root || path.startsWith(root + sep);
  if (!inside || relative(root, path).split(sep).includes('..')) {
    send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME.get(extname(path)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await handleStatic(req, res, url);
  } catch (e) {
    /* Only errors this code raised on purpose carry a status, and only
     * those have a message meant for a stranger. Everything else is a
     * stack from pg or the filesystem, and echoing it told the internet
     * about the schema and the paths. */
    if (e && e.status) {
      send(res, e.status, { error: e.message });
      return;
    }
    console.error(e);
    send(res, 500, { error: 'The board failed.' });
  }
});

if (process.env.BOARD_LISTEN !== '0') {
  server.listen(port, '0.0.0.0', () => {
    console.log(`FDFPV leaderboard: http://127.0.0.1:${port}/`);
    console.log(`Store: ${store.kind}. Simulator: ${simOrigin}`);
  });
}

export { server, store };
