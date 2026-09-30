/*
 * pilotkeys.js: a name claimed ahead of a time, and a pilot key handed on.
 *
 * A name on this board belongs to the first pilot key that posts a time
 * under it (claimName in src/store.js). The simulator's optional Google
 * sign-in (fdfpv tracks-api/accounts.js) gives a pilot one callsign
 * everywhere, and carries one pilot key between that pilot's computers,
 * which asks two more things of this board and nothing else:
 *
 *   A CLAIM. When a pilot picks a callsign, the simulator claims it here
 *   under the account's key before the accounts server keeps it, so a
 *   callsign is never one this board already gave another key, and from
 *   then on the first key rule keeps everybody else off it. The key signs
 *   the name, so nobody can claim a name for a key they do not hold.
 *
 *   A LINK. A computer that signs in holding a key of its own, with names
 *   and times under it, hands them to the account's key: every name the
 *   old key owns and every time it posted move to the new one. BOTH keys
 *   sign the same message, the old one because its names are being given
 *   away and the new one because it is taking them, so nobody can move
 *   names off a key they do not hold, nor pin them on one.
 *
 * The messages MIRROR nameClaimMessage and keyLinkMessage in the
 * simulator's src/share/identity.js, which signs them. They are written out
 * here rather than imported because vendor/fdfpv is pinned to a commit from
 * before they existed; change both or the signatures stop checking.
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

const NAME_CLAIM_PREFIX = 'fdfpv-name/v1';
const KEY_LINK_PREFIX = 'fdfpv-link/v1';
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export function nameClaimMessage(name) {
  return new TextEncoder().encode(`${NAME_CLAIM_PREFIX}\n${name}`);
}

export function keyLinkMessage(from, to) {
  return new TextEncoder().encode(`${KEY_LINK_PREFIX}\n${from}\n${to}`);
}

/* key and sig base64, as inspectAuth checks their shape; false for
 * anything that does not verify, malformed included. */
export async function verifyKeySignature({ key, sig, message }) {
  try {
    const pub = await globalThis.crypto.subtle.importKey('raw', Buffer.from(key, 'base64'), CURVE, false, ['verify']);
    return await globalThis.crypto.subtle.verify(SIGN, pub, Buffer.from(sig, 'base64'), message);
  } catch (e) {
    return false;
  }
}
