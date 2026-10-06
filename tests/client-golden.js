/*
 * client-golden.js: the page modules that run without a browser, pinned.
 *
 * public/origins.js decides where every link on the page points before
 * /api/config answers, from the page's own address alone. Its answers for
 * a matrix of addresses are compared with tests/golden/client.json.
 *
 *   node tests/client-golden.js           compare
 *   node tests/client-golden.js --write   regenerate (only on purpose)
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as origins from '../public/origins.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'client.json');

const hosts = ['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '129.151.39.48', 'board.example', 'LOCALHOST', '127.0.0.2'];
const protocols = ['http:', 'https:', 'file:'];
const paths = ['/', '/board', '/board/', '/board/bugs', '/boards/', '/x/board/', '/api/board', ''];

const answers = { constants: {}, isLoopback: {}, guessSimOrigin: {}, landingOrigin: {} };
for (const [name, value] of Object.entries(origins)) {
  if (typeof value !== 'function') {
    answers.constants[name] = value;
  }
}
for (const h of [...hosts, null, undefined, 7]) {
  answers.isLoopback[String(h)] = origins.isLoopback(h);
}
for (const hostname of hosts) {
  for (const protocol of protocols) {
    const location = { hostname, protocol };
    answers.landingOrigin[`${protocol}//${hostname}`] = origins.landingOrigin(location);
    for (const pathname of paths) {
      answers.guessSimOrigin[`${protocol}//${hostname} ${pathname}`] = origins.guessSimOrigin(location, { pathname });
    }
  }
}
answers.guessSimOrigin['no location'] = origins.guessSimOrigin(null, { pathname: '/' });
answers.guessSimOrigin['no here'] = origins.guessSimOrigin({ hostname: 'localhost', protocol: 'http:' }, null);
answers.guessSimOrigin['here without path'] = origins.guessSimOrigin({ hostname: 'x.example', protocol: 'https:' }, {});
answers.landingOrigin['no location'] = origins.landingOrigin(null);

const text = `${JSON.stringify(answers, null, 1)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN, text);
  console.log('client golden: wrote tests/golden/client.json');
  process.exit(0);
}
const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
let differ = 0;
for (const group of Object.keys({ ...want, ...answers })) {
  for (const key of Object.keys({ ...want[group], ...answers[group] })) {
    if (JSON.stringify(want[group]?.[key]) !== JSON.stringify(answers[group]?.[key])) {
      differ += 1;
      console.log(`  FAIL  ${group} ${key}: want ${JSON.stringify(want[group]?.[key])}, got ${JSON.stringify(answers[group]?.[key])}`);
    }
  }
}
const cases = Object.values(answers).reduce((n, g) => n + Object.keys(g).length, 0);
console.log(`client golden: ${cases} answers, ${differ} differ`);
process.exit(differ ? 1 : 0);
