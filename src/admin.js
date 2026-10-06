/*
 * admin.js: who may sign in to this board, and the token that proves it.
 *
 * Almost nothing on the board has an owner: a track belongs to whichever
 * browser kept its edit key, a time to nobody. What was missing was a
 * person who can take something down from a browser rather than with curl
 * and BOARD_ADMIN_TOKEN (which still works, for scripts such as the
 * simulator's scripts/boardgif.js, which have no browser to sign in from).
 *
 * That person is an address on a whitelist with a password, and a signed
 * token saying the address proved its password recently. The list comes
 * only from BOARD_ADMINS: nothing ships, because a published hash of a
 * short password is a password anybody patient can recover. Until a host
 * sets it nobody can sign in, and the board says so when it starts.
 * scripts/admin-hash.js mints a record without the password touching a
 * shell history.
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
import {
  createHash, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/* Twelve hours: an admin is not signing in again between two removals,
 * and a tab left open on a shared machine is not a key for days. */
const SESSION_MS = 12 * 60 * 60 * 1000;
export { SESSION_MS };

/*
 * The cost a `plain:` record is hashed at, and the one scripts/admin-hash.js
 * writes: about 16 MB and some tens of milliseconds a guess, nothing on a
 * login used twice a week and ruinous for a word list. A record carries
 * its own cost, so a host can spend more and an old record still verifies.
 */
export const SCRYPT_COST = Object.freeze({ N: 16384, r: 8, p: 1 });
const HASH_BYTES = 32;

/* What a record may ask scrypt for. Past these a record is a typo or an
 * attempt to make sign-in eat the host's memory. */
const COST_LIMITS = { N: [1024, 1_048_576], r: [1, 32], p: [1, 16] };

/*
 * Loose by design: the whitelist decides who is an admin, so this only
 * keeps the record separator (a colon) out of an address and stops a
 * megabyte reaching scrypt. Lower case, because people capitalise their
 * own address half the time and it means the same mailbox.
 */
const ADDRESS = /^[^\s:@]{1,64}@[^\s:@]{1,180}\.[A-Za-z]{2,24}$/;

export function normaliseEmail(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && ADDRESS.test(email) ? email : '';
}

function hashPassword(password, salt, cost, bytes) {
  return scryptSync(password, salt, bytes, { N: cost.N, r: cost.r, p: cost.p });
}

function costFrom(parts) {
  const cost = { N: Number(parts[0]), r: Number(parts[1]), p: Number(parts[2]) };
  const fits = Object.entries(COST_LIMITS)
    .every(([k, [lo, hi]]) => Number.isInteger(cost[k]) && cost[k] >= lo && cost[k] <= hi);
  return fits ? cost : null;
}

/*
 * The verifier behind one secret, or null if it cannot be read.
 *
 *   scrypt:N:r:p:saltHex:hashHex   what scripts/admin-hash.js prints
 *   plain:<password>               a local checkout only; hashed here at
 *                                  start so no plaintext stays in memory
 *
 * `plain:` is allowed at all because a rule that makes adding a second
 * admin on your own machine cost a script run gets worked around. It is
 * the wrong answer for a host, and the README says so.
 */
function verifierFor(secret) {
  if (secret.startsWith('plain:')) {
    const password = secret.slice('plain:'.length);
    if (password === '') {
      return null;
    }
    const salt = randomBytes(16);
    return { cost: SCRYPT_COST, salt, hash: hashPassword(password, salt, SCRYPT_COST, HASH_BYTES) };
  }
  const [scheme, ...rest] = secret.split(':');
  if (scheme !== 'scrypt' || rest.length !== 5) {
    return null;
  }
  const cost = costFrom(rest);
  const [saltHex, hashHex] = rest.slice(3);
  if (!cost || !/^[0-9a-fA-F]{16,128}$/.test(saltHex) || !/^[0-9a-fA-F]{32,128}$/.test(hashHex)) {
    return null;
  }
  return { cost, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

/*
 * BOARD_ADMINS as an ordered Map of address to verifier. Entries are
 * `address:secret`, split at the first colon (an address has none, a
 * secret has several), and separated by newlines, commas or semicolons,
 * since the value is typed into dashboards as often as into files. Lines
 * starting with # are comments; the first record for an address wins; a
 * record that cannot be read is skipped so one typo costs one admin, not
 * the board.
 */
function readWhitelist(text) {
  const admins = new Map();
  for (const piece of String(text || '').split(/[\n,;]+/)) {
    const line = piece.trim();
    const colon = line.indexOf(':');
    if (line === '' || line.startsWith('#') || colon < 1) {
      continue;
    }
    const email = normaliseEmail(line.slice(0, colon));
    const secret = line.slice(colon + 1).trim();
    if (email === '' || secret === '' || admins.has(email)) {
      continue;
    }
    const verifier = verifierFor(secret);
    if (verifier) {
      admins.set(email, verifier);
    }
  }
  return admins;
}

/*
 * Read once at import: a `plain:` record costs a scrypt run, and the
 * environment does not change under a running process. An empty result is
 * said out loud, because a board with no admin and no explanation is only
 * noticed on the day somebody needs a track taken down.
 */
const configured = process.env.BOARD_ADMINS || '';
const ADMINS = readWhitelist(configured);
if (ADMINS.size === 0) {
  console.error(configured.trim()
    ? 'BOARD_ADMINS is set but no entry in it could be read. Nobody can sign in. Format: email:scrypt:N:r:p:saltHex:hashHex, one per line or comma separated.'
    : 'BOARD_ADMINS is not set. Nobody can sign in as admin until it names somebody; see README, The whitelist.');
}

/* The whitelist itself is never served: a list of admin addresses is a
 * list of accounts worth attacking. These are for the tests and the
 * start-up message. */
export function adminEmails() {
  return [...ADMINS.keys()];
}

export function adminCount() {
  return ADMINS.size;
}

/*
 * Checked against when the address is not on the list, so a wrong address
 * costs the same scrypt run as a wrong password. Otherwise timing the
 * answers would tell a stranger which addresses are admins, which is most
 * of the work of guessing.
 */
const STAND_IN = { cost: SCRYPT_COST, salt: randomBytes(16), hash: randomBytes(HASH_BYTES) };

function equalBytes(a, b) {
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/*
 * The address if this pair opens the board, else null, saying nothing
 * about which half was wrong so the login route can give one sentence for
 * every failure. An empty or absurd password is refused before scrypt;
 * whoever sends one already knows it is not a password.
 */
export function checkPassword(rawEmail, rawPassword) {
  const email = normaliseEmail(rawEmail);
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  const admin = (email && ADMINS.get(email)) || null;
  if (password.length === 0 || password.length > PASSWORD_MAX) {
    return null;
  }
  const verifier = admin || STAND_IN;
  let attempt;
  try {
    attempt = hashPassword(password, verifier.salt, verifier.cost, verifier.hash.length);
  } catch (err) {
    /* A record asking for more memory than this process allows. Its host
     * has to hear about it; meanwhile nobody signs in with it. */
    console.error('An admin record could not be verified; check its scrypt parameters against this process\'s memory limit.', err.message);
    return null;
  }
  return admin && equalBytes(attempt, verifier.hash) ? email : null;
}

/*
 * Session tokens are signed, never stored: no table, no sweep, and a
 * deploy or a second instance accepts the tokens the first one minted.
 *
 * The signing key is derived from the whitelist's own records (address,
 * salt, hash, in order), so it is unguessable, the same on every instance
 * and restart, and it changes when any password changes, which signs out
 * every token that password minted. BOARD_SESSION_SECRET is mixed in so a
 * host can sign everybody out without touching a password. An empty
 * whitelist gets random bytes instead, or every empty board would share a
 * key. This derivation is a contract with the tokens already in admins'
 * browsers; changing it signs them all out.
 */
const signingKey = (() => {
  const h = createHash('sha256');
  h.update('fdfpv-board-admin-session/v1');
  h.update(String(process.env.BOARD_SESSION_SECRET || ''));
  h.update([...ADMINS].map(([email, v]) => `${email}:${v.salt.toString('hex')}:${v.hash.toString('hex')}`).join('\n'));
  if (ADMINS.size === 0) {
    h.update(randomBytes(32));
  }
  return h.digest();
})();

const TOKEN_VERSION = 'v1';
const TOKEN_MAX_CHARS = 4096;

function signature(payload) {
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}

/* `v1.<base64url JSON {e: address, x: expiry ms}>.<base64url HMAC>`. The
 * version lets a later shape be told apart instead of misparsed. */
export function mintSession(email, { now = Date.now(), ms = SESSION_MS } = {}) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + ms })).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${signature(payload)}`;
}

function claimsOf(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/*
 * { email, expiresUtc } for a token this board signed, that has not run
 * out, for an address still on the whitelist; otherwise null. The list is
 * checked here as well as at sign-in, so removing an address and
 * restarting locks it out at once rather than when its token expires.
 */
export function readSession(token, { now = Date.now() } = {}) {
  const text = typeof token === 'string' ? token.trim() : '';
  if (text === '' || text.length > TOKEN_MAX_CHARS) {
    return null;
  }
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return null;
  }
  const [, payload, offered] = parts;
  if (!equalBytes(Buffer.from(signature(payload)), Buffer.from(offered))) {
    return null;
  }
  const claims = claimsOf(payload);
  const shaped = typeof claims === 'object' && claims !== null
    && typeof claims.e === 'string' && Number.isFinite(claims.x);
  if (!shaped || claims.x <= now || !ADMINS.has(claims.e)) {
    return null;
  }
  return { email: claims.e, expiresUtc: new Date(claims.x).toISOString() };
}
