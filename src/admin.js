/*
 * admin.js: who may sign in to this board, and the token that says they did.
 *
 * THE BOARD IS PUBLIC AND ALMOST EVERYTHING ON IT IS UNOWNED.
 *
 * A track is held by whichever browser kept its edit key, a time is held by
 * nobody at all, and that is the right shape for a board whose whole job is
 * that strangers can publish to it. What it left missing was a person: the
 * one route that can take a track off the board answered only to
 * BOARD_ADMIN_TOKEN, which is a string in an environment, not somebody. A
 * string cannot be sat in front of a browser, so the board had no admin
 * screen at all, and the only way to remove anything was curl.
 *
 * This file is the person. A short whitelist of email addresses, each with a
 * password, and a signed token that says an address proved its password
 * recently. BOARD_ADMIN_TOKEN keeps working beside it and is unchanged: it
 * is what scripts/boardgif.js in the simulator's repository holds, and a
 * script has no browser to sign in from.
 *
 * NO ADMIN SHIPS. The upstream project carried one address with a published
 * scrypt hash as a convenience, and a short password behind a published
 * hash is a password anybody willing to spend an afternoon can have. This
 * fork ships an empty list: until BOARD_ADMINS names somebody, nobody can
 * sign in, and the board says so at start. scripts/admin-hash.js mints a
 * record for that variable without a plaintext password going anywhere
 * near a shell history.
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

import {
  createHash, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

/*
 * THE WHITELIST, and it is a list of addresses rather than a rule about
 * them. No domain wildcard, no "anyone at this company": an admin of this
 * board is an address somebody wrote down here or in BOARD_ADMINS, and
 * everything else is refused. A list of one is a perfectly good list.
 *
 * BOARD_ADMINS is the whole list. Nothing is written down here, so there is
 * nothing a host can forget to drop.
 */
const DEFAULT_ADMINS = [];

/*
 * scrypt, not one round of SHA-256, and the parameters travel in the record
 * rather than being written here. A password is short and a hash is fast, so
 * the only thing standing between a leaked hash and the password behind it is
 * how long one guess takes. N=16384, r=8 is about 16 MB and a few tens of
 * milliseconds per guess, which is nothing on a login route that happens
 * twice a week and is ruinous for somebody trying a word list.
 *
 * In the record so that a host that wants to spend more can, and so that a
 * record minted years from now at a higher cost still verifies against this
 * code.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 32;

/* Long enough that an admin is not signing in between two removals, short
 * enough that a tab left open in a library is not a standing key. */
const SESSION_MS = 12 * 60 * 60 * 1000;

/*
 * Deliberately loose. This is not the place to argue with somebody about
 * whether their address is really an address: the whitelist decides that,
 * and an address that is not on it is refused whatever it looks like. All
 * this does is keep the parser's separator out of the local part and stop a
 * megabyte of text reaching scrypt.
 */
const EMAIL_RE = /^[^\s:@]{1,64}@[^\s:@]{1,180}\.[A-Za-z]{2,24}$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function normaliseEmail(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  /* Lowercased, because a person typing their own address into a login form
   * capitalises it about half the time and an address is not case sensitive
   * in any way that matters here. The whitelist is lowercased on the way in
   * too, so a record written in mixed case still matches. */
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : '';
}

/*
 * One entry: 'email:secret', split on the FIRST colon only, because the
 * secret is itself colon separated and an address cannot contain one.
 *
 * Two secret shapes.
 *
 *   scrypt:N:r:p:saltHex:hashHex   what scripts/admin-hash.js writes
 *   plain:the password             for a local checkout, and nowhere else
 *
 * `plain` exists because the alternative is that anybody adding a second
 * admin on their own machine has to run a script first, and a rule that
 * costs that much gets worked around rather than followed. It is refused
 * nowhere, warned about nowhere, and documented as the wrong answer for a
 * host: a hash is one command away.
 */
function parseEntry(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#')) {
    return null;
  }
  const cut = text.indexOf(':');
  if (cut < 1) {
    return null;
  }
  const email = normaliseEmail(text.slice(0, cut));
  const secret = text.slice(cut + 1).trim();
  if (!email || !secret) {
    return null;
  }
  if (secret.startsWith('plain:')) {
    const password = secret.slice(6);
    if (!password) {
      return null;
    }
    /* Hashed on the way in, at this process's own cost, so that nothing
     * downstream has two shapes to think about and no plaintext sits in a
     * long-lived object. */
    const salt = randomBytes(16);
    return {
      email,
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt,
      hash: scryptSync(password, salt, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }),
    };
  }
  const parts = secret.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)
    || N < 1024 || r < 1 || p < 1 || N > 1_048_576 || r > 32 || p > 16) {
    return null;
  }
  if (!/^[0-9a-fA-F]{16,128}$/.test(parts[4]) || !/^[0-9a-fA-F]{32,128}$/.test(parts[5])) {
    return null;
  }
  return {
    email,
    N,
    r,
    p,
    salt: Buffer.from(parts[4], 'hex'),
    hash: Buffer.from(parts[5], 'hex'),
  };
}

/*
 * Comma, semicolon and newline all separate, because this value is typed
 * into a web dashboard's text box as often as it is written in a file and
 * nobody remembers which one a given service wanted.
 */
function parseList(raw) {
  const out = [];
  const seen = new Set();
  for (const line of String(raw || '').split(/[\n,;]+/)) {
    const entry = parseEntry(line);
    if (!entry || seen.has(entry.email)) {
      continue;
    }
    seen.add(entry.email);
    out.push(entry);
  }
  return out;
}

/*
 * The list this process will answer to, read ONCE at import.
 *
 * Once, rather than per request, because parsing a `plain:` entry runs
 * scrypt and a login route that re-read the environment would hash the
 * whitelist on every attempt. The environment does not change under a
 * running process anyway.
 *
 * A BOARD_ADMINS that is unset or parses to nothing is said out loud at
 * start, because a board that silently has no admin and no explanation is
 * the one nobody notices until the day somebody needs to remove a track.
 */
function loadAdmins() {
  const raw = process.env.BOARD_ADMINS || '';
  const list = raw.trim() ? parseList(raw) : parseList(DEFAULT_ADMINS.join('\n'));
  if (!list.length) {
    console.error(raw.trim()
      ? 'BOARD_ADMINS is set but no entry in it could be read. Nobody can sign in. Format: email:scrypt:N:r:p:saltHex:hashHex, one per line or comma separated.'
      : 'BOARD_ADMINS is not set. Nobody can sign in as admin until it names somebody; see README, The whitelist.');
  }
  return list;
}

const ADMINS = loadAdmins();

/*
 * A record nobody's password matches, used when an unknown address is
 * offered, so that a wrong address and a wrong password cost the same
 * milliseconds. Without it the login route is an oracle: ask it about a
 * hundred addresses, time the answers, and the ones that took fifty
 * milliseconds are the admins. Knowing WHICH address to guess against is
 * most of guessing.
 */
const DECOY = {
  email: '',
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  salt: randomBytes(16),
  hash: randomBytes(SCRYPT_LEN),
};

function sameBytes(a, b) {
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/*
 * The addresses that may sign in. Used by the tests and by nothing that
 * answers a request: the board does not publish its whitelist, because a
 * list of admin addresses is a list of accounts worth attacking.
 */
export function adminEmails() {
  return ADMINS.map((a) => a.email);
}

export function adminCount() {
  return ADMINS.length;
}

/*
 * Does this address and password pair open the board? The email back, or
 * null, and NOTHING about which half was wrong: the route says one sentence
 * for every failure and this is why it can.
 */
export function checkPassword(rawEmail, rawPassword) {
  const email = normaliseEmail(rawEmail);
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  const found = email ? ADMINS.find((a) => a.email === email) : null;
  const entry = found || DECOY;
  if (password.length < 1 || password.length > PASSWORD_MAX) {
    /* Still nothing to time: an empty or absurd password is refused before
     * scrypt, and an attacker who can send one of those already knows it is
     * not a password. */
    return null;
  }
  let derived;
  try {
    derived = scryptSync(password, entry.salt, entry.hash.length, {
      N: entry.N, r: entry.r, p: entry.p,
    });
  } catch (e) {
    /* A record asking for more memory than this process will give it. The
     * host that wrote the record is the one who has to hear about it, and
     * nobody signs in meanwhile. */
    console.error('An admin record could not be verified; check its scrypt parameters against this process\'s memory limit.', e.message);
    return null;
  }
  return found && sameBytes(derived, entry.hash) ? email : null;
}

/* ------------------------------------------------------------------ */
/* The session token                                                   */
/* ------------------------------------------------------------------ */

/*
 * SIGNED, NOT STORED, and there is no sessions table anywhere.
 *
 * A board that kept sessions in memory would sign every admin out on each
 * deploy, which on Render's free plan is also every cold start, and would
 * hand a second instance a token it had never heard of. A row in Postgres
 * would fix both and costs a migration, a store method on each of the two
 * stores, and a sweep of expired rows. A signature costs none of that: the
 * token carries who and until when, and the signature is what stops anybody
 * writing their own.
 *
 * THE SIGNING KEY IS DERIVED FROM THE WHITELIST ITSELF, which is the part
 * worth reading twice. Every record carries a random salt and a hash, so the
 * key is unguessable without them; it is the same on every instance and
 * after every restart, because the whitelist is; and CHANGING A PASSWORD
 * CHANGES THE KEY, so it invalidates every token that password ever minted.
 * That is the sign-out-everywhere a stateless token usually cannot do.
 *
 * BOARD_SESSION_SECRET is mixed in for a host that wants to revoke every
 * session without touching a password. Unset is fine and is the default.
 */
const sessionKey = createHash('sha256')
  .update('fdfpv-board-admin-session/v1')
  .update(String(process.env.BOARD_SESSION_SECRET || ''))
  .update(ADMINS.map((a) => `${a.email}:${a.salt.toString('hex')}:${a.hash.toString('hex')}`).join('\n'))
  /* An empty whitelist would otherwise give every board on earth the same
   * signing key, which is a key nobody has to guess. */
  .update(ADMINS.length ? '' : randomBytes(32))
  .digest();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload) {
  return b64url(createHmac('sha256', sessionKey).update(payload).digest());
}

/*
 * 'v1.<payload>.<signature>'. The version is there so a later shape can be
 * told apart from this one rather than failing to parse in an interesting
 * way.
 */
export function mintSession(email, { now = Date.now(), ms = SESSION_MS } = {}) {
  const payload = b64url(JSON.stringify({ e: email, x: now + ms }));
  return `v1.${payload}.${sign(payload)}`;
}

/*
 * The email a token proves, or null. Null for a token that was not signed
 * by this board, one whose address has since left the whitelist, and one
 * that has expired.
 */
export function readSession(token, { now = Date.now() } = {}) {
  const text = typeof token === 'string' ? token.trim() : '';
  if (!text || text.length > 4096) {
    return null;
  }
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return null;
  }
  const expected = Buffer.from(sign(parts[1]));
  const offered = Buffer.from(parts[2]);
  if (!sameBytes(expected, offered)) {
    return null;
  }
  let body;
  try {
    body = JSON.parse(unb64url(parts[1]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!body || typeof body !== 'object' || typeof body.e !== 'string' || typeof body.x !== 'number') {
    return null;
  }
  if (!Number.isFinite(body.x) || body.x <= now) {
    return null;
  }
  /*
   * The whitelist is checked again HERE, not only at sign-in. Taking an
   * address out of BOARD_ADMINS and restarting has to be enough to lock
   * somebody out, and a token they already hold would otherwise keep
   * working until it expired on its own.
   */
  if (!ADMINS.some((a) => a.email === body.e)) {
    return null;
  }
  return { email: body.e, expiresUtc: new Date(body.x).toISOString() };
}

export { SESSION_MS };
