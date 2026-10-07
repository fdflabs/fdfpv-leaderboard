/*
 * keys.js: the names this page keeps things under in the browser, and the
 * move from the names it used to use.
 *
 * The board shares its origin with the simulator on the VM (the simulator
 * at the root, the board under /board), so the two read one localStorage
 * and one sessionStorage. Keys only the board reads are named here, and
 * so are the two both pages read on purpose, the language choice and the
 * statistics memory (see readSharedKey below).
 *
 * A renamed key is moved once, when a page that uses it loads: the value
 * under the old name is copied to the new one unless the new one already
 * holds something, then the old name is removed. Running it again changes
 * nothing, so a page loaded twice, or two pages, cannot undo it.
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

/* sessionStorage: the admin's sign in, shared by the board and the inbox,
 * and a bug token typed into the inbox. */
export const ADMIN_TOKEN_KEY = 'fdfpv.board.admin.v1';
export const BUGS_TOKEN_KEY = 'fdfpv.bugs.token';
/* localStorage: the aircraft the visitor last chose on the board. */
export const CRAFT_KEY = 'fdfpv.board.craft.v1';

/* Old name to new, by the storage each lives in. */
export const RENAMED = {
  session: [
    ['webfpv.board.admin.v1', ADMIN_TOKEN_KEY],
    ['webfpv.bugs.token', BUGS_TOKEN_KEY],
  ],
  local: [
    ['webfpv.board.craft.v1', CRAFT_KEY],
  ],
};

/*
 * Move `from` to `to` in `storage`. A storage that refuses access (a
 * private window, storage switched off) holds nothing to move, and the
 * page works without it, so a refusal is the end of the job, not an error.
 */
export function moveKey(storage, from, to) {
  try {
    const kept = storage.getItem(from);
    if (kept === null) {
      return;
    }
    if (storage.getItem(to) === null) {
      storage.setItem(to, kept);
    }
    storage.removeItem(from);
  } catch {
    /* Refused: see above. */
  }
}

/* `openStorage` returns the storage, because merely naming sessionStorage
 * throws where storage is switched off; `kind` is 'session' or 'local'. */
export function moveRenamedKeys(openStorage, kind) {
  let storage;
  try {
    storage = openStorage();
  } catch {
    return;
  }
  for (const [from, to] of RENAMED[kind]) {
    moveKey(storage, from, to);
  }
}

/*
 * THE TWO KEYS SHARED WITH THE SIMULATOR, moving from webfpv.* to fdfpv.*
 * names. KEEP IN STEP WITH src/share/sharedkeys.js in the simulator, which
 * holds the same table and rule.
 *
 * The board and the simulator deploy separately, so for a while one of
 * them may run a build that knows only the old name. A build that knows
 * both writes the value under both, the old name first; on reading, a
 * value under the old name that differs from the new one wins, since only
 * an old build writes it alone. Whatever order the two read and write in,
 * each reads the value written last, so an opt out or a language chosen on
 * either page is never lost. The old names go once both sites run this.
 */
export const LANG_KEY = 'fdfpv.lang';
export const STATS_KEY = 'fdfpv.stats.v1';

const SHARED_OLD_NAMES = {
  [LANG_KEY]: 'webfpv.lang',
  [STATS_KEY]: 'webfpv.stats.v1',
};

/* The value under a shared key, or null. Throws as localStorage does when
 * storage is refused; callers already guard. */
export function readSharedKey(key, storage = localStorage) {
  const now = storage.getItem(key);
  const before = storage.getItem(SHARED_OLD_NAMES[key]);
  return before !== null && before !== now ? before : now;
}

/* Write under both names, the old first: if the second write is refused
 * the old name holds the new value and wins on reading; if the first is,
 * nothing changed. Throws as localStorage does. */
export function writeSharedKey(key, value, storage = localStorage) {
  const text = String(value);
  storage.setItem(SHARED_OLD_NAMES[key], text);
  storage.setItem(key, text);
}
