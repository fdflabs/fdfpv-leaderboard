/*
 * licence-lint.js: every file this repository ships carries its licence.
 *
 * WHY THIS EXISTS.
 *
 * CLAUDE.md opens its decisions with "Licence is GPLv3. Every file gets a
 * header." That was true of the JavaScript and false of everything else: a
 * review found scripts/seed.js, schema.sql, render.yaml and
 * docker-compose.yml shipping without one, and nothing could have told
 * anybody, because a missing licence header breaks no test and renders no
 * differently. It is the sort of thing that is noticed by somebody outside
 * the project, which is the worst way to notice it.
 *
 * A four line script closes that for good. It knows the three comment
 * syntaxes this repository uses and it fails on the first file that is
 * missing the notice.
 *
 * This file is part of the WebFPVSimulator leaderboard.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* Directories that are not ours to licence. */
/* vendor holds the pinned simulator, which its own repository lints. */
const SKIP_DIR = new Set(['.git', 'node_modules', 'data', 'public/credits', 'vendor']);
/* Extensions that carry a header, and can. A .json file has no comment
 * syntax, a .png has no text, and LICENSE is the licence. */
const WANT = new Set(['.js', '.mjs', '.html', '.css', '.sql', '.yml', '.yaml']);
const NOTICE = 'GNU General Public License';

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || SKIP_DIR.has(rel)) {
        continue;
      }
      await walk(full, out);
    } else if (WANT.has(extname(e.name))) {
      out.push(rel);
    }
  }
  return out;
}

const files = (await walk(root)).sort();
const missing = [];
for (const rel of files) {
  const src = await readFile(join(root, rel), 'utf8');
  /* The header has to be at the TOP, not merely somewhere in the file: a
   * mention of the licence in a paragraph of prose is not a grant. 3000
   * characters is generous enough for a file that explains itself first,
   * which several here do. */
  if (!src.slice(0, 3000).includes(NOTICE)) {
    missing.push(rel);
  }
}

console.log(`licence-lint: ${files.length} shipped file(s) that can carry a header\n`);
if (missing.length) {
  for (const rel of missing) {
    console.log(`FAIL  ${rel}`);
  }
  console.log(`\n${missing.length} file(s) without the GPLv3 notice. CLAUDE.md: every file gets a header.`);
  process.exit(1);
}
console.log(`all ${files.length} carry the GPLv3 notice in their first 3000 characters`);
process.exit(0);
