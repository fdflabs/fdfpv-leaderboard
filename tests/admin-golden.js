/*
 * admin-golden.js: the admin whitelist, its session tokens, the sponsor
 * list and scripts/admin-hash.js, pinned.
 *
 * src/admin.js and src/sponsors.js read their lists from the environment
 * once, at import, so each scenario runs in its own Node process with its
 * own BOARD_ADMINS, BOARD_SPONSORS and BOARD_SESSION_SECRET, and answers a
 * fixed list of questions as JSON. The answers are compared with
 * tests/golden/admin.json.
 *
 * Two things here are contracts beyond this repository. BOARD_ADMINS is a
 * host's configuration: a record minted last month must still open the
 * board. And a session token is held in an admin's browser across a
 * deploy, so the token a given whitelist mints at a given instant is
 * pinned byte for byte, which pins the signing key's derivation. Where a
 * scenario makes the key random on purpose (a `plain:` record, or nobody
 * on the list), only whether a token reads back is recorded.
 *
 *   node tests/admin-golden.js           compare
 *   node tests/admin-golden.js --write   regenerate (only on purpose)
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
import { spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const GOLDEN = join(here, 'golden', 'admin.json');

/* A record as scripts/admin-hash.js writes one, at a low cost so the suite
 * stays quick, from a fixed salt so the record and every token derived
 * from it are the same on every run. */
function record(email, password, { N = 1024, r = 1, p = 1, salt = '00112233445566778899aabbccddeeff', len = 32 } = {}) {
  const hash = scryptSync(password, Buffer.from(salt, 'hex'), len, { N, r, p }).toString('hex');
  return `${email}:scrypt:${N}:${r}:${p}:${salt}:${hash}`;
}

const ADA = record('ada@example.com', 'correct horse');
const BO = record('Bo@Example.org', 'battery staple', { salt: 'ffeeddccbbaa99887766554433221100' });
const CY = record('cy@example.net', 'long enough pw', { N: 2048, r: 2, p: 1, len: 48 });

const scenarios = {
  unset: {},
  blank: { BOARD_ADMINS: '   ' },
  garbage: { BOARD_ADMINS: 'not a record at all' },
  one: { BOARD_ADMINS: ADA },
  commas: { BOARD_ADMINS: `${ADA},${BO}` },
  mixed: { BOARD_ADMINS: `# admins\n${ADA};\n\n ${BO} ,${CY}` },
  duplicate: { BOARD_ADMINS: `${ADA}\n${record('ADA@example.com', 'second password')}` },
  secret: { BOARD_ADMINS: ADA, BOARD_SESSION_SECRET: 'rotate me' },
  bounds: {
    BOARD_ADMINS: [
      record('low@example.com', 'pw pw pw pw', { N: 512 }),
      record('high@example.com', 'pw pw pw pw', { r: 33 }),
      `short@example.com:scrypt:1024:1:1:0011:${'ab'.repeat(32)}`,
      `nothex@example.com:scrypt:1024:1:1:${'zz'.repeat(8)}:${'ab'.repeat(32)}`,
      `parts@example.com:scrypt:1024:1:1:${'ab'.repeat(8)}`,
      `float@example.com:scrypt:1024.5:1:1:${'ab'.repeat(8)}:${'ab'.repeat(32)}`,
      'noaddress:scrypt:1024:1:1:00:00',
      ':plain:nobody',
      'empty@example.com:',
      'emptyplain@example.com:plain:',
      'other@example.com:bcrypt:whatever',
      ADA,
    ].join('\n'),
  },
  plain: { BOARD_ADMINS: `ada@example.com:plain:correct horse,${BO}` },
  sponsors: { BOARD_ADMINS: ADA, BOARD_SPONSORS: 'rotorriot:Rotor Riot,fpvshop:The FPV Shop' },
  sponsorsOdd: {
    BOARD_SPONSORS: [
      'Caps-Slug:Caps', 'direct:Not allowed', 'other:Nope', 'x:too short', 'ok-slug', 'ok-slug:Duplicate',
      'cafe:Café​ FPV‮  with   spaces and a very long tail that goes on and on', 'bad slug:Space',
      `${'a'.repeat(32)}:Longest`, `${'a'.repeat(33)}:Too long`, ' spaced : Spaced Name ', 'tab:\tTabbed\t',
    ].join('\n'),
  },
  sponsorsBlank: { BOARD_SPONSORS: ' , ,\n' },
};

/* Scenarios whose signing key is random by design: a `plain:` record is
 * salted afresh at start, and an empty whitelist mixes in random bytes. */
const RANDOM_KEY = new Set(['unset', 'blank', 'garbage', 'plain', 'sponsorsOdd', 'sponsorsBlank']);

/* The questions, asked inside each scenario's process. */
const PROBE = `
const admin = await import(${JSON.stringify(join(root, 'src', 'admin.js'))});
const sponsors = await import(${JSON.stringify(join(root, 'src', 'sponsors.js'))});
const NOW = 1_790_000_000_000;
const out = {};
const deterministic = process.argv[1] === 'yes';
out.emails = admin.adminEmails();
out.count = admin.adminCount();
out.constants = { min: admin.PASSWORD_MIN, max: admin.PASSWORD_MAX, sessionMs: admin.SESSION_MS };
out.normalise = [
  '  Someone@Example.COM ', 'not an address', 'a@b', 'a@b.c', 'a@b.co', null, 7, 'x:y@example.com', 'x y@example.com',
  'a@@example.com', 'a@example.c0m', \`\${'a'.repeat(64)}@example.com\`, \`\${'a'.repeat(65)}@example.com\`,
  \`a@\${'b'.repeat(180)}.com\`, \`a@\${'b'.repeat(181)}.com\`, \`a@b.\${'c'.repeat(24)}\`, \`a@b.\${'c'.repeat(25)}\`,
  'ünï@example.com', 'a@sub.example.co.uk',
].map((e) => admin.normaliseEmail(e));
const passwords = {
  'ada@example.com': 'correct horse', 'bo@example.org': 'battery staple', 'cy@example.net': 'long enough pw',
};
out.check = [];
for (const [email, password] of Object.entries(passwords)) {
  out.check.push(
    admin.checkPassword(email, password),
    admin.checkPassword(\`  \${email.toUpperCase()} \`, password),
    admin.checkPassword(email, \`\${password} \`),
    admin.checkPassword(email, ''),
    admin.checkPassword(email, 'x'.repeat(201)),
    admin.checkPassword(email, 7),
  );
}
out.check.push(admin.checkPassword('stranger@example.com', 'correct horse'), admin.checkPassword('', 'correct horse'));
out.check.push(admin.checkPassword('ada@example.com', 'second password'));
const read = (t, now = NOW) => admin.readSession(t, { now });
out.tokens = [];
for (const email of [...out.emails, 'gone@example.com']) {
  const token = admin.mintSession(email, { now: NOW });
  const short = admin.mintSession(email, { now: NOW, ms: 1000 });
  const [v, payload, sig] = token.split('.');
  out.tokens.push({
    email,
    token: deterministic ? token : '<random key>',
    payload,
    reads: read(token),
    readsBeforeEnd: read(short, NOW + 999),
    readsAtEnd: read(short, NOW + 1000),
    readsTrimmed: read(\`  \${token}\\n\`),
    tamperedSig: read(\`\${token.slice(0, -2)}zz\`),
    tamperedPayload: read(\`\${v}.\${Buffer.from(JSON.stringify({ e: email, x: NOW + 9e9 })).toString('base64url')}.\${sig}\`),
    otherVersion: read(\`v2.\${payload}.\${sig}\`),
    extraPart: read(\`\${token}.x\`),
  });
}
out.defaultExpiry = admin.mintSession('ada@example.com', { now: NOW }).split('.')[1];
out.junk = ['', 'v1.a.b', null, 7, 'v2.a.b', 'v1..', 'x'.repeat(4097), 'v1.e30.' + 'A'.repeat(43)].map((t) => read(t));
out.sponsorList = sponsors.sponsorList();
out.sponsorCount = sponsors.sponsorCount();
out.sponsorConstants = [String(sponsors.SOURCE_RE), sponsors.SOURCE_DIRECT, sponsors.SOURCE_OTHER];
const keys = [
  undefined, null, '', ' ', 'direct', 'DIRECT', ' Direct ', 'other', 'rotorriot', 'ROTORRIOT', ' rotorriot ', 'fpvshop',
  'caps-slug', 'ok-slug', 'cafe', 'spaced', 'tab', 'a'.repeat(32), 'unknown', 7, ['rotorriot'], {},
];
out.sourceKey = keys.map((k) => sponsors.sourceKey(k));
out.isSponsorSlug = keys.map((k) => sponsors.isSponsorSlug(k));
out.sponsorName = keys.map((k) => sponsors.sponsorName(k));
out.list = sponsors.sponsorList();
out.list.push({ slug: 'injected', name: 'x' });
out.listAfterMutation = sponsors.sponsorCount();
out.links = [
  ['https://sim.example', 'rotorriot'], ['https://sim.example///', 'a b&c'], ['', 'x'], [null, 'x'], [undefined, 'ñ'],
].map(([o, s]) => sponsors.sponsorLink(o, s));
console.log(JSON.stringify(out));
`;

function runScenario(name, env) {
  const deterministic = !RANDOM_KEY.has(name);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, deterministic ? 'yes' : 'no'], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`${name} exited ${r.status}: ${r.stderr}`);
  }
  return { ...JSON.parse(r.stdout), warnedAtStart: r.stderr.trim() !== '' };
}

/* scripts/admin-hash.js, piped (the terminal path cannot be driven here). */
function runHash(args, input) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'admin-hash.js'), ...args], {
    input, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function hashTool() {
  const out = {};
  const minted = runHash(['Pilot@Example.com'], 'a fine password\n');
  out.mintedStatus = minted.status;
  const line = minted.stdout.trim();
  out.mintedShape = /^pilot@example\.com:scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/.test(line);
  out.mintedOneLine = minted.stdout.split('\n').filter(Boolean).length === 1;
  const opened = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const a = await import(${JSON.stringify(join(root, 'src', 'admin.js'))});
    console.log(JSON.stringify([a.checkPassword('pilot@example.com', 'a fine password'), a.checkPassword('pilot@example.com', 'a fine password\\n')]));
  `], { env: { PATH: process.env.PATH, BOARD_ADMINS: line }, encoding: 'utf8' });
  out.mintedRecordOpens = JSON.parse(opened.stdout);
  out.twoMintsDiffer = runHash(['pilot@example.com'], 'a fine password').stdout !== minted.stdout;
  out.crlf = runHash(['pilot@example.com'], 'a fine password\r\n').status;
  out.noAddress = runHash([], 'a fine password').status;
  out.badAddress = runHash(['not-an-address'], 'a fine password').status;
  out.short = runHash(['pilot@example.com'], '1234567').status;
  out.exactMin = runHash(['pilot@example.com'], '12345678').status;
  out.exactMax = runHash(['pilot@example.com'], 'x'.repeat(200)).status;
  out.long = runHash(['pilot@example.com'], 'x'.repeat(201)).status;
  out.refusalsPrintNothing = [runHash([], 'x'), runHash(['pilot@example.com'], 'short')].every((r) => r.stdout === '');
  return out;
}

const now = {};
for (const [name, env] of Object.entries(scenarios)) {
  now[name] = runScenario(name, env);
}
now.adminHash = hashTool();

const text = `${JSON.stringify(now, null, 1)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN, text);
  console.log(`admin golden: wrote ${Object.keys(now).length} scenarios to tests/golden/admin.json`);
  process.exit(0);
}
const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
let differ = 0;
for (const name of new Set([...Object.keys(want), ...Object.keys(now)])) {
  const a = JSON.stringify(want[name]);
  const b = JSON.stringify(now[name]);
  if (a === b) {
    console.log(`  pass  ${name}`);
    continue;
  }
  differ += 1;
  console.log(`  FAIL  ${name}`);
  for (const key of new Set([...Object.keys(want[name] || {}), ...Object.keys(now[name] || {})])) {
    if (JSON.stringify(want[name]?.[key]) !== JSON.stringify(now[name]?.[key])) {
      console.log(`        ${key}: want ${JSON.stringify(want[name]?.[key]).slice(0, 300)}`);
      console.log(`        ${key}: got  ${JSON.stringify(now[name]?.[key]).slice(0, 300)}`);
    }
  }
}
console.log(`admin golden: ${Object.keys(now).length} scenarios, ${differ} differ`);
process.exit(differ ? 1 : 0);
