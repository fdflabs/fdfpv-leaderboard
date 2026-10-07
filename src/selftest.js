/*
 * selftest.js: `npm test`. The board's behaviour, checked end to end.
 *
 * Units first (the origins the page guesses, the admin whitelist, what
 * validate.js takes and refuses, the file store, the statistics
 * counters), then the real server started on a loopback port with a file
 * store and driven over HTTP and WebSocket the way the simulator, the
 * builder and the page drive it. With BOARD_SELFTEST_DATABASE_URL naming
 * an EMPTY Postgres database, the HTTP half runs again against it, since
 * the live board is the Postgres store; the pass counts from zero and
 * drops nothing, so pointing it at a board with data fails rather than
 * harms it. Unset, it says `skip` rather than passing quietly.
 *
 * The goldens under tests/ pin exact answers; this file pins the rules
 * behind them, with a sentence each, and the places the board leans on the
 * pinned simulator (its lap check, identity module, builder types, map
 * registry), so re-pinning vendor/fdfpv fails here first.
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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guessSimOrigin, isLoopback, landingOrigin } from '../public/origins.js';
import { BUILD_TYPES } from '../vendor/fdfpv/src/builder/course.js';
import { checkLap } from '../vendor/fdfpv/src/game/verify.js';
import { MAPS } from '../vendor/fdfpv/src/maps/registry.js';
import { createIdentity, memoryStorage } from '../vendor/fdfpv/src/share/identity.js';
import { mapTrackDocument } from '../vendor/fdfpv/tests/lib/maptrack.js';
import { syntheticLapBytes } from '../vendor/fdfpv/tests/lib/synthlap.js';
import { sourceKey } from './sponsors.js';
import { openStore, rowToSummary, summaryOf } from './store.js';
import {
  creditOf, inspectBugCreate, inspectBugImages, inspectBugPatch, inspectDocument, inspectGhost, inspectStatsEvent,
  layoutHash, normaliseCountry, normaliseLapMs, normaliseName, normaliseThreeMs, planFromDocument, statsDay,
  trackClassOf, MAP_ELEMENT_TYPES, MAP_IDS, MAX_BUG_IMAGE_BYTES, RUN_MAPS, STATS_CRAFT, TRACK_CLASSES,
} from './validate.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/* ================================================================== */
/* The harness                                                         */
/* ================================================================== */

let failures = 0;

function check(name, holds, detail = '') {
  if (holds) {
    console.log(`  pass  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail === '' || detail === undefined ? '' : `  ${detail}`}`);
}

const section = (title) => console.log(`\n${title}`);
const skip = (what) => console.log(`  skip  ${what}`);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const utf8 = (text) => new TextEncoder().encode(text);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/* Keys sorted, so a document handed back by Postgres (JSONB keeps its own
 * key order) compares equal to the one sent. */
const sortedJson = (value) => JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]))
  : v));
const sameMembers = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/* ================================================================== */
/* Fixtures                                                            */
/* ================================================================== */

/* Credentials the HTTP half starts its servers with. `plain:` on purpose:
 * it is the record shape nothing else exercises, and the selftest's own
 * password is no secret. */
const SCRIPT_TOKEN = 'selftest-admin-token';
const KEEPER = 'boardkeeper@example.com';
const KEEPER_PASSWORD = 'selftest-password-42';
const BUGS_SECRET = 'selftest-bugs-token';

/* A 64 by 64 GIF header, the smallest animation the board takes. */
const GIF_64 = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([64, 0, 64, 0, 0, 0, 0]), Buffer.from([0x3b])]);
/* A real one pixel PNG, so its magic and its length are a real file's. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF\x40\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(60, 3)]);

const FIELD_GATE_DIMS = { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 };
const ROOM_GATE_DIMS = { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 };

function gate(id, x, y, { z = 0, dims = FIELD_GATE_DIMS, type = 'gate', yaw = 0 } = {}) {
  return {
    id, type, name: 'Gate', position: { x, y, z }, yaw, pitch: 0, yawOverridden: false, dims,
  };
}

const flyingOrder = (...ids) => ids.map((elementId, i) => ({
  id: `seq-${i + 1}`, elementId, apertureIndex: 0, entry: 1,
}));

/*
 * A schema 1 track on the sixty metre field, one gate unless told
 * otherwise. `logo` and `logos` spell branding the two ways stored tracks
 * spell it.
 */
function field(id = 'trk-1a2b3c4d', { name = 'Ladder Loop', elements, sequence, logo = null, logos } = {}) {
  const els = elements || [gate('el-1', 10, 8)];
  return {
    schemaVersion: 1,
    id,
    name,
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 0.4, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: logos ? { logos } : { logo, logoName: '' },
    elements: els,
    sequence: sequence || flyingOrder(els[0].id),
  };
}

/* Two gates twenty metres apart: a field track a synthetic lap can fly. */
const lapField = (id = 'trk-1a2b3c4d', options = {}) => field(id, {
  ...options, elements: [gate('el-1', 10, 8), gate('el-2', 30, 8)], sequence: flyingOrder('el-1', 'el-2'),
});

/* A RaceGOW room: 5 by 6 m, a 28 inch gate, one 100 mm start stand. */
function room(id = 'trk-2b3c4d5e', { flyable = false } = {}) {
  const doc = field(id, {
    elements: [
      {
        id: 'el-1', type: 'startPads', position: { x: 0, y: 1.5, z: 0 }, yaw: 0, dims: { pads: 1, spacing: 0.3, padSize: 0.1 },
      },
      { id: 'el-2', type: 'gate', position: { x: 0, y: 0.6, z: 0 }, yaw: 0, dims: ROOM_GATE_DIMS },
    ],
    sequence: flyingOrder('el-2'),
  });
  if (flyable) {
    doc.elements.push({ id: 'el-3', type: 'gate', position: { x: 2, y: 0.6, z: 0 }, yaw: 0, dims: ROOM_GATE_DIMS });
    doc.sequence = flyingOrder('el-2', 'el-3');
  }
  return { ...doc, schemaVersion: 3, trackClass: 'micro', field: { width: 5, depth: 6, gridSize: 0.0254 } };
}

/* A fixed wing's airfield: four five metre gates round 400 by 300 m, at
 * the yaws the simulator's builder gives that loop. */
function airfield(id = 'trk-3c4d5e6f') {
  const wingGate = (gid, x, y, yaw) => gate(gid, x, y, {
    yaw, dims: { levels: 1, sillH: 0, clearW: 5, clearH: 5, levelPitch: 5.0334 },
  });
  return {
    ...field(id, {
      name: 'Airfield Loop',
      elements: [wingGate('el-1', 100, 75, 0), wingGate('el-2', 300, 75, 0.643501), wingGate('el-3', 300, 225, 2.498092), wingGate('el-4', 100, 225, 3.141593)],
      sequence: flyingOrder('el-1', 'el-2', 'el-3', 'el-4'),
    }),
    schemaVersion: 3,
    trackClass: 'wing',
    field: { width: 400, depth: 300, gridSize: 5 },
    settings: { tangentScale: 1.1, minCurveRadius: 20, samplesPerSegment: 48 },
  };
}

/* A ghost blob in the simulator's format, by hand, with knobs to break
 * it: 32 byte header, a u32 per split, 20 bytes per sample. */
function ghostBlob(durationMs, {
  rateHz = 30, magic = 'FPVGHST1', version = 1, trimBytes = 0,
} = {}) {
  const samples = Math.floor((durationMs * rateHz) / 1000) + 2;
  const bytes = Buffer.alloc(32 + 4 + samples * 20);
  bytes.write(magic, 0, 'latin1');
  [version, rateHz, samples, durationMs, 1].forEach((word, i) => bytes.writeUInt32LE(word, 8 + i * 4));
  bytes.writeUInt32LE(durationMs, 32);
  for (let i = 0; i < samples; i += 1) {
    const at = 36 + i * 20;
    bytes.writeFloatLE(i * 0.4, at);
    bytes.writeFloatLE(3, at + 4);
    bytes.writeInt16LE(32767, at + 18);
  }
  return bytes.subarray(0, bytes.length - trimBytes).toString('base64');
}

/* A lap the board must take: flown through every gate by the simulator's
 * own test helper, as the base64 the simulator posts. */
function flown(document, options = {}) {
  const lap = syntheticLapBytes(document, options);
  return { ghost: b64(lap.bytes), lapMs: lap.lapMs, durationMs: lap.durationMs };
}

/* One browser's pilot key each, kept in memory the way the simulator
 * keeps one in localStorage. */
const adaKey = createIdentity(memoryStorage());
const boKey = createIdentity(memoryStorage());

/* The body the simulator posts for a time: the lap, its ghost, and the
 * pilot key's signature over exactly those. `extra` rides in the body
 * unsigned, which is how a field added after signing is tested. */
async function signedTime(identity, trackId, name, lap, extra = {}) {
  const lapMs = Math.round(lap.lapMs);
  const auth = await identity.signTime({ trackId, lapMs, ghost: lap.ghost });
  return JSON.stringify({
    name, lapMs, ghost: lap.ghost, key: auth.key, sig: auth.sig, ...extra,
  });
}

/* A plane's lap: the aircraft is in the body and under the signature. */
async function signedPlaneTime(identity, trackId, name, lap, craft) {
  const lapMs = Math.round(lap.lapMs);
  const auth = await identity.signTime({
    trackId, lapMs, ghost: lap.ghost, craft,
  });
  return JSON.stringify({
    name, lapMs, ghost: lap.ghost, key: auth.key, sig: auth.sig, craft,
  });
}

/* A board server on a free loopback port, with a scratch file store. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function bootBoard(env) {
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-board-'));
  const port = await freePort();
  const child = spawn(process.execPath, [join(repo, 'src', 'server.js')], {
    cwd: repo,
    env: {
      ...process.env, PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_FILE: join(dir, 'board.json'), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 160 && !log.includes('FDFPV leaderboard'); i += 1) {
    await sleep(50);
  }
  if (!log.includes('FDFPV leaderboard')) {
    child.kill();
    throw new Error(`the board did not start:\n${log}`);
  }
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers }),
    json: (path, headers = {}) => fetch(`${base}${path}`, { headers }).then((r) => r.json()),
    post: (path, body, headers = {}) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    async stop() {
      child.kill('SIGTERM');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/* ================================================================== */
/* Where the page's links go, worked out without the server            */
/* ================================================================== */

/*
 * The page's links have to be right whether or not /api/config answers:
 * one failed request once left every cross origin link on the loopback
 * address written into the HTML. app.js touches `document` at load and
 * cannot be imported here, which is why the guessing lives in origins.js.
 */
function originsUnit() {
  section('origins, without asking the server');
  /* The page's location and its own directory, as app.js passes them. */
  const from = (href) => [new URL(href), new URL('./', href)];
  const PAGES = 'https://fdflabs.github.io/fdfpv';
  const simCases = [
    ['a checkout on 127.0.0.1 finds the simulator on 8000', 'http://127.0.0.1:3180/', 'http://127.0.0.1:8000'],
    ['localhost by name finds it on localhost', 'http://localhost:3180/', 'http://localhost:8000'],
    ['a hash on the address changes nothing', 'http://127.0.0.1:3180/#course=trk-1a2b3c4d', 'http://127.0.0.1:8000'],
    ['the /board mount on the VM finds the simulator on GitHub Pages', 'https://129.151.39.48/board/', PAGES],
    ['and so does the bug page under that mount', 'https://129.151.39.48/board/bugs', PAGES],
    /* A board on a host of its own cannot know where the simulator is, and
     * a loopback guess there is the defect origins.js exists to prevent. */
    ['a board on its own host does not guess', 'https://fdfpv-board.onrender.com/', null],
    ['nor does one at the root of a public address', 'https://129.151.39.48/', null],
  ];
  for (const [name, href, want] of simCases) {
    check(name, guessSimOrigin(...from(href)) === want, guessSimOrigin(...from(href)));
  }
  check('no location at all is null, not a throw', guessSimOrigin(null, null) === null);
  /* The front door always has an answer: the landing page named in
   * origins.js is where the masthead's mark goes from anywhere. */
  const doorCases = [
    ['a checkout on 127.0.0.1 finds the front door on 8080', 'http://127.0.0.1:3180/', 'http://127.0.0.1:8080'],
    ['localhost by name finds it on localhost', 'http://localhost:3180/', 'http://localhost:8080'],
    ['the VM mount names the published front door, not the VM', 'https://129.151.39.48/board/', PAGES],
    ['and so does its bug page', 'https://129.151.39.48/board/bugs', PAGES],
    ['a board on its own host still names the front door', 'https://fdfpv-board.onrender.com/', PAGES],
  ];
  for (const [name, href, want] of doorCases) {
    check(name, landingOrigin(...from(href)) === want, landingOrigin(...from(href)));
  }
  check('no location at all still names the front door', landingOrigin(null, null) === PAGES);
  check('the loopback hosts are the ones a checkout uses, and no other',
    ['127.0.0.1', 'localhost', '::1'].every(isLoopback) && !isLoopback('fdfpv.example'));
}

/* ================================================================== */
/* The admin whitelist and its tokens                                   */
/* ================================================================== */

/*
 * src/admin.js reads BOARD_ADMINS once, at import, so it is imported here
 * under two query strings (two module instances): with the variable
 * unset, which is what this repository ships, and with one address.
 */
async function adminUnit() {
  section('admin');
  delete process.env.BOARD_ADMINS;
  const shipped = await import('./admin.js?nobody');
  check('nobody is an admin out of the box', shipped.adminEmails().length === 0, shipped.adminEmails().join());
  check('so no address and password open the board until BOARD_ADMINS names one',
    shipped.checkPassword('anyone@example.com', 'anything at all') === null);

  process.env.BOARD_ADMINS = `${KEEPER}:plain:${KEEPER_PASSWORD}`;
  const admin = await import('./admin.js?keeper');
  delete process.env.BOARD_ADMINS;
  check('BOARD_ADMINS is the whole list', sameMembers(admin.adminEmails(), [KEEPER]), admin.adminEmails().join());
  check('an address is trimmed and lower cased', admin.normaliseEmail('  Someone@Example.COM ') === 'someone@example.com');
  check('and what is not an address is the empty string',
    ['not an address', 'a@b', null, 'x:y@example.com'].every((raw) => admin.normaliseEmail(raw) === ''));
  check('a wrong password opens nothing', admin.checkPassword(KEEPER, 'not it') === null);
  check('an empty password opens nothing', admin.checkPassword(KEEPER, '') === null);
  check('an address off the list opens nothing, whatever it brings', admin.checkPassword('stranger@example.com', KEEPER_PASSWORD) === null);
  check('the address and its password open the board', admin.checkPassword(KEEPER, KEEPER_PASSWORD) === KEEPER);

  const token = admin.mintSession(KEEPER);
  const session = admin.readSession(token);
  check('a minted token reads back as its address', session?.email === KEEPER);
  check('and says when it runs out, in UTC', typeof session?.expiresUtc === 'string' && session.expiresUtc.endsWith('Z'));
  check('a token whose signature was changed is nobody', admin.readSession(`${token.slice(0, -2)}zz`) === null);
  const forgedClaims = Buffer.from(JSON.stringify({ e: KEEPER, x: Date.now() + 9e6 })).toString('base64url');
  check('a token whose claims were changed is nobody', admin.readSession(`v1.${forgedClaims}.${token.split('.')[2]}`) === null);
  check('an expired token is nobody', admin.readSession(admin.mintSession(KEEPER, { ms: -1000 })) === null);
  /* Checked on every read, not only at sign in, so taking an address off
   * the list locks it out at once rather than when its token expires. */
  check('a token for an address off the list is nobody', admin.readSession(admin.mintSession('gone@example.com')) === null);
  check('junk is nobody', ['', 'v1.a.b', null, 'v2.a.b'].every((junk) => admin.readSession(junk) === null));
}

/* ================================================================== */
/* What validate.js takes and refuses                                   */
/* ================================================================== */

function namesAndLaps() {
  section('validate');
  check('a pilot name is taken as typed', normaliseName('Ada Rook') === 'Ada Rook');
  check('one letter is not a name', normaliseName('A') === null);
  check('punctuation outside the set is not a name', normaliseName('Ada!') === null);
  check('a lap in milliseconds is taken', normaliseLapMs(12345) === 12345);
  check('a lap of nought is not a lap', normaliseLapMs(0) === null);
  check('true is not a lap', normaliseLapMs(true) === null);
  check('a list holding a number is not a lap', normaliseLapMs([1234]) === null);
}

function fieldDocuments() {
  const plain = inspectDocument(field());
  check('a schema 1 track publishes, with its id and its one gate', !plain.error && plain.id === 'trk-1a2b3c4d' && plain.gates === 1);
  const fieldless = field();
  delete fieldless.field;
  check('a track with no field is refused (it is what the plan is drawn on)', Boolean(inspectDocument(fieldless).error));
  /* `gates` counts what is flown through; a waypoint pins the line with
   * nothing standing there, and the plan's badges follow the same rule. */
  const pinnedLine = inspectDocument(field('trk-1a2b3c4d', {
    elements: [
      { id: 'el-1', type: 'gate', position: { x: 0, y: 0, z: 0 }, yaw: 0, dims: { levels: 1 } },
      { id: 'el-2', type: 'waypoint', position: { x: 5, y: 5, z: 0 }, yaw: 0, dims: {} },
    ],
    sequence: [{ elementId: 'el-1' }, { elementId: 'el-2' }],
  }));
  check('a waypoint in the flying order is not counted as a gate', !pinnedLine.error && pinnedLine.gates === 1);

  /* The layout keys, which the simulator's layoutFingerprint must agree on:
   * field, elements, sequence. */
  const moved = field();
  moved.elements = moved.elements.map((el) => ({ ...el, position: { ...el.position, x: 99 } }));
  check('moving a gate changes the layout hash', layoutHash(field()) !== layoutHash(moved));
  check('branding does not', layoutHash(field()) === layoutHash({ ...field(), branding: { logo: null, logoName: 'ignored' } }));
  check('an empty flying order is refused', Boolean(inspectDocument(field('trk-1a2b3c4d', { sequence: [] })).error));
  check('a flying order naming an element that is not there is refused',
    Boolean(inspectDocument(field('trk-1a2b3c4d', { sequence: flyingOrder('missing') })).error));
  check('a logo fetched from elsewhere is refused', Boolean(inspectDocument(field('trk-1a2b3c4d', { logo: 'https://evil.example/x.png' })).error));
  check('an SVG logo is refused', Boolean(inspectDocument(field('trk-1a2b3c4d', { logo: 'data:image/svg+xml;base64,PHN2Zy8+' })).error));
  const branded = inspectDocument(field('trk-1a2b3c4d', { logo: 'data:image/png;base64,aaa' }));
  check('an embedded logo is kept and flagged', !branded.error && branded.hasLogo === true);

  /* Schema 2 spells branding as a list of up to five; both spellings are
   * read because tracks under the old one are already stored. */
  const png = (chars) => `data:image/png;base64,${'a'.repeat(chars)}`;
  const logoList = (count, chars = 64) => Array.from({ length: count }, (_, i) => ({ id: `logo-${i + 1}`, image: png(chars), name: `m${i + 1}` }));
  const v2 = (logos) => ({ ...field('trk-1a2b3c4d', { logos }), schemaVersion: 2 });
  const five = inspectDocument(v2(logoList(5)));
  check('a schema 2 track with five logos publishes and counts them', !five.error && five.logoCount === 5);
  check('a sixth logo is refused', Boolean(inspectDocument(v2(logoList(6))).error));
  check('logos past their shared budget are refused', Boolean(inspectDocument(v2(logoList(3, 200 * 1024))).error));
  check('a remote image in the list is refused', Boolean(inspectDocument(v2([{ id: 'logo-1', image: 'https://evil.example/x.png', name: 'x' }])).error));

  /* Schema 3 adds the class and nothing else, so 1 and 2 keep their times
   * across a republish and read as the field they were built on. */
  const three = inspectDocument({ ...field(), schemaVersion: 3 });
  check('a schema 3 track publishes', !three.error, three.error);
  check('and with no class it is the field', three.trackClass === 'full', three.trackClass);
  check('a version nobody taught this board is still refused', Boolean(inspectDocument({ ...field(), schemaVersion: 5 }).error));

  /* Paint is not layout: a sponsor's ground logo added to a flown track
   * must not clear its times (LAYOUT_SKIP in the simulator, mirrored). */
  const painted = field();
  painted.elements = [...painted.elements, {
    id: 'el-9', type: 'groundLogo', name: '', position: { x: 30, y: 20, z: 0 }, yaw: 0, pitch: 0, yawOverridden: false, logoId: 'logo-1', dims: { width: 10, depth: 4 },
  }];
  check('paint on the grass leaves the layout hash alone', layoutHash(field()) === layoutHash(painted));
  const paintedOut = inspectDocument(painted);
  check('a ground logo is not counted as a gate', !paintedOut.error && paintedOut.gates === 1);
  check('nor drawn on the plan', !paintedOut.error && !paintedOut.plan.marks.some((m) => m.type === 'groundLogo'));
  check('a new title leaves the layout hash alone', layoutHash(field()) === layoutHash(field('trk-1a2b3c4d', { name: 'Renamed' })));

  const withPinAndFlag = inspectDocument(field('trk-1a2b3c4d', {
    elements: [
      gate('el-1', 10, 8),
      {
        id: 'el-2', type: 'waypoint', name: 'Pin', position: { x: 22, y: 18, z: 1.2 }, yaw: 0.4, pitch: 0, yawOverridden: false, dims: { height: 1.6, poleRadius: 0.02, clearance: 0 },
      },
      {
        id: 'el-3', type: 'flag', name: 'Dress', position: { x: 40, y: 30, z: 0 }, yaw: 0, pitch: 0, yawOverridden: false, dims: { height: 2.5, poleRadius: 0.025, clearance: 1.5 },
      },
    ],
    sequence: flyingOrder('el-1', 'el-2'),
  }));
  const { plan } = withPinAndFlag;
  check('the plan leaves waypoints out', plan.marks.every((m) => m.type !== 'waypoint'));
  check('but its line still runs through them, in flying order',
    plan.path.length === 2 && plan.path[0].x === 10 && plan.path[1].x === 22);
  check('a flag nobody flies is marked as off the order', plan.marks.some((m) => m.type === 'flag' && m.seq === false));
  check('the first gate in the order carries badge 1, and only gates carry badges',
    plan.numbers.length === 1 && plan.numbers[0].n === 1);
}

/* A schema 4 track: built inside one of the simulator's worlds by its
 * in-world builder, here with the builder's own functions from the pinned
 * checkout, so this is the shape a pilot's publish sends. */
function worldDocuments() {
  const ring = mapTrackDocument({ id: 'trk-4d5e6f70' });
  const out = inspectDocument(ring);
  check('a schema 4 track built on swiss2 publishes', !out.error, out.error);
  check('and knows its world', out.map === 'swiss2', out.map);
  check('and counts its three gates', out.gates === 3, `${out.gates}`);
  check('and is raced as the five inch field class', out.trackClass === 'full', out.trackClass);
  check('its plan is framed on its own gates, not on the world', out.plan.map === 'swiss2'
    && out.plan.width > 60 && out.plan.width < 200
    && out.plan.marks.every((m) => m.x >= 0 && m.y >= 0 && m.x <= out.plan.width && m.y <= out.plan.depth),
  JSON.stringify(out.plan).slice(0, 160));
  check('and every gate on it carries its badge', out.plan.numbers.map((n) => n.n).join() === '1,2,3');
  check('the worlds are swiss2 and alps, in that order, and nothing else', MAP_IDS.join() === 'swiss2,alps', MAP_IDS.join());
  check('the same ring publishes on alps', inspectDocument({ ...ring, map: 'alps' }).map === 'alps');
  const worldless = { ...ring };
  delete worldless.map;
  check('a schema 4 track naming no world is refused, and told why', /world it stands in/.test(inspectDocument(worldless).error || ''));
  for (const world of ['city', 'yellowstone', 'custom', 'SWISS2']) {
    check(`a schema 4 track on ${world} is refused`, Boolean(inspectDocument({ ...ring, map: world }).error));
  }
  const second = (change) => ({ ...ring, elements: ring.elements.map((el, i) => (i === 1 ? change({ ...el }) : el)) });
  check('an element the in-world builder cannot place is refused', Boolean(inspectDocument(second((el) => ({ ...el, type: 'flag' }))).error));
  check('so is a label', Boolean(inspectDocument(second((el) => ({ ...el, type: 'label' }))).error));
  check('every type the builder places is taken', BUILD_TYPES.every((type) => !inspectDocument(second((el) => ({ ...el, type }))).error));

  /* The lists validate.js copies out of the simulator, held to what they
   * copy. Each copy went stale once unnoticed (the sky hoops made hoop
   * tracks unpublishable; dropping the town refused every valley run). */
  check('the world element types are the builder\'s BUILD_TYPES', sameMembers(MAP_ELEMENT_TYPES, BUILD_TYPES), `${MAP_ELEMENT_TYPES} vs ${BUILD_TYPES}`);
  const buildable = MAPS.filter((m) => m.build).map((m) => m.id);
  check('the worlds are the registry\'s buildable maps', sameMembers(MAP_IDS, buildable), `${MAP_IDS} vs ${buildable}`);
  const freestyle = MAPS.filter((m) => m.mode === 'freestyle').map((m) => m.id);
  check('the run maps are the registry\'s freestyle maps', sameMembers(RUN_MAPS, freestyle), `${RUN_MAPS} vs ${freestyle}`);

  const hoops = mapTrackDocument({ id: 'trk-7a8b9c0d', types: ['hoop250', 'hoop175', 'hoop30'], radius: 60 });
  const hoopsOut = inspectDocument(hoops);
  check('a ring of sky hoops publishes', !hoopsOut.error, hoopsOut.error);
  check('with every hoop badged on its plan', hoopsOut.plan?.numbers.map((n) => n.n).join() === '1,2,3');
  const hoopLap = syntheticLapBytes(hoops);
  const hoopVerdict = checkLap(hoops, hoopLap.bytes, Math.round(hoopLap.lapMs));
  check('and a lap flown through the hoops passes the simulator\'s own check', hoopVerdict.ok === true, JSON.stringify(hoopVerdict).slice(0, 160));

  const at = (position) => second((el) => ({ ...el, position: { ...el.position, ...position } }));
  check('a gate past the world\'s edge across it is refused', Boolean(inspectDocument(at({ x: 3001 })).error));
  check('a gate past the world\'s edge along it is refused', Boolean(inspectDocument(at({ y: -3001 })).error));
  check('a gate three kilometres up is refused', Boolean(inspectDocument(at({ z: 3001 })).error));
  check('a gate under the floor is refused', Boolean(inspectDocument(at({ z: -101 })).error));
  check('a gate on the world\'s very corner is taken', !inspectDocument(second((el) => ({ ...el, position: { x: 3000, y: -3000, z: 0 } }))).error);
  check('a coordinate written as text is refused', Boolean(inspectDocument(at({ x: '10' })).error));
  check('a gate with no position is refused', Boolean(inspectDocument(second((el) => { delete el.position; return el; })).error));
  check('a gate with no orientation is refused', Boolean(inspectDocument(second((el) => { delete el.orientation; return el; })).error));
  check('an orientation that is not a rotation is refused', Boolean(inspectDocument(second((el) => ({ ...el, orientation: { w: 2, x: 0, y: 0, z: 0 } }))).error));
  check('an orientation with a hole in it is refused', Boolean(inspectDocument(second((el) => ({ ...el, orientation: { w: 1, x: 0, y: null, z: 0 } }))).error));
  check('an orientation a rounding away from unit length is taken', !inspectDocument(second((el) => ({ ...el, orientation: { w: 0.9999, x: 0, y: 0, z: 0 } }))).error);
  const tooMany = inspectDocument(mapTrackDocument({ id: 'trk-4d5e6f70', gates: 257, radius: 900 }));
  check('a world track with more gates than a ghost has splits is refused', /at most 256/.test(tooMany.error || ''), tooMany.error);
  check('one at the limit is taken', !inspectDocument(mapTrackDocument({ id: 'trk-4d5e6f70', gates: 256, radius: 900 })).error);

  /* A field track's hash must be byte for byte what it always was, or
   * every published track loses its times on its next republish; the
   * expected value is computed here from the three keys, independently. */
  const plainField = field();
  const byHand = createHash('sha256').update(JSON.stringify({
    field: plainField.field, elements: plainField.elements, sequence: plainField.sequence,
  })).digest('hex');
  check('a field track hashes exactly as it did before world tracks', layoutHash(plainField) === byHand);
  check('a field track that says map is still hashed as a field', layoutHash({ ...plainField, map: 'swiss2' }) === byHand);
  check('the same ring in another world is another layout', layoutHash(ring) !== layoutHash({ ...ring, map: 'alps' }));
  check('the same ring in the same world is the same layout', layoutHash(ring) === layoutHash(mapTrackDocument({ id: 'trk-4d5e6f70' })));
  check('a renamed ring is the same layout', layoutHash(ring) === layoutHash({ ...ring, name: 'Another name' }));
  check('turning one gate is another layout', layoutHash(ring) !== layoutHash(second((el) => ({ ...el, orientation: { w: 1, x: 0, y: 0, z: 0 } }))));
  check('raising one gate is another layout', layoutHash(ring) !== layoutHash(at({ z: ring.elements[1].position.z + 1 })));
}

function classesCreditsAndPlans() {
  const roomOut = inspectDocument(room());
  check('a RaceGOW room publishes', !roomOut.error, roomOut.error);
  check('and reads as micro', roomOut.trackClass === 'micro', roomOut.trackClass);
  check('anything that is not a known class is the field',
    [{}, null, { trackClass: 'nonsense' }].every((doc) => trackClassOf(doc) === 'full'));
  const wingOut = inspectDocument(airfield());
  check('a wing course publishes', !wingOut.error, wingOut.error);
  check('and reads as wing', wingOut.trackClass === 'wing', wingOut.trackClass);
  check('and its plan carries the class', wingOut.plan?.trackClass === 'wing', wingOut.plan?.trackClass);
  check('and keeps the airfield\'s size', wingOut.plan.width === 400 && wingOut.plan.depth === 300, `${wingOut.plan.width} by ${wingOut.plan.depth}`);
  check('the classes are the three the simulator writes, in its order', TRACK_CLASSES.join() === 'full,micro,wing', TRACK_CLASSES.join());

  /* The designer, who on the RaceGOW rooms is not the publisher. */
  const credited = inspectDocument({ ...room(), credit: { designer: '  Skittles  ', series: 'RaceGOW5', broughtOverBy: 'andAgainFPV' } });
  check('a track with a credit block publishes', !credited.error, credited.error);
  check('and the document keeps the credit as written', credited.document.credit.designer === '  Skittles  ', JSON.stringify(credited.document.credit));
  const trimmed = creditOf(credited.document);
  check('creditOf hands the page the trimmed names', trimmed.designer === 'Skittles' && trimmed.series === 'RaceGOW5', JSON.stringify(trimmed));
  check('and nothing for a track with no usable credit block',
    [room(), null, { credit: 'nonsense' }].every((doc) => creditOf(doc).designer === ''));
  /* Only strings are names; String() of an object or a list is a name
   * nobody typed. */
  const odd = creditOf({ credit: { designer: { name: 'x' }, series: ['a', 'b'] } });
  check('creditOf reads strings and nothing else', odd.designer === '' && odd.series === ''
    && creditOf({ credit: { designer: 7, series: true } }).designer === '' && creditOf({ credit: ['MrE'] }).designer === '', JSON.stringify(odd));
  const spaced = creditOf({ credit: { designer: ' Cumber \n\n and\t Hotspur\u0000 ' } });
  check('creditOf closes up whitespace and drops control characters', spaced.designer === 'Cumber and Hotspur', JSON.stringify(spaced.designer));
  check('creditOf stops a name at eighty characters', creditOf({ credit: { designer: 'x'.repeat(200) } }).designer.length === 80);
  const junkRow = rowToSummary({
    id: 'trk-00000002', name: 'Room', author: 'somebody', document: { ...room(), credit: { designer: ['a'] } }, gates: 1, elements: 1, has_logo: false, published_utc: '', updated_utc: '', tags: [],
  });
  check('a Postgres row with a junk credit still summarises, with no designer',
    junkRow.designer === '' && junkRow.series === '' && junkRow.name === 'Room', JSON.stringify(junkRow.designer));

  /* summaryOf (the file store) and rowToSummary (Postgres) write one
   * contract; the designer was once missing from one of them for a whole
   * deploy, so their shapes are compared rather than trusted. `times` and
   * `best` are added around the row by the Postgres queries. */
  const creditDoc = { ...room(), credit: { designer: 'MrE', series: 'RaceGOW5' } };
  const fromFile = summaryOf({
    id: 'trk-00000001', name: 'Room', author: 'somebody', document: creditDoc, gates: 1, elements: 1, hasLogo: false, publishedUtc: '', updatedUtc: '', tags: [],
  }, []);
  const fromRow = rowToSummary({
    id: 'trk-00000001', name: 'Room', author: 'somebody', document: creditDoc, gates: 1, elements: 1, has_logo: false, published_utc: '', updated_utc: '', tags: [],
  });
  const shape = (o) => Object.keys(o).filter((k) => k !== 'times' && k !== 'best').sort().join();
  check('both stores build a summary of the same shape', shape(fromFile) === shape(fromRow), `${shape(fromFile)} | ${shape(fromRow)}`);
  check('and both name the designer and the series',
    [fromFile, fromRow].every((s) => s.designer === 'MrE' && s.series === 'RaceGOW5'), `${fromFile.designer}/${fromRow.designer}`);

  /* The three numbers a plan cannot guess on a room: its class, a gate's
   * own opening, the start row. */
  const roomPlan = planFromDocument(room());
  check('a room\'s plan carries its class', roomPlan.trackClass === 'micro', roomPlan.trackClass);
  check('and the room\'s size, not a field\'s', roomPlan.width === 5 && roomPlan.depth === 6, `${roomPlan.width} by ${roomPlan.depth}`);
  const roomGate = roomPlan.marks.find((m) => m.type === 'gate');
  check('and the gate’s own opening', roomGate && Math.abs(roomGate.clearW - 0.7112) < 1e-9, roomGate?.clearW);
  const stand = roomPlan.marks.find((m) => m.type === 'startPads');
  check('and the start row', stand?.pads === 1 && stand.spacing === 0.3 && stand.padSize === 0.1, JSON.stringify(stand));
  const fieldPlan = planFromDocument(field());
  check('a field\'s plan is still a sixty by forty field', fieldPlan.trackClass === 'full' && fieldPlan.width === 60 && fieldPlan.depth === 40);
  const fieldGate = fieldPlan.marks.find((m) => m.type === 'gate');
  check('with its gate\'s five foot opening', fieldGate && Math.abs(fieldGate.clearW - 1.524) < 1e-9, fieldGate?.clearW);

  /* The best three consecutive laps: optional, and every way of not
   * having one is null; never faster than three of the run's own best. */
  const threeCases = [
    ['a three lap total is kept', [21590, 6990], 21590],
    ['an absent one is null', [undefined, 6990], null],
    ['an explicit null is null', [null, 6990], null],
    ['text is null, not NaN', ['21590', 6990], null],
    ['one faster than three of its own lap is null', [20000, 6990], null],
    ['exactly three of its own lap is kept', [6990 * 3, 6990], 20970],
    ['a negative one is null', [-1, 6990], null],
  ];
  for (const [name, args, want] of threeCases) {
    check(name, normaliseThreeMs(...args) === want);
  }
}

function reportsAndGhosts() {
  const words = 'Twenty characters at least in this description.';
  const good = inspectBugCreate({
    kind: 'visual', title: 'Trees flicker at the shrine', what: 'Flying past the shrine the treeline pops in and out every few frames.', reporter: 'Ada Rook', context: { map: 'city', screen: 'paused' },
  });
  check('a real report is taken, with its kind and its reporter', !good.error && good.reporter === 'Ada Rook' && good.kind === 'visual');
  check('a blank reporter is filed as Anonymous', inspectBugCreate({ kind: 'other', title: 'A short enough title here', what: words }).reporter === 'Anonymous');
  check('a one word title is refused', Boolean(inspectBugCreate({ kind: 'other', title: 'Short', what: words }).error));
  check('a kind off the list is refused', Boolean(inspectBugCreate({ kind: 'explode', title: 'A short enough title here', what: words }).error));
  check('a reporter that is not a name is refused', Boolean(inspectBugCreate({
    kind: 'other', title: 'A short enough title here', what: words, reporter: 'Ada!',
  }).error));
  check('an update with a status is taken', inspectBugPatch({ status: 'fixed', resolution: 'Trees no longer pop.' }).status === 'fixed');
  check('a status off the list is refused', Boolean(inspectBugPatch({ status: 'maybe' }).error));
  /* Feel reports already attach about twenty keys of context. */
  const context = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i]));
  const feel = (ctx) => inspectBugCreate({
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run, no complaints.', context: ctx,
  });
  check('a context of thirty two keys is taken', !feel(context).error);
  check('thirty three is refused', Boolean(feel({ ...context, k32: 32 }).error));

  const blob = ghostBlob(29110);
  check('a well formed ghost is kept as sent', inspectGhost(blob, 29110).ghost === blob);
  check('no ghost is not an error', inspectGhost(null, 29110).ghost === null && inspectGhost('', 29110).ghost === null);
  check('a ghost that is not a string is refused', Boolean(inspectGhost(42, 29110).error));
  check('a ghost that is not base64 is refused', Boolean(inspectGhost('not*base64!!'.repeat(8), 29110).error));
  check('a ghost with another format\'s magic is refused', Boolean(inspectGhost(ghostBlob(29110, { magic: 'NOTGHOST' }), 29110).error));
  check('a ghost from a format version not taught here is refused', Boolean(inspectGhost(ghostBlob(29110, { version: 3 }), 29110).error));
  check('a ghost whose length disagrees with its header is refused', Boolean(inspectGhost(ghostBlob(29110, { trimBytes: 20 }), 29110).error));
  check('a ghost for another lap time is refused', Boolean(inspectGhost(blob, 35000).error));
  check('a ghost past the size cap is refused', Boolean(inspectGhost('A'.repeat(500_004), 1000).error));
  check('a ghost claiming an hour of lap is refused', Boolean(inspectGhost(ghostBlob(3_000_000, { rateHz: 1 }), 3_000_000).error));
}

function validateUnit() {
  namesAndLaps();
  fieldDocuments();
  worldDocuments();
  classesCreditsAndPlans();
  reportsAndGhosts();
}

/* ================================================================== */
/* The file store                                                      */
/* ================================================================== */

async function withFileStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-board-'));
  delete process.env.DATABASE_URL;
  process.env.BOARD_FILE = join(dir, 'board.json');
  try {
    return await run(await openStore(), dir);
  } finally {
    delete process.env.BOARD_FILE;
    await rm(dir, { recursive: true, force: true });
  }
}

async function republishRules(store) {
  const original = inspectDocument(field());
  const first = await store.publish({ inspected: original, author: 'Ada Rook', editKey: '' });
  check('a first publish hands back an edit key', Boolean(first.editKey) && first.updated === false);
  const clash = await store.publish({ inspected: original, author: 'Ada Rook', editKey: '' });
  check('publishing the same id without the key is a 409 conflict', clash.status === 409 && clash.conflict === true);
  const again = await store.publish({ inspected: original, author: 'Ada Rook', editKey: first.editKey });
  check('with the key it is an update, and no new key is handed out', again.updated === true && !again.editKey);

  await store.addTime({ trackId: original.id, name: 'Ada Rook', lapMs: 42000 });
  const retitled = await store.publish({ inspected: inspectDocument(field('trk-1a2b3c4d', { name: 'Renamed Loop' })), author: 'Ada Rook', editKey: first.editKey });
  check('a new title keeps the times', retitled.timesCleared === false);
  const afterTitle = await store.getTrack(original.id);
  check('and the sheet shows the new title over the old time',
    afterTitle.name === 'Renamed Loop' && afterTitle.times.length === 1 && afterTitle.times[0].lapMs === 42000);

  await store.addTime({ trackId: original.id, name: 'Bo', lapMs: 51000 });
  const reauthored = await store.publish({ inspected: inspectDocument(field('trk-1a2b3c4d', { name: 'Renamed Loop' })), author: 'Ada Two', editKey: first.editKey });
  check('a new author name keeps the times', reauthored.timesCleared === false);
  const afterAuthor = await store.getTrack(original.id);
  check('and moves the author\'s own times to the new name, leaving other pilots\'',
    afterAuthor.author === 'Ada Two' && afterAuthor.times[0].name === 'Ada Two' && afterAuthor.times[1].name === 'Bo');

  const relaid = await store.publish({ inspected: inspectDocument(field('trk-1a2b3c4d', { elements: [gate('el-1', 20, 8)] })), author: 'Ada Rook', editKey: first.editKey });
  check('moving a gate clears the times, which were flown on another layout', relaid.timesCleared === true);
  check('and the sheet has none left', (await store.getTrack(original.id)).times.length === 0);
  return first.editKey;
}

async function timesAndGhosts(store) {
  const id = 'trk-1a2b3c4d';
  check('the fastest lap on the board is rank 1', (await store.addTime({ trackId: id, name: 'Ada Rook', lapMs: 33400 })).rank === 1);
  check('a slower one is rank 2', (await store.addTime({ trackId: id, name: 'Bo', lapMs: 40000 })).rank === 2);
  await Promise.all([
    store.addTime({ trackId: id, name: 'Cy', lapMs: 45000 }),
    store.addTime({ trackId: id, name: 'Di', lapMs: 46000 }),
  ]);
  check('two posts at once both land', (await store.getTrack(id)).times.length === 4);

  const blob = ghostBlob(47000);
  const ghosted = await store.addTime({ trackId: id, name: 'Ev', lapMs: 47000, ghost: blob });
  check('a time is given a public id', /^tm-[0-9a-f]{8}$/.test(String(ghosted.id)));
  const sheet = await store.getTrack(id);
  const ev = sheet.times.find((t) => t.name === 'Ev');
  check('the sheet says the time has a ghost without carrying it', ev?.hasGhost === true && !('ghost' in ev));
  check('and the times posted without one say so', sheet.times.filter((t) => t.name !== 'Ev').every((t) => t.hasGhost === false));
  const back = await store.getGhost(id, ghosted.id);
  check('the ghost comes back whole, with its lap', back?.ghost === blob && back.lapMs === 47000);
  check('a time id nobody posted has no ghost', (await store.getGhost(id, 'tm-00000000')) === null);

  const withThree = await store.addTime({ trackId: id, name: 'Fi', lapMs: 48000, threeMs: 146000 });
  check('a three lap total posted comes back', withThree.threeMs === 146000, withThree.threeMs);
  const fi = (await store.getTrack(id)).times.find((t) => t.name === 'Fi');
  check('and is in the sheet', fi?.threeMs === 146000, fi?.threeMs);
  const ada = (await store.getTrack(id)).times.find((t) => t.name === 'Ada Rook');
  check('a time posted without one lists null, never undefined', ada?.threeMs === null, String(ada?.threeMs));

  /* A row as the board wrote it before ghosts: no id, no ghost key. */
  store.data.times[id].push({ name: 'Old Row', lapMs: 60000, postedUtc: '2026-01-01T00:00:00.000Z' });
  const old = (await store.getTrack(id)).times.find((t) => t.name === 'Old Row');
  check('a time from before ghosts lists with a null id and no ghost', old?.id === null && old.hasGhost === false);
  const list = await store.listTracks();
  check('the listing names the author and the record', list[0].author === 'Ada Rook' && list[0].best.lapMs === 33400);
  /* A stale stored plan with a waypoint drawn as a gate: the listing must
   * draw from the document instead. */
  store.data.tracks[id].plan = { width: 60, depth: 40, marks: [{ type: 'waypoint', x: 1, y: 1, yaw: 0 }] };
  const redrawn = (await store.listTracks())[0].plan;
  check('the listing\'s plan is drawn from the document, not the stored plan',
    redrawn.marks.every((m) => m.type !== 'waypoint') && redrawn.path.length === 1 && redrawn.path[0].x === 20);
  check('and the document is still there', (await store.getDocument(id)).document.id === id);
}

async function ticketsInTheStore(store) {
  const filed = await store.addBug(inspectBugCreate({
    kind: 'feel', title: 'Yaw feels late on the field', what: 'A right yaw stick on the field map takes a beat before the quad turns.', reporter: 'Ada Rook', context: { map: 'field', screen: 'flight' },
  }));
  check('a filed ticket gets an id and is open', /^bug-[0-9a-f]{8}$/.test(String(filed.id)) && filed.status === 'open');
  const open = await store.listBugs({ status: 'open' });
  check('the open list names it', open.length === 1 && open[0].id === filed.id && open[0].title === filed.title);
  const full = await store.getBug(filed.id);
  check('the whole ticket keeps what happened and the context', full.what.includes('yaw stick') && full.context.map === 'field');
  const fixed = await store.updateBug(filed.id, { status: 'fixed', resolution: 'Checked rates. Not a sim bug.' });
  check('an update marks it fixed, with the resolution', fixed.status === 'fixed' && fixed.resolution.includes('rates'));
  check('and it leaves the open list', (await store.listBugs({ status: 'open' })).length === 0);
  check('updating a ticket that is not there is a 404', (await store.updateBug('bug-00000000', { status: 'open' })).status === 404);

  const kinds = inspectBugImages([`data:image/png;base64,${b64(PNG_1PX)}`, b64(JPEG_HEAD), `data:image/webp;base64,${b64(WEBP_HEAD)}`]);
  check('PNG, JPEG and WebP screenshots are known by their magic bytes',
    !kinds.error && kinds.images.map((i) => i.type).join() === 'image/png,image/jpeg,image/webp');
  const mislabelled = inspectBugImages([`data:image/png;base64,${b64(JPEG_HEAD)}`]);
  check('the type kept is the bytes\', not the label\'s', !mislabelled.error && mislabelled.images[0].type === 'image/jpeg');
  check('markup sent as an image is refused',
    /not a PNG, JPEG or WebP/.test(inspectBugImages([b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))]).error || ''));
  check('an image over a mebibyte is refused',
    /larger than a megabyte/.test(inspectBugImages([b64(Buffer.concat([PNG_1PX, Buffer.alloc(MAX_BUG_IMAGE_BYTES)]))]).error || ''));
  check('a fifth image is refused', /at most four/.test(inspectBugImages(Array(5).fill(b64(PNG_1PX))).error || ''));
  check('images that are not a list are refused', Boolean(inspectBugImages('nope').error));
  check('a report with no images carries an empty list',
    inspectBugCreate({ kind: 'other', title: 'No pictures here', what: 'Twenty characters or more of words.' }).images.length === 0);

  const shot = await store.addBug(inspectBugCreate({
    kind: 'visual', title: 'Screenshot attached here', what: 'The picture shows it better than twenty words do.', images: [b64(PNG_1PX), b64(JPEG_HEAD)],
  }));
  check('a ticket lists its images by number, type and size', shot.images.length === 2 && shot.images[0].n === 1
    && shot.images[0].type === 'image/png' && shot.images[0].size === PNG_1PX.length && shot.images[1].type === 'image/jpeg');
  const image = await store.getBugImage(shot.id, 1);
  check('the file store hands a screenshot back byte for byte', image?.type === 'image/png' && image.bytes.equals(PNG_1PX));
  check('an image number the ticket does not have is null', (await store.getBugImage(shot.id, 3)) === null);
  check('an update keeps the ticket\'s images', (await store.updateBug(shot.id, { status: 'in_progress' })).images.length === 2);
  check('a ticket filed without images reads as having none', (await store.getBug(filed.id)).images.length === 0);
}

async function storeUnit() {
  section('store');
  await withFileStore(async (store) => {
    await republishRules(store);
    await timesAndGhosts(store);
    await ticketsInTheStore(store);
  });
  /* A board.json from before tickets existed is old, not corrupt. */
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-board-legacy-'));
  try {
    await writeFile(join(dir, 'board.json'), JSON.stringify({ tracks: {}, times: {} }), 'utf8');
    process.env.BOARD_FILE = join(dir, 'board.json');
    const legacy = await openStore();
    const tickets = await legacy.listBugs();
    check('a board.json from before tickets lists no tickets rather than failing', Array.isArray(tickets) && tickets.length === 0);
    const tracks = await legacy.listTracks();
    check('and still lists its tracks', Array.isArray(tracks) && tracks.length === 0);
  } finally {
    delete process.env.BOARD_FILE;
    await rm(dir, { recursive: true, force: true });
  }
}

/* ================================================================== */
/* Site statistics: the wire format and the counters                    */
/* ================================================================== */

/*
 * What these checks guard is a promise more than a feature: the page says
 * nothing identifying is taken or kept, and these fail if that stops being
 * true. The closed vocabularies are the other side of it: they are what
 * stops a stranger with curl growing a table on a public page.
 */
function statsWireFormat() {
  const take = (body) => inspectStatsEvent(body, sourceKey);
  check('a visit is taken', !take({ v: 1, kind: 'visit', surface: 'sim', returning: false }).error);
  check('a session is taken', !take({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad' }).error);
  check('a flush is taken', !take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: 'whoop65', laps: 2, flightS: 44 }).error);
  check('a format version this board cannot read is refused', Boolean(take({ v: 2, kind: 'visit' }).error));
  check('a kind of event it does not count is refused', Boolean(take({ v: 1, kind: 'pageview' }).error));
  check('a visit from a page it does not know is refused', Boolean(take({ v: 1, kind: 'visit', surface: 'somewhere', returning: false }).error));
  check('a visit that does not say new or returning is refused', Boolean(take({ v: 1, kind: 'visit', surface: 'sim' }).error));
  check('the two ids older clients send are still counted as themselves', ['5inch', 'whoop65'].every((id) => take({
    v: 1, kind: 'session', craft: id, map: 'custom', input: 'gamepad',
  }).event.craft === id));
  return take;
}

async function statsAirframes(take) {
  /* The pinned simulator's catalogue, always: re-pinning vendor/fdfpv onto
   * a simulator with a new airframe fails here until scripts/airframes.js
   * has added it to src/airframes.js. */
  const pinned = (await import('../vendor/fdfpv/configs/airframes.js')).AIRFRAME_IDS;
  check('every airframe in the pinned simulator\'s catalogue is counted as itself', pinned.length >= 20 && pinned.every((id) => (
    take({ v: 1, kind: 'session', craft: id, map: 'custom', input: 'gamepad' }).event.craft === id
    && take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: id, flightS: 5 }).event.craft === id
  )), pinned.filter((id) => !STATS_CRAFT.includes(id)).join());
  /* And the simulator's current catalogue from a checkout of it, which can
   * be ahead of the pin. */
  const catalogue = process.env.FDFPV_AIRFRAMES;
  if (!catalogue) {
    skip('FDFPV_AIRFRAMES (path to the simulator\'s configs/airframes.js) is not set');
    return;
  }
  const ids = (await import(catalogue)).AIRFRAME_IDS;
  check('every airframe in the simulator\'s catalogue is counted as itself, in a session and a flush', ids.length >= 20 && ids.every((id) => (
    take({ v: 1, kind: 'session', craft: id, map: 'custom', input: 'gamepad' }).event.craft === id
    && take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: id, flightS: 5 }).event.craft === id
  )), ids.filter((id) => !STATS_CRAFT.includes(id)).join());
}

function statsFolds(take) {
  /* An unknown aircraft folds rather than refusing: the simulator adds
   * airframes without asking, and a refusal would drop the session. */
  check('an aircraft never heard of folds to other, in a session and a flush', ['tinywhoop', 'Sky Hunter!', '', 'x'.repeat(500), 7, null].every((raw) => (
    take({ v: 1, kind: 'session', craft: raw, map: 'custom', input: 'gamepad' }).event?.craft === 'other'
    && take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: raw, flightS: 5 }).event?.craft === 'other'
  )));
  check('naming no aircraft at all is other too',
    take({ v: 1, kind: 'session', map: 'custom' }).event?.craft === 'other' && take({ v: 1, kind: 'flush', tab: 'aaaa1111' }).event?.craft === 'other');
  check('a long tab handle is refused', Boolean(take({ v: 1, kind: 'flush', tab: 'x'.repeat(200), craft: '5inch' }).error));
  check('a tab handle with punctuation is refused', Boolean(take({ v: 1, kind: 'flush', tab: 'aaaa1111;DROP', craft: '5inch' }).error));
  check('more laps than a minute holds is refused', Boolean(take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 31 }).error));
  check('more flight seconds than a minute holds is refused', Boolean(take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', flightS: 91 }).error));
  check('a negative count is refused', Boolean(take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: -3 }).error));
  /* A map or input from a newer simulator folds: refusing would have an
   * older board drop every session once the simulator gained one. */
  check('a map never heard of folds to other', take({ v: 1, kind: 'session', craft: '5inch', map: 'bando', input: 'gamepad' }).event.map === 'other');
  check('an input never heard of folds to other', take({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'eye-tracker' }).event.input === 'other');

  /* Nothing identifying gets through, because the event that comes out has
   * exactly the fields the store reads and nowhere else to put anything. */
  const visit = take({
    v: 1, kind: 'visit', surface: 'sim', returning: true, ip: '203.0.113.7', ua: 'Mozilla/5.0', pilot: 'Ada Rook', referrer: 'https://example.com/',
  }).event;
  check('a visit comes out with the counted fields and nothing else', Object.keys(visit).sort().join() === 'kind,returning,source,surface');
  const flush = take({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 1, name: 'Ada Rook' }).event;
  check('so does a flush', Object.keys(flush).sort().join() === 'craft,crashes,flightS,kind,laps,map,source,tab');

  /* This process has no BOARD_SPONSORS, so every named source is unknown,
   * which is the case that matters. */
  check('no source is direct', sourceKey(undefined) === 'direct');
  check('an empty source is direct', sourceKey('') === 'direct');
  check('a source this board never heard of is other', sourceKey('rotorriot') === 'other');
  check('and a hundred of them are still one row', new Set(Array.from({ length: 100 }, (_, i) => sourceKey(`sponsor-${i}`))).size === 1);
  check('the source is folded before anything is stored', take({ v: 1, kind: 'visit', surface: 'sim', returning: false, source: 'made-up' }).event.source === 'other');

  const countries = [
    ['a country code is taken as it comes', 'AU', 'AU'],
    ['lower case is the same country', 'au', 'AU'],
    ['rubbish is unknown', 'not-a-country', 'ZZ'],
    ['no header is unknown', undefined, 'ZZ'],
    ['the edge\'s own "no country" is unknown', 'XX', 'ZZ'],
    ['a Tor exit is unknown', 'T1', 'ZZ'],
    ['an address is never a country', '203.0.113.7', 'ZZ'],
  ];
  for (const [name, raw, want] of countries) {
    check(name, normaliseCountry(raw) === want);
  }
  /* The server's UTC day: a browser cannot name it, and moving a host to
   * another region must not move the boundary. */
  check('the day is the UTC day', statsDay(new Date('2026-09-21T23:59:59Z')) === '2026-09-21');
  check('and a second after midnight is the next one', statsDay(new Date('2026-09-22T00:00:01Z')) === '2026-09-22');
}

async function statsCounters(take) {
  await withFileStore(async (store) => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    const today = '2026-09-21';
    const yesterday = '2026-09-20';
    const count = (body, day = today, country = 'AU') => store.recordStats(take(body).event, { day, country });
    await count({ v: 1, kind: 'visit', surface: 'sim', returning: false });
    await count({ v: 1, kind: 'visit', surface: 'board', returning: true });
    await count({ v: 1, kind: 'visit', surface: 'sim', returning: true }, today, 'NZ');
    await count({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad' });
    await count({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 3, flightS: 58, crashes: 1 });
    await count({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 2, flightS: 41, crashes: 2 });
    await count({ v: 1, kind: 'flush', tab: 'bbbb2222', craft: 'whoop65', laps: 4, flightS: 60 }, yesterday, 'ZZ');

    const week = await store.readStats({ days: 7, now });
    check('a new browser moves only the new column', week.today.newVisitors === 1 && week.today.returningVisitors === 2);
    check('and every visit is counted', week.today.visits === 3);
    check('two flushes add up rather than replace', week.today.laps === 5 && week.today.flightS === 99 && week.today.crashes === 3);
    check('a session is counted once', week.today.sessions === 1);
    check('yesterday\'s laps stay on yesterday', week.days[week.days.length - 2].laps === 4);
    check('the window is as many days as asked for', week.days.length === 7);
    check('the days run consecutively and end today', week.days[0].day === '2026-09-15' && week.days[6].day === today);
    check('a day nobody visited is a row of noughts, not a gap', week.days[0].visits === 0 && week.days[0].laps === 0);
    check('the window sums both days', week.window.laps === 9 && week.window.visits === 3);

    const country = (key) => week.countries.find((r) => r.key === key) || {};
    check('a visit is counted against its country', country('AU').visits === 2);
    check('a second country gets a row of its own', country('NZ').visits === 1);
    check('laps are counted against the country that flew them', country('AU').laps === 5);
    check('two named countries count as two', week.window.countries === 2);
    check('and unknown is not one of them, and sits at the foot', week.countries[week.countries.length - 1].key === 'ZZ');
    const craft = week.craft.find((r) => r.key === '5inch') || {};
    check('the aircraft is counted from its session', craft.sessions === 1);
    check('and its laps from the flushes', craft.laps === 5);
    check('the input is counted', (week.inputs.find((r) => r.key === 'gamepad') || {}).sessions === 1);
    check('the page a visit came from is counted', (week.surfaces.find((r) => r.key === 'sim') || {}).visits === 2);

    /* An empty heartbeat moves the day's flight seconds and no dimension,
     * which keeps that table in proportion to flying, not idling. */
    const craftRows = JSON.stringify(week.craft);
    await count({ v: 1, kind: 'flush', tab: 'cccc3333', craft: '5inch', laps: 0, flightS: 30 });
    const after = await store.readStats({ days: 7, now });
    check('a heartbeat with no laps adds its seconds', after.today.flightS === 129);
    check('and no dimension row', JSON.stringify(after.craft) === craftRows);
    check('all time is every day there has been', after.allTime.laps === 9);
    check('and knows when counting started', after.firstDay === yesterday);

    /* The board's own tables, which are not counters and never were. */
    await store.publish({ inspected: inspectDocument(field()), author: 'Ada Rook', editKey: 'k' });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'Ada Rook', lapMs: 29110 });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'ada rook', lapMs: 28110 });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'Bo', lapMs: 31000 });
    const facts = await store.boardFacts();
    check('the board counts its own tracks and times', facts.tracks === 1 && facts.times === 3);
    check('a pilot capitalised two ways is one pilot', facts.pilots === 2);
    check('and nobody has come back on another day yet', facts.pilotsOnMoreThanOneDay === 0);
  });
}

async function statsUnit() {
  section('site statistics');
  const take = statsWireFormat();
  await statsAirframes(take);
  statsFolds(take);
  await statsCounters(take);
}

/* ================================================================== */
/* Over HTTP: tracks, times, signatures                                 */
/* ================================================================== */

/*
 * The HTTP half shares one server and runs in order: later checks read
 * what earlier ones wrote (the statistics facts count the tracks the
 * suite published and removed). `s` carries what they hand on.
 */
async function timesOverHttp(board, s) {
  const health = await board.json('/api/health');
  check('the board answers its health check, naming its store', health.ok === true && health.store === s.kind);
  const version = await board.json('/api/version');
  check('a checkout with no REVISION names no commits', version.commit === null && version.fdfpv === null, JSON.stringify(version));

  const created = await board.post('/api/tracks', { author: 'Ada Rook', document: lapField() });
  const createdBody = await created.json();
  check('a track publishes over HTTP', created.status === 201 && createdBody.id === 'trk-1a2b3c4d');
  s.fieldKey = createdBody.editKey;
  s.adaLap = flown(lapField());
  const T = '/api/tracks/trk-1a2b3c4d/times';
  const posted = await board.post(T, await signedTime(adaKey, 'trk-1a2b3c4d', 'Ada Rook', s.adaLap));
  const postedBody = await posted.json();
  check('a signed, honest lap goes on the board at rank 1', posted.status === 201 && postedBody.rank === 1, `${posted.status} ${JSON.stringify(postedBody).slice(0, 120)}`);
  check('a time with no ghost is refused', (await board.post(T, { name: 'Ada Rook', lapMs: s.adaLap.lapMs })).status === 400);
  const unsigned = await board.post(T, { name: 'Ada Rook', lapMs: Math.round(s.adaLap.lapMs), ghost: s.adaLap.ghost });
  check('a time with no signature is refused', unsigned.status === 400, `${unsigned.status}`);
  /* 100 ms is inside the ghost's own slack, so only the signature can
   * notice the lap was changed after it was signed. */
  const forged = JSON.parse(await signedTime(adaKey, 'trk-1a2b3c4d', 'Ada Rook', s.adaLap));
  forged.lapMs -= 100;
  const forgedPost = await board.post(T, forged);
  check('a signed post whose lap was changed afterwards is refused', forgedPost.status === 401, `${forgedPost.status}`);
  const squat = await board.post(T, await signedTime(boKey, 'trk-1a2b3c4d', 'ada rook', s.adaLap));
  const squatBody = await squat.json();
  check('another key posting under a claimed name is refused, whatever its case',
    squat.status === 403 && /belongs to another pilot/.test(squatBody.error), `${squat.status} ${squatBody.error}`);

  const retitled = await board.post('/api/tracks', { author: 'Ada Rook', document: { ...lapField(), name: 'HTTP Rename' }, editKey: s.fieldKey });
  const retitledBody = await retitled.json();
  check('a new title republishes and keeps the times', retitled.status === 200 && retitledBody.updated === true && retitledBody.timesCleared !== true);
  const sheet = await board.json('/api/tracks/trk-1a2b3c4d');
  check('the sheet shows the new title over the time', sheet.name === 'HTTP Rename' && sheet.times[0].lapMs === Math.round(s.adaLap.lapMs));
  const reauthored = await board.post('/api/tracks', { author: 'Ada Two', document: { ...lapField(), name: 'HTTP Rename' }, editKey: s.fieldKey });
  const reauthoredBody = await reauthored.json();
  check('a new author name republishes and keeps the times', reauthored.status === 200 && reauthoredBody.updated === true && reauthoredBody.timesCleared !== true);
  const afterAuthor = await board.json('/api/tracks/trk-1a2b3c4d');
  check('and the author\'s own time follows the new name', afterAuthor.author === 'Ada Two' && afterAuthor.times[0].name === 'Ada Two');

  s.boLap = flown(lapField(), { speed: 15 });
  const boPost = await board.post(T, await signedTime(boKey, 'trk-1a2b3c4d', 'Bo', s.boLap));
  const boBody = await boPost.json();
  check('a time posted with its ghost gets a public id', boPost.status === 201 && /^tm-[0-9a-f]{8}$/.test(String(boBody.id)));
  const listed = (await board.json('/api/tracks/trk-1a2b3c4d')).times.find((t) => t.name === 'Bo');
  check('the sheet says there is a ghost without carrying it', listed?.hasGhost === true && listed.ghost === undefined);
  const ghost = await board.get(`/api/tracks/trk-1a2b3c4d/times/${boBody.id}/ghost`);
  const ghostBody = await ghost.json();
  check('the ghost is fetched whole', ghost.status === 200 && ghostBody.ghost === s.boLap.ghost && ghostBody.lapMs === Math.round(s.boLap.lapMs));
  /* Hovering past the line and claiming the whole recording as the lap. */
  const hover = flown(lapField(), { hoverAfterMs: 1500 });
  const padded = await board.post(T, await signedTime(boKey, 'trk-1a2b3c4d', 'Bo', { ghost: hover.ghost, lapMs: hover.durationMs }));
  const paddedBody = await padded.json();
  check('a ghost that hovers past the line cannot claim the longer time', padded.status === 422 && /does not hold up/.test(paddedBody.error), `${padded.status} ${paddedBody.error}`);
  const oddGhost = await board.get('/api/tracks/trk-1a2b3c4d/times/constructor/ghost');
  check('a ghost address that is not a time id is a 400 or 404, never a 500', oddGhost.status === 400 || oddGhost.status === 404);
  check('a malformed ghost is refused, not stored', (await board.post(T, { name: 'Bo', lapMs: 31500, ghost: 'AAAA', key: 'x', sig: 'y' })).status === 400);
  check('a ghost posted beside another lap time is refused', (await board.post(T, await signedTime(boKey, 'trk-1a2b3c4d', 'Bo', { ghost: s.boLap.ghost, lapMs: 90000 }))).status === 400);
  const nowhere = await board.post('/api/tracks/trk-0000dead/times', await signedTime(boKey, 'trk-0000dead', 'Bo', s.boLap));
  check('a time for a track that is not on the board is a 404', nowhere.status === 404, `${nowhere.status}`);

  /* A wing course through the wing class's five metre gates, checked by
   * the simulator's vendored lap check. */
  const wingPub = await board.post('/api/tracks', { author: 'Ada Rook', document: airfield() });
  const wingPubBody = await wingPub.json();
  check('a wing course publishes over HTTP', wingPub.status === 201 && wingPubBody.id === 'trk-3c4d5e6f', `${wingPub.status}`);
  const wingRow = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-3c4d5e6f');
  check('and the listing calls it a wing course', wingRow?.trackClass === 'wing', wingRow?.trackClass);
  const cruise = flown(airfield(), { speed: 20 });
  const wingPost = await board.post('/api/tracks/trk-3c4d5e6f/times', await signedTime(adaKey, 'trk-3c4d5e6f', 'Ada Rook', cruise));
  const wingPostBody = await wingPost.json();
  check('a signed wing lap at cruise goes on at rank 1', wingPost.status === 201 && wingPostBody.rank === 1, `${wingPost.status} ${JSON.stringify(wingPostBody).slice(0, 120)}`);
  const missedGate = flown(airfield(), { speed: 20, skip: 2 });
  const wingSkip = await board.post('/api/tracks/trk-3c4d5e6f/times', await signedTime(boKey, 'trk-3c4d5e6f', 'Bo', { ghost: missedGate.ghost, lapMs: missedGate.durationMs }));
  const wingSkipBody = await wingSkip.json();
  check('a wing lap that missed a gate is refused', wingSkip.status === 422 && /does not hold up/.test(wingSkipBody.error), `${wingSkip.status} ${wingSkipBody.error}`);
}

async function worldTracksOverHttp(board, s) {
  section('map tracks');
  s.ring = mapTrackDocument({ id: 'trk-4d5e6f70', name: 'Ring over the drop' });
  const pub = await board.post('/api/tracks', { author: 'Ada Rook', document: s.ring });
  const pubBody = await pub.json();
  check('a swiss2 world track publishes over HTTP', pub.status === 201 && pubBody.id === 'trk-4d5e6f70' && Boolean(pubBody.editKey), `${pub.status} ${JSON.stringify(pubBody).slice(0, 120)}`);
  const listing = await board.json('/api/tracks');
  const row = listing.tracks.find((t) => t.id === 'trk-4d5e6f70');
  check('the listing names its world, its class and its gates', row?.map === 'swiss2' && row.trackClass === 'full' && row.gates === 3,
    row && JSON.stringify({ map: row.map, trackClass: row.trackClass, gates: row.gates }));
  check('while a field track in the same listing names no world', listing.tracks.find((t) => t.id === 'trk-1a2b3c4d').map === null);
  const served = await board.json('/api/tracks/trk-4d5e6f70/document');
  const doc = served.document || served;
  check('its document comes back whole', doc.schemaVersion === 4 && doc.map === 'swiss2' && sortedJson(doc.elements) === sortedJson(s.ring.elements));
  const lap = flown(s.ring);
  const T = '/api/tracks/trk-4d5e6f70/times';
  const posted = await board.post(T, await signedTime(adaKey, 'trk-4d5e6f70', 'Ada Rook', lap));
  const postedBody = await posted.json();
  check('a signed lap of the ring is checked and kept', posted.status === 201 && postedBody.rank === 1, `${posted.status} ${JSON.stringify(postedBody).slice(0, 160)}`);
  const ghost = await board.json(`/api/tracks/trk-4d5e6f70/times/${postedBody.id}/ghost`);
  check('and its ghost is there to chase', ghost.ghost === lap.ghost && ghost.lapMs === Math.round(lap.lapMs));
  const cut = flown(s.ring, { skip: 1 });
  const cutPost = await board.post(T, await signedTime(boKey, 'trk-4d5e6f70', 'Bo', { ghost: cut.ghost, lapMs: cut.durationMs }));
  const cutBody = await cutPost.json();
  check('a lap of the ring that missed a gate is refused', cutPost.status === 422 && /does not hold up/.test(cutBody.error), `${cutPost.status} ${cutBody.error}`);
  const fieldLap = await board.post(T, await signedTime(boKey, 'trk-4d5e6f70', 'Bo', s.boLap));
  check('and so is a field lap posted to it', fieldLap.status === 422 || fieldLap.status === 400, `${fieldLap.status}`);
  const ringSheet = await board.json('/api/tracks/trk-4d5e6f70');
  check('the ring holds its own time and nobody else\'s', ringSheet.times.length === 1 && ringSheet.times[0].name === 'Ada Rook');
  const fieldSheet = await board.json('/api/tracks/trk-1a2b3c4d');
  check('and the field track kept only its own', fieldSheet.times.every((t) => t.name !== 'Ada Rook' || t.lapMs !== Math.round(lap.lapMs)));
  const renamed = await board.post('/api/tracks', { author: 'Ada Rook', document: { ...s.ring, name: 'Ring, renamed' }, editKey: pubBody.editKey });
  const renamedBody = await renamed.json();
  check('renaming the ring keeps its time', renamed.status === 200 && renamedBody.timesCleared !== true, `${renamed.status} ${JSON.stringify(renamedBody).slice(0, 120)}`);
  const moved = await board.post('/api/tracks', { author: 'Ada Rook', document: { ...s.ring, map: 'alps' }, editKey: pubBody.editKey });
  const movedBody = await moved.json();
  check('moving the ring to another world clears its times', moved.status === 200 && movedBody.timesCleared === true, `${moved.status} ${JSON.stringify(movedBody).slice(0, 120)}`);
  const movedRow = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-4d5e6f70');
  check('and the listing follows it there', movedRow.map === 'alps' && movedRow.times === 0, JSON.stringify({ map: movedRow.map, times: movedRow.times }));
  const town = await board.post('/api/tracks', { author: 'Ada Rook', document: mapTrackDocument({ id: 'trk-5e6f7081', map: 'city' }) });
  check('a world track in the town is refused over HTTP', town.status === 400, `${town.status}`);
}

/* Plane sized gates (the two wide gates and the air race pylon pair) take
 * every fixed wing, and a plane's lap names its aircraft and files on a
 * board of its own beside the quads'. */
async function planesOverHttp(board, s) {
  section('planes on a map track');
  const wide = mapTrackDocument({ id: 'trk-6f708192', name: 'Wide ring', radius: 70, types: ['wideGate5', 'pylonPair', 'wideGate3'] });
  check('a ring of plane sized gates publishes', (await board.post('/api/tracks', { author: 'Ada Rook', document: wide })).status === 201);
  const row = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-6f708192');
  check('the listing names every fixed wing as fitting it',
    Array.isArray(row.planes) && ['sky1800', 'bramor2300', 'timber1500f'].every((p) => row.planes.includes(p)), JSON.stringify(row.planes));
  check('with an empty plane board beside the quads\'', row.wing?.times === 0 && row.wing.best === null, JSON.stringify(row.wing));
  const fieldRow = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-1a2b3c4d');
  check('a field track has no plane board and fits no plane', fieldRow.planes.length === 0 && fieldRow.wing === null, JSON.stringify({ planes: fieldRow.planes, wing: fieldRow.wing }));
  const slow = flown(wide, { speed: 18 });
  const fast = flown(wide, { speed: 24 });
  const T = '/api/tracks/trk-6f708192/times';
  const sky = await board.post(T, await signedPlaneTime(adaKey, 'trk-6f708192', 'Ada Rook', slow, 'sky1800'));
  const skyBody = await sky.json();
  check('a Skyhunter\'s lap is checked and kept, first on the plane board',
    sky.status === 201 && skyBody.rank === 1 && skyBody.times === 1 && skyBody.craft === 'sky1800', `${sky.status} ${JSON.stringify(skyBody).slice(0, 160)}`);
  const quad = await board.post(T, await signedTime(boKey, 'trk-6f708192', 'Bo', fast));
  const quadBody = await quad.json();
  check('a quad through the same gates is first on its own board, not ranked with the plane',
    quad.status === 201 && quadBody.rank === 1 && quadBody.times === 1 && quadBody.craft === null, `${quad.status} ${JSON.stringify(quadBody).slice(0, 160)}`);
  const floats = await board.post(T, await signedPlaneTime(boKey, 'trk-6f708192', 'Bo', fast, 'timber1500f'));
  const floatsBody = await floats.json();
  check('the faster Timber on floats takes first on the plane board', floats.status === 201 && floatsBody.rank === 1 && floatsBody.times === 2, `${floats.status} ${JSON.stringify(floatsBody).slice(0, 160)}`);
  const sheet = await board.json('/api/tracks/trk-6f708192');
  check('the sheet carries every time with the aircraft that flew it', sheet.times.length === 3
    && sheet.times.filter((t) => t.craft).map((t) => t.craft).join() === 'timber1500f,sky1800'
    && sheet.times.filter((t) => !t.craft).length === 1, JSON.stringify(sheet.times.map((t) => [t.name, t.lapMs, t.craft])));
  check('the quads\' record is the quad\'s and the planes\' the plane\'s',
    sheet.best?.name === 'Bo' && sheet.times.find((t) => !t.craft).lapMs === sheet.best.lapMs
    && sheet.wing.times === 2 && sheet.wing.best.lapMs === floatsBody.lapMs, JSON.stringify({ best: sheet.best, wing: sheet.wing }));
  const listed = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-6f708192');
  check('and the listing counts the two boards apart', listed.times === 1 && listed.wing.times === 2, JSON.stringify({ times: listed.times, wing: listed.wing }));
  check('a plane\'s ghost is there to chase', (await board.json(`/api/tracks/trk-6f708192/times/${floatsBody.id}/ghost`)).ghost === fast.ghost);
  const regilded = await board.post(T, await signedTime(adaKey, 'trk-6f708192', 'Ada Rook', slow, { craft: 'bramor2300' }));
  check('a quad\'s signed lap given a plane afterwards is refused: the aircraft is under the signature', regilded.status === 401, `${regilded.status}`);
  const quadNamed = await board.post(T, await signedPlaneTime(adaKey, 'trk-6f708192', 'Ada Rook', slow, '5inch'));
  const quadNamedBody = await quadNamed.json();
  check('a lap naming a quad as its aircraft is refused by the lap check', quadNamed.status === 422 && /not a fixed wing/.test(quadNamedBody.error), `${quadNamed.status} ${quadNamedBody.error}`);
  const badCraft = await board.post(T, JSON.stringify({ ...JSON.parse(await signedTime(adaKey, 'trk-6f708192', 'Ada Rook', slow)), craft: 'Sky Hunter!' }));
  check('an aircraft that is not an airframe id is refused before anything else', badCraft.status === 400, `${badCraft.status}`);
  const tight = await board.post('/api/tracks/trk-4d5e6f70/times', await signedPlaneTime(adaKey, 'trk-4d5e6f70', 'Ada Rook', flown(s.ring), 'sky1800'));
  const tightBody = await tight.json();
  check('a Skyhunter through five inch gates is refused: it does not fit', tight.status === 422 && /does not fit/.test(tightBody.error), `${tight.status} ${tightBody.error}`);
  const onField = await board.post('/api/tracks/trk-1a2b3c4d/times', await signedPlaneTime(boKey, 'trk-1a2b3c4d', 'Bo', s.boLap, 'sky1800'));
  const onFieldBody = await onField.json();
  check('and a plane\'s lap on a field track is refused', onField.status === 422 && /field track/.test(onFieldBody.error), `${onField.status} ${onFieldBody.error}`);
}

/* Pilots on one track see each other: a WebSocket room per track,
 * relaying fixed size pose frames with the sender's id in front. */
async function liveRooms(board) {
  section('live rooms');
  const nextMessage = (ws, ms = 3000) => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('no message')), ms);
    ws.addEventListener('message', (ev) => { clearTimeout(timer); done(ev.data); }, { once: true });
  });
  const opened = (ws, ms = 3000) => new Promise((done) => {
    const timer = setTimeout(done, ms);
    ws.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); done(); }, { once: true });
  });
  const join = (query) => {
    const ws = new WebSocket(`ws://127.0.0.1:${board.port}/api/live/${query}`);
    ws.binaryType = 'arraybuffer';
    return ws;
  };
  const ada = join('trk-1a2b3c4d?name=Ada%20Rook');
  await opened(ada);
  const adaWelcome = JSON.parse(await nextMessage(ada));
  check('a pilot joining a room is welcomed with an id, alone', adaWelcome.type === 'welcome' && adaWelcome.id > 0 && adaWelcome.peers.length === 0, JSON.stringify(adaWelcome));
  const bo = join('trk-1a2b3c4d?name=Bo');
  const adaHearsJoin = nextMessage(ada);
  await opened(bo);
  const boWelcome = JSON.parse(await nextMessage(bo));
  check('the second pilot is welcomed with the first in the roster', boWelcome.type === 'welcome' && boWelcome.peers.length === 1 && boWelcome.peers[0].name === 'Ada Rook', JSON.stringify(boWelcome));
  const joined = JSON.parse(await adaHearsJoin);
  check('and the first pilot is told who joined', joined.type === 'join' && joined.id === boWelcome.id && joined.name === 'Bo', JSON.stringify(joined));
  const frame = new Uint8Array(24);
  new DataView(frame.buffer).setUint32(0, 4242, true);
  frame[4] = 7;
  const boHears = nextMessage(bo);
  ada.send(frame);
  const relayed = new Uint8Array(await boHears);
  const view = new DataView(relayed.buffer);
  check('a pose frame reaches the other pilot with the sender\'s id in front',
    relayed.length === 26 && view.getUint16(0, true) === adaWelcome.id && view.getUint32(2, true) === 4242 && relayed[6] === 7, `${relayed.length}`);
  let echoed = false;
  ada.addEventListener('message', () => { echoed = true; }, { once: true });
  ada.send(new Uint8Array(10));
  await sleep(150);
  check('a frame of the wrong size goes nowhere, not even back to its sender', echoed === false);
  const adaHearsLeave = nextMessage(ada);
  bo.close();
  const left = JSON.parse(await adaHearsLeave);
  check('a pilot leaving is announced', left.type === 'leave' && left.id === boWelcome.id, JSON.stringify(left));
  ada.close();
  const ghostRoom = new WebSocket(`ws://127.0.0.1:${board.port}/api/live/trk-0000dead`);
  const refused = await new Promise((done) => {
    ghostRoom.addEventListener('error', () => done(true), { once: true });
    ghostRoom.addEventListener('open', () => done(false), { once: true });
    setTimeout(() => done(false), 3000);
  });
  check('a room for a track that is not on the board is refused', refused === true);
}

/* ================================================================== */
/* The page as served                                                  */
/* ================================================================== */

/*
 * The checks on what the static page, its scripts and the inbox say. They
 * read source text, so they belong with whoever rewrites the page; they
 * live in this one function so that work can change them in one place.
 */
async function pageChecks(board) {
  const html = await (await board.get('/')).text();
  check('the page is served, and loads its script', html.includes('Tracks and Statistics') && html.includes('app.js'));
  /* The tabs are markup, so a pasted #stats link works on a board whose
   * list failed to load and a reader with no JavaScript sees both. */
  check('both tabs are in the markup', html.includes('id="tab-tracks"') && html.includes('id="tab-stats"'));
  check('and so is the statistics section', html.includes('id="view-stats"'));
  /* The promise, where a visitor reads it. */
  check('the page says it sets no cookie', html.includes('No cookie is set'));
  /* Relative: the board is served at its own root here and under /board/
   * on the VM, where a root absolute path would ask the landing page. */
  check('the page loads its script by a relative path', html.includes('src="./app.js"'));
  check('and has no root absolute reference at all', !html.includes('src="/') && !html.includes('href="/'));
  check('and loads no webfont', !html.includes('fonts.googleapis.com'));
  const app = await (await board.get('/app.js')).text();
  /* app.js imports origins.js, and a module import that 404s takes the
   * whole page down. */
  const origins = await board.get('/origins.js');
  const originsText = await origins.text();
  check('origins.js is served', origins.status === 200);
  check('as JavaScript', String(origins.headers.get('content-type') || '').includes('javascript'));
  check('app.js imports it by a relative path', app.includes("from './origins.js'"));
  check('and it exports what app.js imports',
    originsText.includes('export function guessSimOrigin') && originsText.includes('export function landingOrigin'));
  /* Both marks lead home and both carry the id wireHomeLinks binds; renaming one
   * leaves a link to a checkout's port on a public board. */
  check('both marks are bound to the front door',
    html.includes('id="brand-home"') && html.includes('id="spine-home"') && app.includes("['brand-home', 'spine-home']"));
  const homeLinks = html.match(/<a\b[^>]*id="(?:brand|spine)-home"[^>]*>/g) || [];
  check('and the way home stays in this tab', homeLinks.length === 2 && homeLinks.every((a) => !a.includes('target=')));
  const cardSource = app.slice(app.indexOf('function buildTrackCard('));
  const attached = cardSource.indexOf('card.append(body)');
  const painted = cardSource.indexOf('fillTopThree(');
  check('a card is in the page before its times are painted onto it', attached !== -1 && painted !== -1 && attached < painted);
  /* One simulator tab: every link to it names the tab, and nothing asks
   * for noopener, which would quietly turn the name into _blank and open a
   * new simulator (a physics loop and a WebGL context) on every click. The
   * counts are the point: a new link that forgets the name is the bug. */
  const simLinks = html.match(/<a\b[^>]*href="http:\/\/127\.0\.0\.1:8000[^"]*"[^>]*>/g) || [];
  check('all seven fallback links to the simulator name its tab', simLinks.length === 7 && simLinks.every((a) => a.includes('target="fdfpv-sim"')));
  check('and the six links app.js builds name it too',
    app.includes("const SIM_WINDOW = 'fdfpv-sim'") && (app.match(/\.target = SIM_WINDOW/g) || []).length === 6);
  check('nothing app.js builds opens a bare new tab or asks for noopener', !app.includes("'_blank'") && !app.includes("noopener'"));

  const inbox = await (await board.get('/bugs.html')).text();
  check('the inbox page is served, with its script', inbox.includes('Bugs and feedback') && inbox.includes('bugs.js'));
  check('and can filter by kind', inbox.includes('id="kind"') && inbox.includes('Feedback, flight feel'));
  check('and loads its script by a relative path', inbox.includes('src="bugs.js"'));
  check('and has no root absolute reference', !inbox.includes('src="/') && !inbox.includes('href="/'));
  const bugsJs = await (await board.get('/bugs.js')).text();
  check('neither script fetches from the site root',
    [app, bugsJs].every((code) => !code.includes("fetch('/") && !code.includes('fetch(`/')));
  const short = await board.get('/bugs');
  check('/bugs serves the inbox', short.status === 200 && (await short.text()).includes('Bugs and feedback'));
  /* Screenshots go to the admin's browser behind a bearer header, which a
   * bare <img src> cannot carry. */
  check('the inbox fetches screenshots with the header and shows them from a blob',
    bugsJs.includes('/images/${img.n}') && bugsJs.includes('createObjectURL'));
}

async function staticAndTickets(board, s) {
  const config = await board.json('/api/config');
  check('config names the simulator', config.simOrigin === 'http://127.0.0.1:8000');
  const sneak = await board.get('/%2e%2e/package.json');
  check('an encoded parent path cannot read the package', sneak.status !== 200 && !(await sneak.text()).includes('fdfpvboard'));
  const percent = await board.get('/%');
  check('a lone percent sign is a 400 or 404, never a 500', percent.status === 400 || percent.status === 404);

  const filed = await board.post('/api/bugs', {
    kind: 'visual', title: 'City trees flicker at dusk', what: 'Near the shrine the treeline pops in and out every few frames.', expected: 'Trees stay put.', steps: 'Load city. Fly to the shrine. Look at the treeline.', reporter: 'Ada Rook', context: { map: 'city', screen: 'paused', graphics: 'high' },
  });
  const ticket = await filed.json();
  check('a report files over HTTP, open, with a ticket id', filed.status === 201 && /^bug-[0-9a-f]{8}$/.test(ticket.id) && ticket.status === 'open');
  check('a title that is too short is refused', (await board.post('/api/bugs', { kind: 'other', title: 'Nope', what: 'Too short.' })).status === 400);
  const open = await board.json('/api/bugs?status=open');
  check('the open list carries it, with its map', open.bugs.some((b) => b.id === ticket.id && b.map === 'city'));
  const whole = await board.json(`/api/bugs/${ticket.id}`);
  check('the whole ticket keeps its context', whole.context.map === 'city' && whole.what.includes('shrine'));
  const marked = await board.post(`/api/bugs/${ticket.id}`, { status: 'in_progress' });
  const markedBody = await marked.json();
  check('an agent can mark a ticket in progress', marked.status === 200 && markedBody.status === 'in_progress');
  const feel = await board.post('/api/bugs', {
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run. Locked in, no complaints.', reporter: 'Ada Rook', context: { map: 'field', tune: 'crapshack' },
  });
  const feelTicket = await feel.json();
  check('flight feel feedback lands as a ticket of its own kind', feel.status === 201 && feelTicket.kind === 'feel');
  const feelOnly = await board.json('/api/bugs?kind=feel');
  check('and the feedback filter lists only feel reports',
    feelOnly.bugs.length === 1 && feelOnly.bugs[0].id === feelTicket.id && feelOnly.bugs.every((b) => b.kind === 'feel'));
  const proto = await board.get('/api/bugs/constructor');
  check('a ticket address that is not a ticket id is a 400 or 404, never a 500', proto.status === 400 || proto.status === 404);
  const adaTrack = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-1a2b3c4d');
  check('filing reports dropped no track or time', adaTrack?.best.lapMs === Math.round(s.adaLap.lapMs));
}

/* Tags travel beside the author, not inside the document: they are the
 * author's intent, not layout. */
async function tagsOverHttp(board) {
  const untagged = await board.json('/api/tracks');
  check('a track published without tags lists an empty list, never undefined', Array.isArray(untagged.tracks[0].tags) && untagged.tracks[0].tags.length === 0);
  const tagged = await board.post('/api/tracks', { author: 'Ada Rook', document: lapField('trk-7a7a7a7a'), tags: ['experiment', 'race', 'race'] });
  const taggedBody = await tagged.json();
  check('a track publishes with tags', tagged.status === 201);
  const row = (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-7a7a7a7a');
  check('and they come back once each, in the board\'s order', row?.tags.join() === 'race,experiment');
  /* Refused rather than dropped, so an author learns a tag did not stick. */
  check('a tag off the list is refused', (await board.post('/api/tracks', { author: 'Ada Rook', document: field('trk-8b8b8b8b'), tags: ['racing'] })).status === 400);
  check('and a track cannot wear six', (await board.post('/api/tracks', {
    author: 'Ada Rook', document: field('trk-9c9c9c9c'), tags: ['race', 'skills', 'experiment', 'freestyle', 'beginner', 'technical'],
  })).status === 400);
  await board.post('/api/tracks/trk-7a7a7a7a/times', await signedTime(boKey, 'trk-7a7a7a7a', 'Bo Finch', flown(lapField('trk-7a7a7a7a'))));
  const retag = await board.post('/api/tracks', { author: 'Ada Rook', document: lapField('trk-7a7a7a7a'), editKey: taggedBody.editKey, tags: ['skills'] });
  const retagBody = await retag.json();
  const retagged = await board.json('/api/tracks/trk-7a7a7a7a');
  check('retagging keeps the times', retag.status === 200 && retagBody.timesCleared === false && retagged.times.length === 1 && retagged.tags.join() === 'skills');
  /* An empty list clears them; an omitted one means a builder that does
   * not know about tags, and leaves them be. */
  const clear = await board.post('/api/tracks', { author: 'Ada Rook', document: lapField('trk-7a7a7a7a'), editKey: taggedBody.editKey, tags: [] });
  check('and an empty list takes them off again', clear.status === 200 && (await board.json('/api/tracks/trk-7a7a7a7a')).tags.length === 0);
}

async function runsOverHttp(board) {
  const run = (over = {}) => ({
    name: 'Ada Rook', map: 'alps', style: 'expert', score: 24800, durationMs: 120000, tricks: 31, unique: 14, bestCombo: 9100, bestTrick: 1450, crashes: 2, signature: 'Trippy Spin x2', ...over,
  });
  const empty = await board.json('/api/runs');
  check('the freestyle board starts empty and still answers, with the tags',
    Array.isArray(empty.runs) && empty.runs.length === 0 && Array.isArray(empty.tags) && empty.tags.length > 0);
  const first = await board.post('/api/runs', run());
  const firstBody = await first.json();
  check('a freestyle run posts at rank 1', first.status === 201 && firstBody.rank === 1 && firstBody.improved === true);
  check('a better run by another pilot takes the top', (await (await board.post('/api/runs', run({ name: 'Bo Finch', score: 31200 }))).json()).rank === 1);
  const ordered = await board.json('/api/runs');
  check('and the board reads highest first', ordered.runs.length === 2 && ordered.runs[0].name === 'Bo Finch' && ordered.runs[1].name === 'Ada Rook');
  /* One row per pilot per map. A worse run is whole and plausible: its
   * best chain and best trick come down with its score. */
  const worse = await board.post('/api/runs', run({ score: 100, bestCombo: 90, bestTrick: 50 }));
  const worseBody = await worse.json();
  check('a worse run by the same pilot does not take their place',
    worse.status === 200 && worseBody.improved === false && worseBody.score === 24800 && (await board.json('/api/runs')).runs.length === 2);
  const better = await board.post('/api/runs', run({ name: 'ADA ROOK', score: 40000 }));
  const afterBetter = await board.json('/api/runs');
  check('a better one replaces it, and capitals do not make a second pilot',
    better.status === 201 && afterBetter.runs.length === 2 && afterBetter.runs[0].name === 'ADA ROOK' && afterBetter.runs[0].score === 40000);
  /* Claims the board can bound without recomputing the score. */
  const implausible = [
    run({ score: 1e12 }), run({ tricks: 0 }), run({ unique: 99, tricks: 4 }), run({ bestTrick: 999999 }), run({ bestCombo: 999999 }),
    run({ map: 'bando' }), run({ style: 'godmode' }), run({ durationMs: 0 }), run({ name: '!!' }),
  ];
  const statuses = [];
  for (const body of implausible) {
    statuses.push((await board.post('/api/runs', body)).status);
  }
  check('all nine implausible runs are refused with a 400', statuses.every((st) => st === 400), statuses.join());
  check('JSON that is not an object is a 400, not a 500', (await board.post('/api/runs', '7')).status === 400);
  check('a map in the query this board keeps no scores for is a 400', (await board.get('/api/runs?map=nowhere')).status === 400);
  const tracks = await board.json('/api/tracks');
  check('and none of it touched the tracks', tracks.tracks.some((t) => t.id === 'trk-1a2b3c4d'));
  check('the track list carries the tag vocabulary', Array.isArray(tracks.tags) && tracks.tags.some((t) => t.id === 'skills'));
}

async function animationsOverHttp(board, s) {
  section('the card animation');
  const pub = await board.post('/api/tracks', { author: 'Ada Rook', document: room('trk-2b3c4d5e', { flyable: true }) });
  const pubBody = await pub.json();
  check('a room publishes, with its edit key', pub.status === 201 && Boolean(pubBody.editKey));
  s.roomKey = pubBody.editKey;
  const G = '/api/tracks/trk-2b3c4d5e/gif';
  check('a track with no animation is a 404, not an empty image', (await board.get(G)).status === 404);
  const up = await board.post(G, { editKey: s.roomKey, gif: b64(GIF_64) });
  const upBody = await up.json();
  check('the browser that published a room uploads its animation', up.status === 200 && upBody.bytes === GIF_64.length, JSON.stringify(upBody));
  const served = await board.get(G);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check('and it comes back as a GIF, byte for byte',
    served.status === 200 && served.headers.get('content-type') === 'image/gif' && servedBytes.equals(GIF_64));
  /* The card's src carries gifUtc, so a hard cache is safe here. */
  check('cached for a long time, unlike anything else here', /max-age=\d\d\d/.test(served.headers.get('cache-control') || ''), served.headers.get('cache-control'));
  const listing = await board.json('/api/tracks');
  const roomRow = listing.tracks.find((t) => t.id === 'trk-2b3c4d5e');
  check('the listing says there is one and does not carry it',
    roomRow.hasGif === true && Boolean(roomRow.gifUtc) && !JSON.stringify(roomRow).includes(b64(GIF_64)));
  check('and says a field track has none', listing.tracks.find((t) => t.id === 'trk-1a2b3c4d').hasGif === false);
  /* The rule, not a default: a field's plan says it all for free. */
  check('a field track is refused an animation', (await board.post('/api/tracks/trk-1a2b3c4d/gif', { editKey: 'whatever', gif: b64(GIF_64) })).status === 400);
  check('another browser cannot replace it', (await board.post(G, { editKey: 'not-the-key', gif: b64(GIF_64) })).status === 403);
  check('a file that is not a GIF is refused', (await board.post(G, { editKey: s.roomKey, gif: b64(Buffer.from('not a gif at all')) })).status === 400);
  const pixel = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0]), Buffer.from([0x3b])]);
  check('a one pixel GIF is refused', (await board.post(G, { editKey: s.roomKey, gif: b64(pixel) })).status === 400);
  check('the admin token uploads without an edit key',
    (await board.post(G, { gif: b64(GIF_64) }, { authorization: `Bearer ${SCRIPT_TOKEN}` })).status === 200);
  /* It is a picture of a layout: a rename keeps it, a relayout drops it. */
  const renamed = { ...room('trk-2b3c4d5e', { flyable: true }), name: 'The same room, renamed' };
  check('a rename republishes the room', (await board.post('/api/tracks', { author: 'Ada Rook', document: renamed, editKey: s.roomKey })).status === 200);
  check('and keeps the animation', (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-2b3c4d5e').hasGif === true);
  const shifted = room('trk-2b3c4d5e', { flyable: true });
  shifted.elements[1].position = { x: 1, y: 1.2, z: 0 };
  const relaid = await board.post('/api/tracks', { author: 'Ada Rook', document: shifted, editKey: s.roomKey });
  const relaidBody = await relaid.json();
  check('moving a gate republishes and clears the times', relaid.status === 200 && relaidBody.timesCleared === true, JSON.stringify(relaidBody));
  check('and drops the animation, a picture of the old layout', (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-2b3c4d5e').hasGif === false);
  check('so the image is a 404 again', (await board.get(G)).status === 404);
}

async function removalOverHttp(board, s) {
  section('taking a track off the board');
  /* A time on it first: the point of the route is that times go with the
   * track, and the point of the gate is that its publisher alone may not
   * throw other pilots' times away. The lap is flown through the room as
   * it stands now, gate moved and all. */
  const current = await board.json('/api/tracks/trk-2b3c4d5e/document');
  const lap = flown(current.document, { speed: 6 });
  const kite = await board.post('/api/tracks/trk-2b3c4d5e/times', await signedTime(boKey, 'trk-2b3c4d5e', 'Bo Kite', lap));
  check('a lap of the room is taken', kite.status === 201, `${kite.status} ${(await kite.clone().text()).slice(0, 120)}`);
  check('the room is on the board with one time on it', (await board.json('/api/tracks')).tracks.find((t) => t.id === 'trk-2b3c4d5e')?.times === 1);
  const R = '/api/tracks/trk-2b3c4d5e/remove';
  check('a stranger cannot remove a track', (await fetch(`${board.base}${R}`, { method: 'POST' })).status === 403);
  check('nor can the browser that published it, with its edit key', (await board.post(R, { editKey: s.roomKey })).status === 403);
  /* Authority is checked before the id, so ids cannot be probed. */
  check('and a made up id answers a stranger the same way', (await fetch(`${board.base}/api/tracks/trk-00000000/remove`, { method: 'POST' })).status === 403);
  const asScript = { authorization: `Bearer ${SCRIPT_TOKEN}` };
  check('with the token, a track that is not here is a 404', (await board.post('/api/tracks/trk-00000000/remove', '', asScript)).status === 404);
  const removed = await board.post(R, '', asScript);
  const removedBody = await removed.json();
  check('the board\'s token takes it off, with its time', removed.status === 200 && removedBody.times === 1, JSON.stringify(removedBody));
  check('and says what went rather than echoing the id', removedBody.name === 'Ladder Loop' && removedBody.author === 'Ada Rook', JSON.stringify(removedBody));
  const after = await board.json('/api/tracks');
  check('the listing no longer carries it', !after.tracks.some((t) => t.id === 'trk-2b3c4d5e'));
  check('and the field track beside it is untouched', after.tracks.some((t) => t.id === 'trk-1a2b3c4d'));
  check('its sheet is a 404', (await board.get('/api/tracks/trk-2b3c4d5e')).status === 404);
  check('and so is its document', (await board.get('/api/tracks/trk-2b3c4d5e/document')).status === 404);
  /* The id is free: the way to replace a track published from a browser
   * nobody still has. */
  check('and the id can be published again', (await board.post('/api/tracks', { author: 'Ada Rook', document: room('trk-2b3c4d5e', { flyable: true }) })).status === 201);
}

async function signingIn(board, s) {
  section('signing in');
  const login = (email, password) => board.post('/api/admin/login', { email, password });
  const wrong = await login(KEEPER, 'not it');
  const wrongBody = await wrong.json();
  check('a wrong password is refused', wrong.status === 401);
  const stranger = await login('nobody@example.com', KEEPER_PASSWORD);
  const strangerBody = await stranger.json();
  check('an address off the list is refused', stranger.status === 401);
  /* One sentence for both, so the route cannot be asked who is an admin. */
  check('and the two refusals are word for word the same', wrongBody.error === strangerBody.error, `${wrongBody.error} / ${strangerBody.error}`);
  check('with no token the session route says nobody', (await board.get('/api/admin/session')).status === 401);
  /* Mixed case and stray spaces, as people type their own address. */
  const ok = await login(`  ${KEEPER.toUpperCase()} `, KEEPER_PASSWORD);
  const session = await ok.json();
  check('the address and its password sign in', ok.status === 200 && typeof session.token === 'string' && session.token.length > 40, JSON.stringify({ status: ok.status, error: session.error }));
  check('and the address comes back normalised', session.email === KEEPER);
  check('with the time it runs out, in UTC', typeof session.expiresUtc === 'string' && session.expiresUtc.endsWith('Z'));
  s.session = { authorization: `Bearer ${session.token}` };
  const who = await board.json('/api/admin/session', s.session);
  check('the session route reads the token back as a person', who.email === KEEPER && who.kind === 'session');
  const script = await board.json('/api/admin/session', { authorization: `Bearer ${SCRIPT_TOKEN}` });
  check('and answers for BOARD_ADMIN_TOKEN with no address', script.kind === 'token' && script.email === '');
  check('a token with its signature changed is nobody', (await board.get('/api/admin/session', { authorization: `Bearer ${session.token.slice(0, -3)}zzz` })).status === 401);
  check('a signed in admin takes a track off the board', (await board.post('/api/tracks/trk-2b3c4d5e/remove', '', s.session)).status === 200);
  check('and it is gone', !(await board.json('/api/tracks')).tracks.some((t) => t.id === 'trk-2b3c4d5e'));
  check('and the same token reads the bugs inbox', (await board.get('/api/bugs', s.session)).status === 200);
}

async function statisticsOverHttp(board, s) {
  section('site statistics, over the wire');
  /* text/plain, because the pages send beacons and a beacon cannot set a
   * content type; if this route ever insists on JSON, every event from
   * every page stops arriving and nothing else would say so. */
  const send = (body, headers = {}) => fetch(`${board.base}/api/stats/events`, {
    method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: JSON.stringify(body),
  });
  const visit = await send({ v: 1, kind: 'visit', surface: 'sim', returning: false, source: 'rotorriot' }, { 'x-fdfpv-country': 'AU' });
  check('a visit sent as text/plain is taken', visit.status === 204);
  check('with no body in the answer', (await visit.text()) === '');
  await send({ v: 1, kind: 'visit', surface: 'board', returning: true, source: 'not-a-sponsor' }, { 'x-fdfpv-country': 'nonsense' });
  await send({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad' }, { 'x-fdfpv-country': 'NZ' });
  await send({ v: 1, kind: 'flush', tab: 'tab-11112222', craft: '5inch', map: 'custom', laps: 4, flightS: 61, crashes: 1 }, { 'x-fdfpv-country': 'AU' });
  /* Global Privacy Control gets the accepted answer and counts nothing:
   * another status would tell a script the signal was seen. */
  check('a browser that asked not to be counted gets the same answer', (await send({ v: 1, kind: 'visit', surface: 'sim', returning: false }, { 'sec-gpc': '1' })).status === 204);
  check('a kind of event the board does not count is refused', (await send({ v: 1, kind: 'pageview' })).status === 400);
  check('and so is more than a minute of laps', (await send({ v: 1, kind: 'flush', tab: 'tab-11112222', craft: '5inch', laps: 900 })).status === 400);
  check('and so is text that is not JSON', (await fetch(`${board.base}/api/stats/events`, { method: 'POST', body: 'not json at all' })).status === 400);

  const read = await board.get('/api/stats');
  const stats = await read.json();
  check('the statistics read answers', read.status === 200);
  check('and may be cached for a short while', /max-age=\d+/.test(read.headers.get('cache-control') || ''));
  check('both visits are counted', stats.today.visits === 2);
  check('and the private one is not', stats.today.newVisitors === 1);
  check('the returning visit moved its own column', stats.today.returningVisitors === 1);
  check('the session and its flying are counted', stats.today.sessions === 1 && stats.today.laps === 4 && stats.today.flightS === 61);
  check('the flying tab counts as flying now', stats.live.flying === 1);
  check('the window is thirty days', stats.days.length === 30);
  const source = (key) => stats.sources.find((r) => r.key === key) || {};
  check('a real sponsor keeps a row of its own', source('rotorriot').visits === 1);
  check('carrying the name the board prints', source('rotorriot').name === 'Rotor Riot');
  check('a source never heard of folds into other', source('not-a-sponsor').visits === undefined && source('other').visits === 1);
  const country = (rows, key) => rows.find((r) => r.key === key) || {};
  check('the country from the edge is counted', country(stats.countries, 'AU').visits === 1);
  check('and a header that is not a country is unknown', country(stats.countries, 'ZZ').visits === 1);

  /* Cloudflare's own header stands in when the Worker's is missing (a
   * Worker from before it set one). Flushes with a lap, since a lap moves
   * the country row; read after the twenty second cache has aged out. */
  await send({ v: 1, kind: 'flush', tab: 'tab-cf-1', craft: '5inch', map: 'custom', laps: 1 }, { 'cf-ipcountry': 'NZ' });
  await send({ v: 1, kind: 'flush', tab: 'tab-cf-2', craft: '5inch', map: 'custom', laps: 1 }, { 'cf-ipcountry': 'NZ', 'x-fdfpv-country': 'FR' });
  await sleep(20_100);
  const later = await board.json('/api/stats');
  check('Cloudflare\'s header is read when the Worker\'s is absent', country(later.countries, 'NZ').laps === 1);
  check('and the Worker\'s wins when both are there', country(later.countries, 'FR').laps === 1);

  /* The four facts off the board's own tables, held to the listing rather
   * than to a number written here. */
  const live = await board.json('/api/tracks');
  const recordHolders = new Set(live.tracks.flatMap((t) => (t.best ? [String(t.best.name).toLowerCase()] : [])));
  check('the facts count the tracks actually on the board', stats.board.tracks === live.tracks.length);
  check('and every time on them, on both boards', stats.board.times === live.tracks.reduce((sum, t) => sum + (t.times || 0) + (t.wing ? t.wing.times : 0), 0));
  check('and at least every pilot holding a record', stats.board.pilots >= recordHolders.size);
  check('and nobody back on another day within one run of this suite', stats.board.pilotsOnMoreThanOneDay === 0);

  /* The flood gate: 600 accepted events per address per window, fifty
   * pilots on one connection; this spends the rest and then some. */
  const ATTEMPTS = 660;
  let shut = 0;
  for (let i = 0; i < ATTEMPTS; i += 1) {
    if ((await send({ v: 1, kind: 'flush', tab: `tab-flood-${i}`, craft: '5inch', flightS: 1 })).status === 429) {
      shut += 1;
    }
  }
  check('an address posting hundreds of events is shut off', shut > 0);
  /* After a room's worth, not before: refused events never spent any of
   * it, which is why the junk above did not bring the gate forward. */
  check('and only after the allowance went through', ATTEMPTS - shut >= 500);

  const panel = await board.json('/api/admin/session', s.session);
  check('a signed in admin is handed the sponsor links', Array.isArray(panel.sponsors) && panel.sponsors.length === 1);
  check('pointing at the simulator with the slug on', panel.sponsors[0].link === 'http://127.0.0.1:8000/?utm_source=rotorriot&utm_medium=sponsor');
  check('while the public read carries no sponsor list', (await board.json('/api/stats')).sponsors === undefined);
}

/* A callsign claimed before any time, and every name and time of a key
 * handed to another (the simulator's optional sign in). */
async function callsigns(board) {
  section('a callsign claimed ahead of a time, and a key handed on');
  const cara = createIdentity(memoryStorage());
  const dan = createIdentity(memoryStorage());
  const eve = createIdentity(memoryStorage());
  const claim = async (identity, name, signedName = name) => board.post('/api/pilots', { name, ...(await identity.signBytes(utf8(`fdfpv-name/v1\n${signedName}`))) });
  check('a pilot key claims a name before any time', (await claim(cara, 'Maverick')).status === 201);
  check('claiming it again changes nothing', (await claim(cara, 'Maverick')).status === 200);
  check('another key cannot claim it, whatever its case', (await claim(eve, 'maverick')).status === 403);
  check('a signature over another name claims nothing', (await claim(eve, 'Iceman', 'Viper')).status === 401);
  const track = { ...lapField(), id: 'trk-5e6f7a8b', name: 'Pilot keys' };
  check('a track for the next laps publishes', (await board.post('/api/tracks', { author: 'Maverick', document: track })).status === 201);
  const lap = flown(track);
  const lapAs = async (identity, name) => board.post(`/api/tracks/${track.id}/times`, await signedTime(identity, track.id, name, lap));
  check('a time under a claimed name from another key is refused', (await lapAs(eve, 'Maverick')).status === 403);
  check('the claiming key posts under it', (await lapAs(cara, 'Maverick')).status === 201);
  const link = async (from, to, signers = [from, to]) => {
    const fromKey = await from.publicKey();
    const toKey = await to.publicKey();
    const message = utf8(`fdfpv-link/v1\n${fromKey}\n${toKey}`);
    return board.post('/api/pilots/link', {
      from: fromKey, fromSig: (await signers[0].signBytes(message)).sig, to: toKey, toSig: (await signers[1].signBytes(message)).sig,
    });
  };
  check('a link the old key did not sign moves nothing', (await link(cara, eve, [eve, eve])).status === 401);
  check('nor one the new key did not sign', (await link(cara, eve, [cara, cara])).status === 401);
  const moved = await link(cara, dan);
  const movedBody = await moved.json();
  check('a link both keys signed moves the name and the time', moved.status === 200 && movedBody.names === 1 && movedBody.times === 1, JSON.stringify(movedBody));
  const asNew = await lapAs(dan, 'Maverick');
  check('the new key posts under the name', asNew.status === 200 || asNew.status === 201, `${asNew.status}`);
  check('and the old key no longer can', (await lapAs(cara, 'Maverick')).status === 403);
}

async function httpSuite(databaseUrl = '') {
  section(databaseUrl ? 'http, against Postgres' : 'http');
  const board = await bootBoard({
    DATABASE_URL: databaseUrl,
    SIM_ORIGIN: 'http://127.0.0.1:8000',
    BOARD_ADMIN_TOKEN: SCRIPT_TOKEN,
    BOARD_ADMINS: `${KEEPER}:plain:${KEEPER_PASSWORD}`,
    /* One sponsor, so the fold keeps a real slug and folds an invented
     * one; and a trusted proxy, so the country headers are believed. */
    BOARD_SPONSORS: 'rotorriot:Rotor Riot',
    BOARD_TRUST_PROXY: '1',
  });
  const state = { kind: databaseUrl ? 'postgres' : 'file' };
  try {
    await timesOverHttp(board, state);
    await worldTracksOverHttp(board, state);
    await planesOverHttp(board, state);
    await liveRooms(board);
    await pageChecks(board);
    await staticAndTickets(board, state);
    await tagsOverHttp(board);
    await runsOverHttp(board);
    await animationsOverHttp(board, state);
    await removalOverHttp(board, state);
    await signingIn(board, state);
    await statisticsOverHttp(board, state);
    await callsigns(board);
  } finally {
    await board.stop();
  }
}

/* Screenshots on tickets, on a board with BUGS_TOKEN set and an admin. */
async function screenshotsSuite(databaseUrl = '') {
  section(databaseUrl ? 'bug screenshots, against Postgres' : 'bug screenshots');
  const board = await bootBoard({ DATABASE_URL: databaseUrl, BUGS_TOKEN: BUGS_SECRET, BOARD_ADMINS: `${KEEPER}:plain:${KEEPER_PASSWORD}` });
  const report = (images, title = 'Pasted a screenshot here') => board.post('/api/bugs', {
    kind: 'visual', title, what: 'The screenshot shows the thing twenty words cannot.', images,
  });
  try {
    const login = await (await board.post('/api/admin/login', { email: KEEPER, password: KEEPER_PASSWORD })).json();
    const admin = { authorization: `Bearer ${login.token}` };
    const filed = await report([`data:image/png;base64,${b64(PNG_1PX)}`, b64(WEBP_HEAD)]);
    const ticket = await filed.json();
    check('a report carries its screenshots in', filed.status === 201 && ticket.images.length === 2, `${filed.status} ${JSON.stringify(ticket).slice(0, 160)}`);
    const whole = await board.json(`/api/bugs/${ticket.id}`, admin);
    check('the admin\'s ticket lists them by number, type and size',
      whole.images.map((i) => `${i.n}:${i.type}:${i.size}`).join() === `1:image/png:${PNG_1PX.length},2:image/webp:${WEBP_HEAD.length}`);
    const image = await board.get(`/api/bugs/${ticket.id}/images/1`, admin);
    const bytes = Buffer.from(await image.arrayBuffer());
    check('a signed in admin gets the image back byte for byte', image.status === 200 && image.headers.get('content-type') === 'image/png' && bytes.equals(PNG_1PX));
    check('served with nosniff and never cached',
      image.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(image.headers.get('cache-control') || ''));
    const byToken = await board.get(`/api/bugs/${ticket.id}/images/2`, { authorization: `Bearer ${BUGS_SECRET}` });
    check('BUGS_TOKEN reads it too, as it reads the ticket', byToken.status === 200 && byToken.headers.get('content-type') === 'image/webp');
    check('nobody else reads a screenshot', (await board.get(`/api/bugs/${ticket.id}/images/1`)).status === 401);
    check('or the ticket', (await board.get(`/api/bugs/${ticket.id}`)).status === 401);
    check('a wrong token reads nothing', (await board.get(`/api/bugs/${ticket.id}/images/1`, { authorization: 'Bearer nope' })).status === 401);
    check('an image the ticket does not have is a 404', (await board.get(`/api/bugs/${ticket.id}/images/3`, admin)).status === 404);
    check('an image number past four is a 400', (await board.get(`/api/bugs/${ticket.id}/images/9`, admin)).status === 400);
    const kept = await (await board.post(`/api/bugs/${ticket.id}`, { status: 'in_progress' }, admin)).json();
    check('marking the ticket keeps its screenshots', kept.status === 'in_progress' && kept.images.length === 2);
    const page = await report([b64(Buffer.from('<html><script>alert(1)</script></html>'))]);
    check('a web page sent as an image is refused', page.status === 400 && /PNG, JPEG or WebP/.test((await page.json()).error));
    const big = await report([b64(Buffer.concat([PNG_1PX, Buffer.alloc(MAX_BUG_IMAGE_BYTES)]))]);
    check('an image over the cap is refused', big.status === 400 && /megabyte/.test((await big.json()).error));
    check('a fifth image is refused', (await report(Array(5).fill(b64(PNG_1PX)))).status === 400);
    check('a body bigger than four capped images can be is a 413', (await report(Array(4).fill(`${b64(PNG_1PX)}${'A'.repeat(1_500_000)}`))).status === 413);
    /* Past the drain ceiling the board stops reading and closes: the
     * client sees the 413 or a reset, and the board lives on. */
    const flood = await report([`${b64(PNG_1PX)}${'A'.repeat(24_000_000)}`]).then((r) => r.status, () => 'reset');
    check('a body past the drain ceiling is refused without taking the board down', flood === 413 || flood === 'reset', String(flood));
    const listed = await board.json('/api/bugs', admin);
    check('refused reports stored nothing', listed.bugs.filter((b) => b.title === 'Pasted a screenshot here').length === 1);
    const plain = await report(undefined, 'A report with no images');
    check('a report without images still lands', plain.status === 201 && (await plain.json()).images.length === 0);
  } finally {
    await board.stop();
  }
}

/* ================================================================== */

originsUnit();
await adminUnit();
validateUnit();
await storeUnit();
await statsUnit();
await httpSuite();
await screenshotsSuite();
if (process.env.BOARD_SELFTEST_DATABASE_URL) {
  await httpSuite(process.env.BOARD_SELFTEST_DATABASE_URL);
  await screenshotsSuite(process.env.BOARD_SELFTEST_DATABASE_URL);
} else {
  section('http, against Postgres');
  skip('BOARD_SELFTEST_DATABASE_URL is not set');
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
