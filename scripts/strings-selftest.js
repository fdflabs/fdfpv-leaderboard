/*
 * strings-selftest.js: the page's string tables agree. Every locale beside
 * en.js has exactly en's keys and keeps every placeholder. Run with
 * npm run strings:selftest.
 *
 * This file is part of the FDFPV leaderboard.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import en from '../public/strings/en.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const placeholders = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');

console.log('strings');
const keys = Object.keys(en);
check('en.js has strings', keys.length > 100, `${keys.length}`);
const files = (await readdir(join(root, 'public/strings'))).filter((f) => /^[a-z]{2}\.js$/.test(f) && f !== 'en.js');
check('a second locale exists', files.length > 0, files.join(','));
for (const f of files) {
  const table = (await import(join(root, 'public/strings', f))).default;
  const missing = keys.filter((k) => !(k in table));
  const extra = Object.keys(table).filter((k) => !(k in en));
  const holes = keys.filter((k) => k in table && placeholders(table[k]) !== placeholders(en[k]));
  check(`${f} has every key en.js has`, missing.length === 0, `missing ${missing.length}: ${missing.slice(0, 3).join(', ')}`);
  check(`${f} has no key en.js lacks`, extra.length === 0, `extra ${extra.length}: ${extra.slice(0, 3).join(', ')}`);
  check(`${f} keeps every placeholder`, holes.length === 0, holes.slice(0, 3).join(', '));
}
console.log(`\n${failed ? `${failed} FAILED, ` : ''}${passed} passed`);
process.exit(failed ? 1 : 0);
