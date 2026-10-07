/*
 * client-keys.js: renamed browser storage keys move once and only once.
 *
 * Seeds the names the page used to use in a stand-in for Storage, runs
 * the move the pages run at load, and checks the values arrived under the
 * new names, the old ones are gone, a second run changes nothing, a value
 * already under a new name wins, and a storage that refuses access breaks
 * nothing.
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
  LANG_KEY, STATS_KEY, moveKey, moveRenamedKeys, readSharedKey, RENAMED, writeSharedKey,
} from '../public/keys.js';

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

/* The Storage methods the move uses, over a Map. */
class FakeStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }

  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }

  setItem(k, v) {
    this.map.set(k, String(v));
  }

  removeItem(k) {
    this.map.delete(k);
  }

  snapshot() {
    return JSON.stringify([...this.map].sort());
  }
}

console.log('\nrenamed keys');
const pairs = Object.values(RENAMED).flat();
check('every rename goes from a webfpv name to an fdfpv name',
  pairs.every(([from, to]) => from.startsWith('webfpv.') && to.startsWith('fdfpv.')));

for (const kind of Object.keys(RENAMED)) {
  const list = RENAMED[kind];
  const old = Object.fromEntries(list.map(([from], i) => [from, `value-${i}`]));
  const store = new FakeStorage({ ...old, unrelated: 'stays' });
  moveRenamedKeys(() => store, kind);
  check(`${kind}: each value is under its new name`,
    list.every(([, to], i) => store.getItem(to) === `value-${i}`), store.snapshot());
  check(`${kind}: and no old name is left`, list.every(([from]) => store.getItem(from) === null), store.snapshot());
  check(`${kind}: other keys are untouched`, store.getItem('unrelated') === 'stays');
  const once = store.snapshot();
  moveRenamedKeys(() => store, kind);
  check(`${kind}: a second run changes nothing`, store.snapshot() === once);
}

const both = new FakeStorage({ a: 'old', b: 'new' });
moveKey(both, 'a', 'b');
check('a value already under the new name wins, and the old name goes',
  both.getItem('b') === 'new' && both.getItem('a') === null, both.snapshot());

const none = new FakeStorage({ x: '1' });
moveKey(none, 'a', 'b');
check('with nothing under the old name, nothing is written', none.snapshot() === JSON.stringify([['x', '1']]));

const empty = new FakeStorage({ a: '' });
moveKey(empty, 'a', 'b');
check('an empty string is a value and moves', empty.getItem('b') === '' && empty.getItem('a') === null);

let threw = false;
try {
  moveRenamedKeys(() => {
    throw new Error('SecurityError');
  }, 'local');
  moveKey({ getItem() { throw new Error('denied'); } }, 'a', 'b');
} catch {
  threw = true;
}
check('a storage that refuses access breaks nothing', !threw);

/* The two keys shared with the simulator: an old build of either site
 * reads and writes only the old name; this one reads both and writes both.
 * Whatever the order, each reads the value written last. */
for (const [key, oldName] of [[LANG_KEY, 'webfpv.lang'], [STATS_KEY, 'webfpv.stats.v1']]) {
  const shared = new FakeStorage({});
  check(`${key}: nothing stored reads null`, readSharedKey(key, shared) === null);
  shared.setItem(oldName, 'A');
  check(`${key}: a value only under the old name is read`, readSharedKey(key, shared) === 'A');
  writeSharedKey(key, 'B', shared);
  check(`${key}: a write goes under both names`, shared.getItem(key) === 'B' && shared.getItem(oldName) === 'B');
  shared.setItem(oldName, 'C');
  check(`${key}: an old build writing later wins`, readSharedKey(key, shared) === 'C');
  writeSharedKey(key, 'D', shared);
  check(`${key}: and this build writing after that wins again`, readSharedKey(key, shared) === 'D' && shared.getItem(oldName) === 'D');
  const fresh = new FakeStorage({ [key]: 'N' });
  check(`${key}: a value only under the new name is read`, readSharedKey(key, fresh) === 'N');
  const halfRefused = new FakeStorage({});
  const setItem = halfRefused.setItem.bind(halfRefused);
  halfRefused.setItem = (k, v) => {
    if (k === key) {
      throw new Error('QuotaExceededError');
    }
    setItem(k, v);
  };
  try {
    writeSharedKey(key, 'E', halfRefused);
  } catch {
    /* Refused, as storage does. */
  }
  check(`${key}: a refused second write still reads the newer value`, readSharedKey(key, halfRefused) === 'E');
}
check('the shared names', LANG_KEY === 'fdfpv.lang' && STATS_KEY === 'fdfpv.stats.v1');

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
