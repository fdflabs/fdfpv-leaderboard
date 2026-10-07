/*
 * server-golden.js: every route of src/server.js, answered, pinned.
 *
 * The HTTP API is the contract the simulator, the builder, the landing
 * page and the board's own page are written against: paths, methods,
 * status codes, the JSON each answer carries, the refusal sentences, the
 * CORS and cache headers, how an oversized body is refused. This script
 * starts the real server from a scratch copy of the repository (so a
 * REVISION file can be put beside it), drives every route through
 * node:http with good and bad input, and compares status, the headers
 * that matter and the body with tests/golden/server.json.
 *
 * Four configurations: everything set (tokens, an admin, a sponsor, a
 * trusted proxy, a REVISION), nothing set, a fixed public origin, and a
 * malformed REVISION, which must stop the server at start.
 *
 * Laps are flown by the simulator's own test helper and signed by its own
 * identity module, as the selftest does. Their lap times, random ids,
 * timestamps, days and session tokens are replaced by placeholders before
 * comparing. Static files are pinned by status and headers only, since
 * the page is rewritten separately.
 *
 *   node tests/server-golden.js           compare
 *   node tests/server-golden.js --write   regenerate (only on purpose)
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
import { createHash, scryptSync } from 'node:crypto';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticLapBytes } from '../vendor/fdfpv/tests/lib/synthlap.js';
import { mapTrackDocument } from '../vendor/fdfpv/tests/lib/maptrack.js';
import { createIdentity, memoryStorage } from '../vendor/fdfpv/src/share/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const GOLDEN = join(here, 'golden', 'server.json');

/* ---- a scratch copy of the repository to run the server from ---- */

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'server-golden-'));
  for (const part of ['src', 'public', 'schema.sql', 'package.json']) {
    cpSync(join(repo, part), join(dir, part), { recursive: true });
  }
  symlinkSync(join(repo, 'vendor'), join(dir, 'vendor'));
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(dir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, 'src', 'server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, ...Object.fromEntries(['NODE_V8_COVERAGE', 'NODE_OPTIONS'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])), PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_FILE: join(dir, 'board.json'), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  for (let i = 0; i < 200; i += 1) {
    if (log.includes('FDFPV leaderboard')) {
      return { port, child, exited, log: () => log };
    }
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('waiting'), 50))]);
    if (code !== 'waiting') {
      return { port: null, code, log: () => log };
    }
  }
  child.kill();
  throw new Error(`server never started: ${log}`);
}

/* ---- one request, as raw as node:http allows ---- */

const KEPT_HEADERS = [
  'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-allow-credentials', 'vary', 'content-type', 'cache-control', 'connection',
  'x-content-type-options', 'set-cookie',
];

function call(port, method, path, { headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: agent || false, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', (err) => resolve({ status: 'socket error', headers: {}, body: Buffer.from(err.code || err.message) }));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/* ---- placeholders for what cannot be pinned ---- */

function normaliser() {
  const seen = new Map();
  const laps = new Map();
  const alias = (kind, value) => {
    const k = `${kind}:${value}`;
    if (!seen.has(k)) {
      seen.set(k, `<${kind}-${[...seen.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}>`);
    }
    return seen.get(k);
  };
  const walk = (v, key) => {
    if (Array.isArray(v)) {
      return key === 'planes' ? `<planes ${v.length > 0 ? 'some' : 'none'}>` : v.map((x) => walk(x));
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).map((k) => [walk(k), walk(v[k], k)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    if (typeof v === 'number' && laps.has(v)) {
      return laps.get(v);
    }
    if (typeof v !== 'string') {
      return v;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) {
      return '<t>';
    }
    if (seen.has('port') && v.includes(`:${seen.get('port')}`)) {
      return v.replaceAll(`:${seen.get('port')}`, ':<port>');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return '<day>';
    }
    const id = v.match(/^(tm|run|bug)-[0-9a-f]{8}$/);
    if (id) {
      return alias(id[1], v);
    }
    if (key === 'editKey' && /^[0-9a-f]{32}$/.test(v)) {
      return alias('key', v);
    }
    if (key === 'token' && v.startsWith('v1.')) {
      return '<session>';
    }
    if (key === 'ghost' && v.length > 40) {
      return `<ghost ${createHash('sha256').update(v).digest('hex').slice(0, 12)}>`;
    }
    return v;
  };
  walk.lap = (ms, name) => {
    if (!(ms > 1000)) {
      throw new Error(`lap ${name} is ${ms}, too short to tell from a count`);
    }
    laps.set(ms, `<lap ${name}>`);
  };
  walk.port = (port) => {
    seen.set('port', String(port));
  };
  return walk;
}

function shape(res, walk, { bodyToo = true } = {}) {
  const headers = Object.fromEntries(KEPT_HEADERS.filter((h) => h in res.headers).map((h) => [h, res.headers[h]]));
  if ('content-length' in res.headers && !/json/.test(res.headers['content-type'] || '')) {
    headers['content-length'] = res.headers['content-length'];
  }
  let body;
  const type = res.headers['content-type'] || '';
  if (!bodyToo) {
    body = '<not pinned>';
  } else if (/json/.test(type)) {
    try {
      body = walk(JSON.parse(res.body.toString('utf8')));
    } catch {
      body = `<unparsed ${res.body.toString('utf8').slice(0, 80)}>`;
    }
  } else if (/^text\/plain/.test(type) || res.body.length === 0) {
    body = res.body.toString('utf8');
  } else {
    body = `<bytes ${res.body.length} ${createHash('sha256').update(res.body).digest('hex').slice(0, 16)}>`;
  }
  return { status: res.status, headers, body };
}

/* ---- documents and laps ---- */

const gate = (id, x, y) => ({
  id, type: 'gate', name: 'Gate', position: { x, y, z: 0 }, yaw: 0, pitch: 0, yawOverridden: false,
  dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
});

function fieldDoc(id, name = 'Costanera', xs = [10, 30]) {
  const elements = xs.map((x, i) => gate(`el-${i + 1}`, x, 8));
  return {
    schemaVersion: 1, id, name, createdUtc: '2026-01-01T00:00:00Z', modifiedUtc: '2026-01-01T00:00:00Z',
    field: { width: 60, depth: 40, gridSize: 1 }, settings: { tangentScale: 0.4, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: { logo: null, logoName: '' }, elements,
    sequence: elements.map((el, i) => ({ id: `seq-${i + 1}`, elementId: el.id, apertureIndex: 0, entry: 1 })),
  };
}

function roomDoc(id) {
  const doc = fieldDoc(id, 'Sala', []);
  doc.schemaVersion = 3;
  doc.trackClass = 'micro';
  doc.field = { width: 5, depth: 6, gridSize: 0.0254 };
  doc.elements = [
    { id: 'el-1', type: 'startPads', position: { x: 0, y: 1.5, z: 0 }, yaw: 0, dims: { pads: 1, spacing: 0.3, padSize: 0.1 } },
    { id: 'el-2', type: 'gate', position: { x: 0, y: 0.6, z: 0 }, yaw: 0, dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 } },
    { id: 'el-3', type: 'gate', position: { x: 2, y: 0.6, z: 0 }, yaw: 0, dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 } },
  ];
  doc.sequence = [
    { id: 'seq-1', elementId: 'el-2', apertureIndex: 0, entry: 1 },
    { id: 'seq-2', elementId: 'el-3', apertureIndex: 0, entry: 1 },
  ];
  return doc;
}

/* A lap the simulator's helper flew. `claimDuration` posts the whole
 * recording's length as the lap, which is what a pilot hovering past the
 * line to pad a slow lap would claim. */
function lapOf(document, opts = {}, claimDuration = false) {
  const lap = syntheticLapBytes(document, opts);
  return { ghost: Buffer.from(lap.bytes).toString('base64'), lapMs: Math.round(claimDuration ? lap.durationMs : lap.lapMs) };
}

async function timeBody(identity, trackId, name, lap, extra = {}) {
  const auth = await identity.signTime({ trackId, lapMs: lap.lapMs, ghost: lap.ghost, craft: extra.craft });
  return {
    name, lapMs: lap.lapMs, ghost: lap.ghost, key: auth.key, sig: auth.sig, ...extra,
  };
}

const enc = (text) => new TextEncoder().encode(text);

const GIF = (() => {
  const b = Buffer.alloc(32);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(160, 6);
  b.writeUInt16LE(100, 8);
  return b;
})();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPoeXYYAAQ3AjaAIZITAAAAAElFTkSuQmCC', 'base64');

const ADMIN_EMAIL = 'keeper@example.com';
const ADMIN_PASSWORD = 'keeper password';
const ADMIN_RECORD = `${ADMIN_EMAIL}:scrypt:1024:1:1:00112233445566778899aabbccddeeff:${scryptSync(ADMIN_PASSWORD, Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 32, { N: 1024, r: 1, p: 1 }).toString('hex')}`;

/* ---- the sequence for a fully configured board ---- */

async function fullBoard(port, walk) {
  const out = [];
  const J = (res, opts) => shape(res, walk, opts);
  const hit = async (label, method, path, opts) => {
    const res = await call(port, method, path, opts);
    out.push([label, J(res, opts)]);
    return res;
  };
  const json = (res) => JSON.parse(res.body.toString('utf8'));
  const admin = { authorization: 'Bearer tok-admin' };

  await hit('health', 'GET', '/api/health');
  await hit('health trailing slash', 'GET', '/api/health/');
  await hit('version', 'GET', '/api/version');
  await hit('config', 'GET', '/api/config', { headers: { host: 'board.local:1234' } });
  await hit('config forwarded', 'GET', '/api/config', { headers: { host: 'x', 'x-forwarded-host': 'board.example, other', 'x-forwarded-proto': 'https' } });
  await hit('config odd host', 'GET', '/api/config', { headers: { host: 'bad host<>' } });
  await hit('options', 'OPTIONS', '/api/tracks', { headers: { origin: 'https://sim.example' } });
  await hit('origin reflected', 'GET', '/api/health', { headers: { origin: 'https://elsewhere.example' } });
  await hit('unknown route', 'GET', '/api/nothing');
  await hit('wrong method', 'DELETE', '/api/tracks');

  /* tracks */
  const field = fieldDoc('trk-1a2b3c4d');
  const pub = await hit('publish', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: field, tags: ['race'] } });
  const editKey = json(pub).editKey;
  await hit('publish again, no key', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: field } });
  await hit('publish bad json', 'POST', '/api/tracks', { body: '{nope' });
  await hit('publish null', 'POST', '/api/tracks', { body: 'null' });
  await hit('publish array', 'POST', '/api/tracks', { body: '[]' });
  await hit('publish bad author', 'POST', '/api/tracks', { body: { author: 'A', document: field } });
  await hit('publish bad document', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: { schemaVersion: 9 } } });
  await hit('publish no document', 'POST', '/api/tracks', { body: { author: 'Ada Rook' } });
  await hit('publish null document', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: null } });
  await hit('publish bad tags', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: fieldDoc('trk-9a9a9a9a'), tags: ['nope'] } });
  await hit('publish rename with key', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: fieldDoc('trk-1a2b3c4d', 'Costanera Norte'), editKey, tags: ['race', 'technical'] } });
  const room = roomDoc('trk-2b3c4d5e');
  const roomPub = await hit('publish room', 'POST', '/api/tracks', { body: { author: 'Bo', document: room } });
  const roomKey = json(roomPub).editKey;
  const map = mapTrackDocument({ id: 'trk-3c4d5e6f', name: 'Ring' });
  await hit('publish map', 'POST', '/api/tracks', { body: { author: 'Cy', document: map } });
  await hit('publish too large', 'POST', '/api/tracks', { body: { author: 'Ada Rook', document: { ...field, filler: 'x'.repeat(700_000) } } });

  await hit('list', 'GET', '/api/tracks');
  await hit('one', 'GET', '/api/tracks/trk-1a2b3c4d');
  await hit('one missing', 'GET', '/api/tracks/trk-00000000');
  await hit('one bad id', 'GET', '/api/tracks/constructor');
  await hit('one bad escape', 'GET', '/api/tracks/%E0%A4%A');
  await hit('document', 'GET', '/api/tracks/trk-2b3c4d5e/document');
  await hit('document missing', 'GET', '/api/tracks/trk-00000000/document');
  await hit('document bad id', 'GET', '/api/tracks/__proto__/document');

  /* card animations */
  const gifBody = { gif: GIF.toString('base64'), editKey: roomKey };
  await hit('gif by owner', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: gifBody });
  await hit('gif with data prefix', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: { ...gifBody, gif: `data:image/gif;base64,${GIF.toString('base64')}` } });
  await hit('gif stranger', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: { gif: GIF.toString('base64'), editKey: 'nope' } });
  await hit('gif admin', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: { gif: GIF.toString('base64') }, headers: admin });
  await hit('gif on a field', 'POST', '/api/tracks/trk-1a2b3c4d/gif', { body: { gif: GIF.toString('base64'), editKey } });
  await hit('gif not a gif', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: { gif: PNG.toString('base64'), editKey: roomKey } });
  await hit('gif missing track', 'POST', '/api/tracks/trk-00000000/gif', { body: gifBody });
  await hit('gif bad id', 'POST', '/api/tracks/x/gif', { body: gifBody });
  await hit('gif bad json', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: '{' });
  await hit('gif null body', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: 'null' });
  await hit('gif list body', 'POST', '/api/tracks/trk-2b3c4d5e/gif', { body: '[1]' });
  await hit('gif get', 'GET', '/api/tracks/trk-2b3c4d5e/gif');
  await hit('gif get none', 'GET', '/api/tracks/trk-1a2b3c4d/gif');
  await hit('gif get bad id', 'GET', '/api/tracks/x/gif');

  /* times */
  const ada = createIdentity(memoryStorage());
  const bo = createIdentity(memoryStorage());
  const lap = lapOf(field);
  walk.lap(lap.lapMs, 'field');
  const T = '/api/tracks/trk-1a2b3c4d/times';
  const timed = await hit('time', 'POST', T, { body: await timeBody(ada, 'trk-1a2b3c4d', 'Ada Rook', lap, { threeMs: lap.lapMs * 3 + 10 }) });
  const timeId = json(timed).id;
  await hit('time no ghost', 'POST', T, { body: { name: 'Ada Rook', lapMs: lap.lapMs } });
  await hit('time bad ghost', 'POST', T, { body: { name: 'Ada Rook', lapMs: lap.lapMs, ghost: 'AAAA' } });
  await hit('time unsigned', 'POST', T, { body: { name: 'Ada Rook', lapMs: lap.lapMs, ghost: lap.ghost } });
  await hit('time bad name', 'POST', T, { body: { name: '!', lapMs: lap.lapMs, ghost: lap.ghost } });
  await hit('time bad lap', 'POST', T, { body: { name: 'Ada Rook', lapMs: 0, ghost: lap.ghost } });
  await hit('time bad json', 'POST', T, { body: '[' });
  await hit('time array', 'POST', T, { body: '[1]' });
  const forged = await timeBody(ada, 'trk-1a2b3c4d', 'Ada Rook', lap);
  forged.lapMs -= 100;
  walk.lap(forged.lapMs, 'field minus 100');
  await hit('time forged', 'POST', T, { body: forged });
  await hit('time squatter', 'POST', T, { body: await timeBody(bo, 'trk-1a2b3c4d', 'ada rook', lap) });
  await hit('time bad craft', 'POST', T, { body: await timeBody(bo, 'trk-1a2b3c4d', 'Bo', lap, { craft: 'Not A Craft' }) });
  await hit('time plane on a field', 'POST', T, { body: await timeBody(bo, 'trk-1a2b3c4d', 'Bo', lap, { craft: 'sky1800' }) });
  const padded = lapOf(field, { hoverAfterMs: 1500 }, true);
  walk.lap(padded.lapMs, 'padded');
  await hit('time padded past the line', 'POST', T, { body: await timeBody(bo, 'trk-1a2b3c4d', 'Bo', padded) });
  await hit('time missing track', 'POST', '/api/tracks/trk-00000000/times', { body: await timeBody(bo, 'trk-00000000', 'Bo', lap) });
  await hit('time bad track id', 'POST', '/api/tracks/zzz/times', { body: await timeBody(bo, 'trk-1a2b3c4d', 'Bo', lap) });
  await hit('time second pilot', 'POST', T, { body: await timeBody(bo, 'trk-1a2b3c4d', 'Bo', lap) });
  /* The simulator refuses any lap on a RaceGOW room, whose 65 mm whoop it
   * removed, before it reads the ghost; the field's lap stands in, since a
   * synthetic lap of a room no longer has a length to alias. */
  await hit('time room', 'POST', '/api/tracks/trk-2b3c4d5e/times', { body: await timeBody(bo, 'trk-2b3c4d5e', 'Bo', lap) });
  const mapLap = lapOf(map);
  walk.lap(mapLap.lapMs, 'map');
  await hit('time map quad', 'POST', '/api/tracks/trk-3c4d5e6f/times', { body: await timeBody(ada, 'trk-3c4d5e6f', 'Ada Rook', mapLap) });
  await hit('time map plane', 'POST', '/api/tracks/trk-3c4d5e6f/times', { body: await timeBody(ada, 'trk-3c4d5e6f', 'Ada Rook', mapLap, { craft: 'sky1800' }) });
  await hit('one after times', 'GET', '/api/tracks/trk-1a2b3c4d');
  await hit('map after times', 'GET', '/api/tracks/trk-3c4d5e6f');
  await hit('ghost', 'GET', `/api/tracks/trk-1a2b3c4d/times/${timeId}/ghost`);
  await hit('ghost missing', 'GET', '/api/tracks/trk-1a2b3c4d/times/tm-00000000/ghost');
  await hit('ghost bad id', 'GET', '/api/tracks/trk-1a2b3c4d/times/xx/ghost');

  /* pilot keys */
  const cara = createIdentity(memoryStorage());
  const dan = createIdentity(memoryStorage());
  const claim = async (identity, name, signed = name) => ({ name, ...(await identity.signBytes(enc(`fdfpv-name/v1\n${signed}`))) });
  await hit('claim', 'POST', '/api/pilots', { body: await claim(cara, 'Maverick') });
  await hit('claim again', 'POST', '/api/pilots', { body: await claim(cara, 'Maverick') });
  await hit('claim taken', 'POST', '/api/pilots', { body: await claim(dan, 'maverick') });
  await hit('claim wrong signature', 'POST', '/api/pilots', { body: await claim(dan, 'Iceman', 'Viper') });
  await hit('claim bad name', 'POST', '/api/pilots', { body: await claim(dan, 'I') });
  await hit('claim unsigned', 'POST', '/api/pilots', { body: { name: 'Iceman' } });
  await hit('claim not json', 'POST', '/api/pilots', { body: 'x' });
  await hit('claim null', 'POST', '/api/pilots', { body: 'null' });
  const link = async (from, to, signers = [from, to]) => {
    const fromKey = await from.publicKey();
    const toKey = await to.publicKey();
    const message = enc(`fdfpv-link/v1\n${fromKey}\n${toKey}`);
    return {
      from: fromKey, fromSig: (await signers[0].signBytes(message)).sig, to: toKey, toSig: (await signers[1].signBytes(message)).sig,
    };
  };
  await hit('link unsigned by old', 'POST', '/api/pilots/link', { body: await link(cara, dan, [dan, dan]) });
  await hit('link same key', 'POST', '/api/pilots/link', { body: await link(cara, cara) });
  await hit('link malformed', 'POST', '/api/pilots/link', { body: { from: 'x' } });
  await hit('link', 'POST', '/api/pilots/link', { body: await link(cara, dan) });

  /* runs */
  const run = {
    name: 'Ada Rook', map: 'alps', style: 'expert', score: 5000, durationMs: 120000, tricks: 20, unique: 8, bestCombo: 2000, bestTrick: 800, crashes: 1, signature: 'Matty flip',
  };
  await hit('run', 'POST', '/api/runs', { body: run });
  await hit('run worse', 'POST', '/api/runs', { body: { ...run, score: 4000, bestCombo: 1000 } });
  await hit('run bad', 'POST', '/api/runs', { body: { ...run, map: 'moon' } });
  await hit('run not json', 'POST', '/api/runs', { body: '{' });
  await hit('runs', 'GET', '/api/runs');
  await hit('runs alps', 'GET', '/api/runs?map=alps');
  await hit('runs bad map', 'GET', '/api/runs?map=moon');

  /* bugs */
  const report = { kind: 'visual', title: 'Gate draws black', what: 'The third gate draws completely black at dusk.', images: [PNG.toString('base64')] };
  const filed = await hit('bug', 'POST', '/api/bugs', { body: report });
  const bugId = json(filed).id;
  await hit('bug bad', 'POST', '/api/bugs', { body: { kind: 'nope' } });
  await hit('bug not json', 'POST', '/api/bugs', { body: '{' });
  await hit('bugs no token', 'GET', '/api/bugs');
  await hit('bugs bearer', 'GET', '/api/bugs', { headers: { authorization: 'Bearer tok-bugs' } });
  await hit('bugs query token', 'GET', '/api/bugs?token=tok-bugs&status=open&kind=visual&limit=5');
  await hit('bugs admin', 'GET', '/api/bugs', { headers: admin });
  await hit('bugs bad status', 'GET', '/api/bugs?token=tok-bugs&status=closed');
  await hit('bugs bad kind', 'GET', '/api/bugs?token=tok-bugs&kind=odd');
  await hit('bug get', 'GET', `/api/bugs/${bugId}?token=tok-bugs`);
  await hit('bug get no token', 'GET', `/api/bugs/${bugId}`);
  await hit('bug get missing', 'GET', '/api/bugs/bug-00000000?token=tok-bugs');
  await hit('bug get bad id', 'GET', '/api/bugs/nope?token=tok-bugs');
  await hit('bug image', 'GET', `/api/bugs/${bugId}/images/1`, { headers: admin });
  await hit('bug image none', 'GET', `/api/bugs/${bugId}/images/2`, { headers: admin });
  await hit('bug image out of range', 'GET', `/api/bugs/${bugId}/images/5`, { headers: admin });
  await hit('bug image no token', 'GET', `/api/bugs/${bugId}/images/1`);
  await hit('bug update', 'POST', `/api/bugs/${bugId}?token=tok-bugs`, { body: { status: 'fixed', resolution: 'Done.' } });
  await hit('bug update bad', 'POST', `/api/bugs/${bugId}?token=tok-bugs`, { body: { status: 'closed' } });
  await hit('bug update missing', 'POST', '/api/bugs/bug-00000000?token=tok-bugs', { body: { status: 'open' } });
  await hit('bug update no token', 'POST', `/api/bugs/${bugId}`, { body: { status: 'open' } });

  /* admin */
  await hit('session none', 'GET', '/api/admin/session');
  await hit('session token', 'GET', '/api/admin/session', { headers: admin });
  await hit('login wrong', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: 'nope nope' } });
  await hit('login bad json', 'POST', '/api/admin/login', { body: '{' });
  await hit('login array', 'POST', '/api/admin/login', { body: '[]' });
  const login = await hit('login', 'POST', '/api/admin/login', { body: { email: ` ${ADMIN_EMAIL.toUpperCase()} `, password: ADMIN_PASSWORD } });
  const session = { authorization: `Bearer ${json(login).token}` };
  await hit('session person', 'GET', '/api/admin/session', { headers: session });
  await hit('session junk', 'GET', '/api/admin/session', { headers: { authorization: 'Bearer v1.a.b' } });
  await hit('remove no admin', 'POST', '/api/tracks/trk-2b3c4d5e/remove');
  await hit('remove bad id', 'POST', '/api/tracks/zz/remove', { headers: session });
  await hit('remove missing', 'POST', '/api/tracks/trk-00000000/remove', { headers: session });
  await hit('remove', 'POST', '/api/tracks/trk-2b3c4d5e/remove', { headers: session });
  await hit('list after remove', 'GET', '/api/tracks');

  /* statistics */
  const S = '/api/stats/events';
  await hit('event visit', 'POST', S, { body: { v: 1, kind: 'visit', surface: 'board', returning: false, source: 'acme' }, headers: { 'x-fdfpv-country': 'au' } });
  await hit('event session', 'POST', S, { body: { v: 1, kind: 'session', craft: 'sky1800', map: 'custom', input: 'gamepad' }, headers: { 'cf-ipcountry': 'NZ' } });
  await hit('event flush', 'POST', S, { body: { v: 1, kind: 'flush', tab: 'tab-00000001', craft: '5inch', map: 'custom', laps: 2, flightS: 50, crashes: 1 } });
  await hit('event as text', 'POST', S, { body: JSON.stringify({ v: 1, kind: 'visit', surface: 'sim', returning: true }), headers: { 'content-type': 'text/plain' } });
  await hit('event bad', 'POST', S, { body: { v: 2 } });
  await hit('event not json', 'POST', S, { body: 'x' });
  await hit('event gpc', 'POST', S, { body: 'x', headers: { 'sec-gpc': '1' } });
  await hit('event too large', 'POST', S, { body: 'x'.repeat(2001) });
  await hit('stats', 'GET', '/api/stats');
  await hit('stats cached', 'GET', '/api/stats');

  /* body limits and the connection after them */
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await hit('drained oversize', 'POST', S, { body: 'y'.repeat(6000), agent });
  await hit('same socket next', 'GET', '/api/health', { agent });
  await hit('far oversize closes', 'POST', S, { body: 'z'.repeat(9000), agent });
  await hit('after close', 'GET', '/api/health', { agent });
  agent.destroy();
  await hit('login too large', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: 'p'.repeat(5000) } });
  await hit('login password not a string', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: 12345678 } });
  await hit('login password too long', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: 'p'.repeat(201) } });
  await hit('gif too large', 'POST', '/api/tracks/trk-1a2b3c4d/gif', { body: { gif: 'A'.repeat(2_510_000) } });
  await hit('time too large', 'POST', T, { body: { name: 'Bo', ghost: 'A'.repeat(700_000) } });
  await hit('pilots too large', 'POST', '/api/pilots', { body: { name: 'x'.repeat(5000) } });
  await hit('run too large', 'POST', '/api/runs', { body: { ...run, signature: 's'.repeat(21_000) } });
  await hit('bug too large', 'POST', '/api/bugs', { body: { ...report, what: 'w'.repeat(5_700_000) } });
  await hit('bug update not json', 'POST', `/api/bugs/${bugId}?token=tok-bugs`, { body: '{' });
  await hit('bug update too large', 'POST', `/api/bugs/${bugId}?token=tok-bugs`, { body: { resolution: 'r'.repeat(21_000) } });

  /* flood gates, last because they lock an address out */
  for (let i = 0; i < 7; i += 1) {
    await call(port, 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: `wrong ${i}` } });
  }
  await hit('login flooded', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  for (let i = 0; i < 5; i += 1) {
    await call(port, 'POST', '/api/runs', { body: { ...run, name: `Pilot ${i}` } });
  }
  await hit('run at the limit', 'POST', '/api/runs', { body: { ...run, name: 'Pilot seven' } });
  await hit('runs flooded', 'POST', '/api/runs', { body: { ...run, name: 'Pilot eight' } });
  for (let i = 0; i < 6; i += 1) {
    await call(port, 'POST', '/api/bugs', { body: { ...report, images: undefined, title: `Report number ${i}` } });
  }
  await hit('bug at the limit', 'POST', '/api/bugs', { body: { ...report, images: undefined, title: 'The eighth report' } });
  await hit('bugs flooded', 'POST', '/api/bugs', { body: { ...report, images: undefined } });
  await hit('another forwarded address is not', 'POST', '/api/bugs', { body: { ...report, images: undefined }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
  for (let i = 0; i < 600; i += 1) {
    await call(port, 'POST', S, { body: { v: 1, kind: 'flush', tab: 'tab-00000002' } });
  }
  await hit('events flooded', 'POST', S, { body: { v: 1, kind: 'flush', tab: 'tab-00000002' } });
  await hit('gpc still answers when flooded', 'POST', S, { body: 'x', headers: { 'sec-gpc': '1' } });
  for (let i = 0; i < 16; i += 1) {
    await call(port, 'POST', '/api/pilots', { body: { name: 'x' } });
  }
  await hit('pilots flooded', 'POST', '/api/pilots', { body: { name: 'x' } });
  await hit('flood is per route', 'GET', '/api/health');

  /* static files: status and headers */
  const files = [
    '/', '/index.html', '/bugs', '/bugs.html', '/app.js', '/icon.svg', '/favicon.ico', '/apple-touch-icon.png',
    '/og.png', '/credits/lestar.jpg', '/strings/en.js', '/missing.html', '/../package.json', '/%2e%2e/package.json',
    '/%zz', '/public/app.js', '/src/server.js', '//etc/passwd', '/credits/',
  ];
  for (const f of files) {
    const res = await call(port, 'GET', f);
    const isFile = res.status === 200;
    out.push([`static ${f}`, shape(res, walk, { bodyToo: !isFile })]);
  }
  return out;
}

/* ---- a board with nothing configured ---- */

async function bareBoard(port, walk) {
  const out = [];
  const hit = async (label, method, path, opts) => {
    out.push([label, shape(await call(port, method, path, opts), walk)]);
  };
  await hit('version without REVISION', 'GET', '/api/version');
  await hit('config', 'GET', '/api/config');
  await hit('config ignores forwarded', 'GET', '/api/config', { headers: { 'x-forwarded-host': 'board.example', 'x-forwarded-proto': 'https' } });
  await hit('login with no admins', 'POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  await hit('session with no admins', 'GET', '/api/admin/session', { headers: { authorization: 'Bearer tok-admin' } });
  await hit('bugs open without a token', 'GET', '/api/bugs');
  await hit('remove with no admin token', 'POST', '/api/tracks/trk-1a2b3c4d/remove', { headers: { authorization: 'Bearer tok-admin' } });
  await hit('event country ignored', 'POST', '/api/stats/events', { body: { v: 1, kind: 'visit', surface: 'board', returning: false, source: 'acme' }, headers: { 'x-fdfpv-country': 'AU' } });
  await hit('stats', 'GET', '/api/stats');
  await hit('runs', 'GET', '/api/runs');
  return out;
}

async function publicOrigin(port, walk) {
  return [['config with BOARD_PUBLIC_ORIGIN', shape(await call(port, 'GET', '/api/config', { headers: { host: 'ignored:1' } }), walk)]];
}

async function main() {
  const result = {};
  const dir = scratchRepo();
  try {
    writeFileSync(join(dir, 'REVISION'), `${'a'.repeat(40)} vendor/fdfpv ${'b'.repeat(40)}\n`);
    const full = await startServer(dir, {
      SIM_ORIGIN: 'https://sim.example/', BOARD_ADMIN_TOKEN: 'tok-admin', BUGS_TOKEN: 'tok-bugs', BOARD_ADMINS: ADMIN_RECORD,
      BOARD_SPONSORS: 'acme:Acme FPV', BOARD_TRUST_PROXY: '1',
    });
    try {
      const walk = normaliser();
      walk.port(full.port);
      result.full = await fullBoard(full.port, walk);
      result.removalLog = { lines: full.log().split('\n').filter((l) => l.startsWith('removed ')) };
    } finally {
      full.child.kill();
    }

    rmSync(join(dir, 'REVISION'));
    rmSync(join(dir, 'board.json'), { force: true });
    const bare = await startServer(dir, {});
    try {
      const walk = normaliser();
      walk.port(bare.port);
      result.bare = await bareBoard(bare.port, walk);
      result.bareWarned = /BOARD_ADMINS is not set/.test(bare.log());
    } finally {
      bare.child.kill();
    }

    const pub = await startServer(dir, { BOARD_PUBLIC_ORIGIN: 'https://board.example//' });
    try {
      result.public = await publicOrigin(pub.port, normaliser());
    } finally {
      pub.child.kill();
    }

    writeFileSync(join(dir, 'REVISION'), 'not a revision\n');
    const broken = await startServer(dir, {});
    result.badRevision = { started: broken.port !== null, exitedNonZero: broken.code !== 0, named: /REVISION/.test(broken.log()) };
    if (broken.child) {
      broken.child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

const now = await main();
if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
  console.log('server golden: wrote tests/golden/server.json');
  process.exit(0);
}
const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
let differ = 0;
for (const part of new Set([...Object.keys(want), ...Object.keys(now)])) {
  const a = want[part];
  const b = now[part];
  if (!Array.isArray(a) || !Array.isArray(b)) {
    const same = JSON.stringify(a) === JSON.stringify(b);
    differ += same ? 0 : 1;
    console.log(`  ${same ? 'pass' : 'FAIL'}  ${part}${same ? '' : `: want ${JSON.stringify(a)} got ${JSON.stringify(b)}`}`);
    continue;
  }
  const labels = new Set([...a.map(([l]) => l), ...b.map(([l]) => l)]);
  const am = new Map(a);
  const bm = new Map(b);
  let bad = 0;
  for (const label of labels) {
    if (JSON.stringify(am.get(label)) !== JSON.stringify(bm.get(label))) {
      bad += 1;
      if (bad <= 15) {
        console.log(`  FAIL  ${part} / ${label}`);
        console.log(`        want ${JSON.stringify(am.get(label)).slice(0, 400)}`);
        console.log(`        got  ${JSON.stringify(bm.get(label)).slice(0, 400)}`);
      }
    }
  }
  differ += bad;
  console.log(`  ${bad ? 'FAIL' : 'pass'}  ${part}: ${labels.size} requests${bad ? `, ${bad} differ` : ''}`);
}
console.log(differ ? `\nserver golden: ${differ} differ` : '\nserver golden: all match');
process.exit(differ ? 1 : 0);
