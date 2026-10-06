/*
 * admin-hash.js: print one BOARD_ADMINS record for an address.
 *
 *   node scripts/admin-hash.js someone@example.com
 *   printf '%s' "$PASSWORD" | node scripts/admin-hash.js someone@example.com
 *
 * At a terminal it asks for the password twice without echoing it, so the
 * word never lands in a shell history, a process list or scrollback; piped,
 * it reads one password and asks nothing. The record it prints is the
 * scrypt hash src/admin.js verifies, at the cost src/admin.js hashes a
 * `plain:` record at. BOARD_ADMINS takes several, separated by commas or
 * newlines, and replaces the built-in list (which is empty).
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
import { randomBytes, scryptSync } from 'node:crypto';
import { normaliseEmail, PASSWORD_MAX, PASSWORD_MIN, SCRYPT_COST } from '../src/admin.js';

function fail(code, ...lines) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(code);
}

/*
 * One line typed with echo off. The terminal goes into raw mode so each
 * key arrives here instead of being printed, which also means Enter,
 * Backspace and Ctrl-C have to be handled by hand.
 */
function typedSecretly(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let typed = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const onKey = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onKey);
          stdout.write('\n');
          resolve(typed);
          return;
        }
        typed = ch === '\u007f' || ch === '\b' ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on('data', onKey);
    stdin.resume();
  });
}

/* Everything piped in, less one trailing line end that `echo` adds. */
async function piped() {
  let text = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    text += chunk;
  }
  return text.replace(/\r?\n$/, '');
}

const email = normaliseEmail(process.argv[2]);
if (!email) {
  fail(2,
    'Usage: node scripts/admin-hash.js someone@example.com',
    'The address is the one they will type into the board\'s Admin panel.');
}

let password;
if (process.stdin.isTTY) {
  password = await typedSecretly('Password: ');
  if (await typedSecretly('Again: ') !== password) {
    fail(1, 'Those did not match. Nothing written.');
  }
} else {
  password = await piped();
}
if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
  fail(1, `A password here is ${PASSWORD_MIN} to ${PASSWORD_MAX} characters. Nothing written.`);
}

const { N, r, p } = SCRYPT_COST;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, r, p });
console.log([email, 'scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join(':'));
