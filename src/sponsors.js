/*
 * sponsors.js: the sponsors the board makes links for, and with them the
 * only words a visit's `utm_source` can be counted as.
 *
 * The statistics page shows where visitors came from. Storing whatever
 * `utm_source` said would let anybody with curl add rows to a public page,
 * a thousand invented sources making a thousand rows nobody can clean. So
 * a source is a sponsor slug written down by the host, or `direct` when
 * there is none, or `other`, one row however many strangers arrive. It is
 * a list rather than a rule ("anything slug shaped") for the reason the
 * admin whitelist is: a rule is something a stranger can satisfy.
 *
 * A sponsor's link is `{simulator}/?utm_source=<slug>&utm_medium=sponsor`,
 * minted in the Admin panel. It opens the simulator, so a pilot arriving
 * from a sponsor is flying in one click. The browser keeps the slug thirty
 * days and sends it as one of these few words on its events: it says
 * which poster somebody walked past, never who they are.
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

/* A slug as both ends of the wire check it (the simulator before keeping
 * what it read from a query, this board before believing a post). Lower
 * case, so a poster in capitals and a link in lower case are one sponsor. */
export const SOURCE_RE = /^[a-z0-9-]{2,32}$/;

/* The two keys that are never sponsors and always have a row: an arrival
 * with no source, and one with a source this board does not know. */
export const SOURCE_DIRECT = 'direct';
export const SOURCE_OTHER = 'other';

/* Printed on a public page, so bounded and stripped of control and format
 * characters (no paragraph, no direction override). Letters of any
 * alphabet stay. */
const DISPLAY_MAX_CHARS = 40;

function displayName(raw) {
  return raw.replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim().slice(0, DISPLAY_MAX_CHARS);
}

/*
 * BOARD_SPONSORS, as `slug:Display Name` entries split by newlines or
 * commas, in the host's order; it is the whole list, and none ship (a
 * made up sponsor would put a fictional name on a public page). The slug
 * travels in printed links so it must never change; the name can. A row
 * with no name prints its slug. A row that does not parse is dropped
 * rather than stopping the board, and the Admin panel's count shows it.
 */
function readSponsors(text) {
  const bySlug = new Map();
  const entries = String(text ?? '').split(/[\n,]+/).map((e) => e.trim()).filter((e) => e !== '');
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const slug = (colon === -1 ? entry : entry.slice(0, colon)).trim().toLowerCase();
    const reserved = slug === SOURCE_DIRECT || slug === SOURCE_OTHER;
    if (!SOURCE_RE.test(slug) || reserved || bySlug.has(slug)) {
      continue;
    }
    const name = colon === -1 ? '' : displayName(entry.slice(colon + 1));
    bySlug.set(slug, { slug, name: name || slug });
  }
  return bySlug;
}

const SPONSORS = readSponsors(process.env.BOARD_SPONSORS);

/* Copies, so no caller can rearrange what the rest of the process reads. */
export function sponsorList() {
  return [...SPONSORS.values()].map((s) => ({ slug: s.slug, name: s.name }));
}

export function sponsorCount() {
  return SPONSORS.size;
}

export function isSponsorSlug(slug) {
  return SPONSORS.has(String(slug ?? ''));
}

const RESERVED_NAMES = new Map([[SOURCE_DIRECT, 'Direct'], [SOURCE_OTHER, 'Other']]);

/* What the page prints for a stored source key. */
export function sponsorName(key) {
  const slug = String(key ?? '');
  return RESERVED_NAMES.get(slug) ?? SPONSORS.get(slug)?.name ?? slug;
}

/*
 * The fold, and the reason this file exists: whatever arrives becomes a
 * listed slug, `direct` or `other`, so the sources table can never hold
 * more than two rows beyond what the host wrote down.
 */
export function sourceKey(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return SOURCE_DIRECT;
  }
  const slug = String(raw).trim().toLowerCase();
  if (slug === SOURCE_DIRECT || isSponsorSlug(slug)) {
    return slug;
  }
  return SOURCE_OTHER;
}

/* The link a sponsor is handed. The simulator's origin is an argument
 * because only the server's configuration knows it. */
export function sponsorLink(simOrigin, slug) {
  const origin = String(simOrigin || '').replace(/\/+$/, '');
  return `${origin}/?utm_source=${encodeURIComponent(slug)}&utm_medium=sponsor`;
}
