/*
 * airframes.js: regenerate src/airframes.js from the simulator's catalogue.
 *
 *   node scripts/airframes.js                       the pinned vendor/fdfpv
 *   node scripts/airframes.js ../fdfpv/configs/airframes.js [more...]
 *
 * The statistics count each aircraft under the id the simulator gives it
 * (AIRFRAME_IDS in its configs/airframes.js) and fold any other id into
 * `other`. This reads the catalogues named and adds every id they hold to
 * src/airframes.js. It never removes one: an aircraft the simulator has
 * retired is still sent by browsers holding an older build, and its rows
 * already counted are history the page still prints. So the file only
 * grows, in the order ids first appeared.
 *
 * The selftest checks the pinned simulator's catalogue against the file,
 * so re-pinning vendor/fdfpv without running this fails CI.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'airframes.js');
const catalogues = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : [join(root, 'vendor', 'fdfpv', 'configs', 'airframes.js')];

const { AIRFRAME_IDS: kept } = await import(pathToFileURL(target));
const ids = [...kept];
const added = [];
for (const path of catalogues) {
  const { AIRFRAME_IDS: catalogue } = await import(pathToFileURL(path));
  if (!Array.isArray(catalogue) || catalogue.some((id) => typeof id !== 'string' || !/^[a-z0-9]{1,32}$/.test(id))) {
    throw new Error(`${path}: AIRFRAME_IDS is not a list of airframe ids`);
  }
  for (const id of catalogue) {
    if (!ids.includes(id)) {
      ids.push(id);
      added.push(id);
    }
  }
}

const text = readFileSync(target, 'utf8');
const start = text.indexOf('export const AIRFRAME_IDS = [');
const end = text.indexOf('];', start) + 2;
const rows = [];
for (let i = 0; i < ids.length; i += 8) {
  rows.push(`  ${ids.slice(i, i + 8).map((id) => `'${id}'`).join(', ')},`);
}
writeFileSync(target, `${text.slice(0, start)}export const AIRFRAME_IDS = [\n${rows.join('\n')}\n];${text.slice(end)}`);
console.log(added.length ? `added ${added.join(', ')}` : 'nothing new');
