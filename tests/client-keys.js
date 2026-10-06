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
import { moveKey, moveRenamedKeys, RENAMED } from '../public/keys.js';

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

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
