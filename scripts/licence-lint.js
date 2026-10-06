/*
 * licence-lint.js: every file this repository ships says it is GPLv3.
 *
 * CLAUDE.md says every file gets a header, and a missing one breaks no
 * test and renders no differently, so without this the only way anybody
 * finds out is somebody outside the project reading the source. That has
 * happened here once: the JavaScript had headers and the SQL, the YAML
 * and a script did not.
 *
 * A file passes when the licence's name appears near its top. It is not
 * enough for it to appear anywhere: a paragraph that mentions the licence
 * is not a grant. The window is generous because several files here
 * explain themselves before the notice.
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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const NOTICE = 'GNU General Public License';
const WINDOW = 3000;

/* Formats with a comment syntax. JSON has none, images have no text, and
 * LICENSE is the licence itself. */
const HEADED = new Set(['.css', '.html', '.js', '.mjs', '.sql', '.yaml', '.yml']);

/* Matched against a directory's name anywhere in the tree: not ours to
 * licence (vendor is the pinned simulator, which lints itself), or not
 * source at all. */
const FOREIGN_NAMES = new Set(['.git', 'data', 'node_modules', 'vendor']);
/* Matched against the path from the root: third party artwork. */
const FOREIGN_PATHS = new Set(['public/credits']);

async function shippedFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (HEADED.has(extname(entry.name))) {
        files.push(relative(root, path));
      }
      continue;
    }
    if (!FOREIGN_NAMES.has(entry.name) && !FOREIGN_PATHS.has(relative(root, path))) {
      files.push(...await shippedFiles(path));
    }
  }
  return files;
}

const files = (await shippedFiles(root)).sort();
const unlicensed = [];
for (const file of files) {
  const head = (await readFile(join(root, file), 'utf8')).slice(0, WINDOW);
  if (!head.includes(NOTICE)) {
    unlicensed.push(file);
  }
}

console.log(`licence-lint: ${files.length} shipped file(s) that can carry a header\n`);
if (unlicensed.length === 0) {
  console.log(`all ${files.length} carry the GPLv3 notice in their first ${WINDOW} characters`);
  process.exit(0);
}
for (const file of unlicensed) {
  console.log(`FAIL  ${file}`);
}
console.log(`\n${unlicensed.length} file(s) without the GPLv3 notice. CLAUDE.md: every file gets a header.`);
process.exit(1);
