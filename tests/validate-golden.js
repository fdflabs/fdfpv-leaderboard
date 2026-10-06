/*
 * validate-golden.js: every verdict src/validate.js gives, pinned.
 *
 * src/validate.js decides what the board stores: which tracks publish,
 * which ghosts, runs, bug reports and statistics events are taken, the
 * sentences a refusal comes with (the simulator shows them as they are),
 * the plan a card is drawn from and the layout hash that decides whether a
 * republished track keeps its times. A change to any of those is a change
 * to the published contract, so this file feeds it a few thousand inputs
 * and compares every answer with tests/golden/validate.txt.
 *
 * The inputs are generated here from a seeded generator, with no import
 * from the simulator, so the corpus cannot move when vendor/fdfpv is
 * re-pinned. Most of them are real shapes broken one field at a time:
 * documents in all four schema versions and three classes, ghosts with one
 * header word wrong, runs with one count out of range.
 *
 * Each answer is canonical JSON (keys sorted, a Buffer as its length and
 * digest, a throw as the error's class), and the golden file keeps the
 * first sixteen hex digits of its SHA-256 per case, so it stays small and a
 * mismatch still names the case.
 *
 *   node tests/validate-golden.js           compare
 *   node tests/validate-golden.js --write   regenerate (only on purpose)
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
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../src/validate.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'validate.txt');

/* Deterministic randomness: mulberry32, seeded per family so adding cases
 * to one family does not reshuffle another. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    num: (lo, hi, dp = 3) => Number((lo + next() * (hi - lo)).toFixed(dp)),
  };
}

/* Values that are wrong in an interesting way for nearly any field. */
const ODD = [
  undefined, null, '', ' ', 0, -1, 1, 0.4, 1.5, 2.5, NaN, Infinity, -Infinity, true, false,
  '1', '12345', 'abc', 'A', [], [1], {}, { a: 1 }, 'x'.repeat(300), '  padded  name ', 1e9, -0,
];

const cases = [];
function add(label, fn, ...args) {
  cases.push({ label, fn, args });
}

/* ---- names, laps, craft, country, day, score bound, keys ---- */
{
  const names = [
    ...ODD, 'Ada Rook', 'ab', 'a', 'x'.repeat(24), 'x'.repeat(25), 'Ada!', 'Ana  Maria', ' Ana\tMaria ',
    'José', 'a.b_c-d e', '__', '..', '--', 'Ñandu', 'A\nB', 'a'.repeat(23) + ' ', '  ab  ', 'ab cd',
  ];
  names.forEach((n, i) => add(`normaliseName#${i}`, 'normaliseName', n));
  const laps = [...ODD, 3_600_000, 3_600_001, 3_599_999.6, 0.5, 0.99, 1.49, 12345.5, 12344.5, 99.999];
  laps.forEach((n, i) => add(`normaliseLapMs#${i}`, 'normaliseLapMs', n));
  const threes = [...ODD, 3000, 2999, 2999.5, 10_800_000, 10_800_001, 10_799_999.5, 30000, 36000];
  const againstLaps = [undefined, null, 1000, 10000, 12000, 0, 3_600_000];
  threes.forEach((t, i) => againstLaps.forEach((l, j) => add(`normaliseThreeMs#${i}.${j}`, 'normaliseThreeMs', t, l)));
  const crafts = [...ODD, 'sky1800', 'SKY1800', 'a'.repeat(32), 'a'.repeat(33), 'tiger-moth', 'tiger moth', '5inch', 'ü'];
  crafts.forEach((c, i) => add(`inspectCraft#${i}`, 'inspectCraft', c));
  const countries = [...ODD, 'AU', 'au', ' nz ', 'XX', 'T1', 'ZZ', 'A1', 'AUS', '203.0.113.7', 'xx', 't1', 'Gb'];
  countries.forEach((c, i) => add(`normaliseCountry#${i}`, 'normaliseCountry', c));
  const days = [0, 86_399_999, 86_400_000, 1_790_000_000_000, '2026-10-06T23:59:59.999Z', '2026-10-07T00:00:00+02:00'];
  days.forEach((d, i) => add(`statsDay#${i}`, 'statsDay', d));
  const counts = [...ODD, 2, 3, 10, 100, 600, 601];
  counts.forEach((n, i) => add(`maxPlausibleScore#${i}`, 'maxPlausibleScore', n));
  const keys = [...ODD, 'edit-key', 'ñ', { toString: () => 'custom' }];
  keys.forEach((k, i) => add(`hashEditKey#${i}`, 'hashEditKey', k));
}

/* ---- track documents ---- */
const FIELD_TYPES = [
  'gate', 'flaggedGate', 'doubleStack', 'flaggedDoubleStack', 'ladder', 'tower', 'diveGate', 'barrier', 'flag',
  'cone', 'waypoint', 'pole', 'horizontalPole', 'wideGate3', 'wideGate5', 'pylonPair', 'pylon', 'hoop175',
  'hoop250', 'hoop6', 'hoop12', 'hoop20', 'hoop30', 'startPads', 'label', 'groundLogo', 'mystery',
];
const MAP_TYPES = [
  'gate', 'flaggedGate', 'doubleStack', 'ladder', 'tower', 'wideGate3', 'wideGate5', 'pylonPair', 'pylon',
  'hoop175', 'hoop250', 'hoop30', 'hoop6', 'hoop12', 'hoop20',
];
const PNG_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPoeXYYAAQ3AjaAIZITAAAAAElFTkSuQmCC';

function dimsFor(r, type) {
  const dims = {};
  const maybe = (key, value) => {
    if (r.next() < 0.6) {
      dims[key] = value;
    }
  };
  maybe('levels', r.pick([1, 2, 3, 5, 0, -1, '2']));
  maybe('clearW', r.pick([1.524, 0.711, 5, 0, -2, 'wide']));
  maybe('clearH', r.pick([1.524, 0.711, 3]));
  maybe('sillH', r.pick([0, 0.5]));
  maybe('width', r.pick([2.4, 20, 0, -1]));
  maybe('depth', r.pick([0.6, 1, 0]));
  if (type === 'startPads') {
    maybe('pads', r.pick([1, 4, 0]));
    maybe('spacing', r.pick([1.5, 0, -1]));
    maybe('padSize', r.pick([0.1, 0.6, 0]));
  }
  maybe('clearance', r.pick([0, 0.04, 0.05, 1, null]));
  return dims;
}

function fieldDocument(r, n) {
  const version = r.pick([1, 2, 3, 3]);
  const trackClass = version === 3 ? r.pick(['full', 'micro', 'wing', 'giant', undefined]) : undefined;
  const count = r.int(1, 14);
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    const type = r.pick(FIELD_TYPES);
    const el = {
      id: `el-${i + 1}`,
      type,
      name: type,
      position: { x: r.num(0, 60), y: r.num(0, 40), z: 0 },
      yaw: r.pick([0, r.num(-3.14, 3.14), undefined, 'x']),
      dims: dimsFor(r, type),
    };
    if (r.next() < 0.05) {
      el.position.x = el.position.y = 20;
    }
    elements.push(el);
  }
  const sequence = [];
  const steps = r.int(1, count + 3);
  for (let i = 0; i < steps; i += 1) {
    sequence.push({ id: `sq-${i + 1}`, elementId: r.pick(elements).id, apertureIndex: 0, entry: r.pick([0, 1]) });
  }
  const doc = {
    schemaVersion: version,
    id: `trk-${(0x10000000 + n).toString(16)}`,
    name: r.pick(['Costanera', '', '   ', 'x'.repeat(100), 'Lago Ypacarai', undefined]),
    createdUtc: '2026-10-06T00:00:00Z',
    modifiedUtc: '2026-10-06T00:00:00Z',
    field: r.next() < 0.9 ? { width: r.pick([60, 5, 400, 0, undefined]), depth: r.pick([40, 6, 300, undefined]), gridSize: 1 } : {},
    settings: { tangentScale: 1.1, minCurveRadius: 2.5, samplesPerSegment: 48 },
    elements,
    sequence,
  };
  if (trackClass !== undefined) {
    doc.trackClass = trackClass;
  }
  const logos = r.int(0, 2);
  if (version === 1 && logos) {
    doc.branding = { logo: PNG_LOGO, logoName: 'a.png' };
  } else if (version > 1) {
    doc.branding = { logos: Array.from({ length: logos }, (_, i) => ({ id: `lg-${i}`, image: PNG_LOGO, name: 'a.png' })) };
  }
  if (r.next() < 0.3) {
    doc.credit = r.pick([
      { designer: 'Skittles', series: 'RaceGOW5' },
      { designer: '  two   spaces\u0007bell ', series: ['a', 'b'] },
      { designer: { name: 'x' }, series: 'y'.repeat(120) },
      null,
      'Skittles',
    ]);
  }
  return doc;
}

function quaternion(r) {
  const yaw = r.num(-3.14, 3.14, 6);
  return { w: Number(Math.cos(yaw / 2).toFixed(6)), x: 0, y: 0, z: Number(Math.sin(yaw / 2).toFixed(6)) };
}

function mapDocument(r, n) {
  const count = r.int(1, 12);
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    elements.push({
      id: `el-${i + 1}`,
      type: r.pick(MAP_TYPES),
      position: { x: r.num(-2900, 2900, 2), y: r.num(-2900, 2900, 2), z: r.num(-50, 2500, 2) },
      orientation: quaternion(r),
      dims: r.next() < 0.5 ? { clearW: r.pick([5, 8, 12]) } : {},
    });
  }
  if (r.next() < 0.3) {
    for (const el of elements) {
      el.position.x = r.num(100, 400, 2);
      el.position.y = r.num(-300, -50, 2);
    }
  }
  return {
    schemaVersion: 4,
    id: `trk-${(0x20000000 + n).toString(16)}`,
    name: 'Valle',
    trackClass: r.pick(['full', 'wing']),
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 1.1, minCurveRadius: 2.5, samplesPerSegment: 48 },
    branding: { logos: [] },
    credit: null,
    map: r.pick(['alps', 'swiss2', 'swiss2']),
    elements,
    sequence: elements.map((el, i) => ({ id: `sq-${i + 1}`, elementId: el.id, apertureIndex: 0, entry: 0 })),
  };
}

/* Every path through plain objects and arrays, to a depth, as key lists. */
function paths(value, depth, prefix = []) {
  if (depth === 0 || value == null || typeof value !== 'object') {
    return [];
  }
  const out = [];
  for (const key of Object.keys(value)) {
    out.push([...prefix, key]);
    out.push(...paths(value[key], depth - 1, [...prefix, key]));
  }
  return out;
}

function mutate(doc, path, replacement) {
  const copy = structuredClone(doc);
  let at = copy;
  for (const key of path.slice(0, -1)) {
    at = at[key];
  }
  const last = path[path.length - 1];
  if (replacement === DELETE) {
    if (Array.isArray(at)) {
      at.splice(Number(last), 1);
    } else {
      delete at[last];
    }
  } else {
    at[last] = replacement;
  }
  return copy;
}
const DELETE = Symbol('delete');

const DOC_ODD = [DELETE, null, 0, -1, 'x', 4, 5, 2.5, [], {}, true, 6000, -3001, 3001, '2', 'micro', 'wing', 'alps', 'yellowstone'];

{
  const r = rng(1);
  const documents = [];
  for (let n = 0; n < 160; n += 1) {
    documents.push(fieldDocument(r, n));
  }
  for (let n = 0; n < 60; n += 1) {
    documents.push(mapDocument(r, n));
  }
  documents.forEach((doc, i) => {
    add(`inspectDocument#${i}`, 'inspectDocument', doc);
    add(`inspectDocument.string#${i}`, 'inspectDocument', JSON.stringify(doc));
    add(`planFromDocument#${i}`, 'planFromDocument', doc);
    add(`layoutHash#${i}`, 'layoutHash', doc);
    add(`trackClassOf#${i}`, 'trackClassOf', doc);
    add(`mapOf#${i}`, 'mapOf', doc);
    add(`creditOf#${i}`, 'creditOf', doc);
  });
  /* One field at a time, on a sample of the documents. */
  const m = rng(2);
  documents.slice(0, 40).concat(documents.slice(160, 175)).forEach((doc, i) => {
    const all = paths(doc, 4);
    for (let k = 0; k < 30; k += 1) {
      const path = m.pick(all);
      const replacement = m.pick(DOC_ODD);
      const broken = mutate(doc, path, replacement);
      add(`inspectDocument.mutant#${i}.${k}`, 'inspectDocument', broken);
      if (k % 3 === 0) {
        add(`planFromDocument.mutant#${i}.${k}`, 'planFromDocument', broken);
        add(`layoutHash.mutant#${i}.${k}`, 'layoutHash', broken);
      }
    }
  });
  /* Painted logos do not change the layout; worlds do. */
  const base = documents[0];
  const painted = structuredClone(base);
  painted.elements.push({ id: 'el-99', type: 'groundLogo', position: { x: 1, y: 1, z: 0 } });
  add('layoutHash.painted', 'layoutHash', painted);
  const plainMap = documents[170];
  add('layoutHash.map.alps', 'layoutHash', { ...plainMap, map: 'alps' });
  add('layoutHash.map.swiss2', 'layoutHash', { ...plainMap, map: 'swiss2' });
  add('layoutHash.map.v3', 'layoutHash', { ...plainMap, schemaVersion: 3 });
  add('layoutHash.bare', 'layoutHash', {});
  const plans = [
    {}, { field: null }, { field: { width: '12', depth: 'x' } }, { trackClass: 'micro' }, { trackClass: 'micro', field: {} },
    { elements: [{ id: 'a', type: 'gate', position: { x: 1, y: 2 } }] },
    { elements: [{ id: 'a', position: { x: 1, y: 2 } }], sequence: [{ elementId: 'a' }, null, { elementId: 'b' }] },
    { elements: [null, { id: 'a' }, { position: 7 }], sequence: 'none' },
  ];
  plans.forEach((d, i) => add(`planFromDocument.sparse#${i}`, 'planFromDocument', d));

  /* Whole-document oddities. */
  const odd = [
    ...ODD, '{', '[]', '"text"', 'null', JSON.stringify({ schemaVersion: 1 }),
    'x'.repeat(560_001), { ...base, filler: 'y'.repeat(560_000) },
  ];
  odd.forEach((d, i) => add(`inspectDocument.odd#${i}`, 'inspectDocument', d));

  /* Branding at its limits. */
  const big = (chars) => `data:image/png;base64,${'A'.repeat(chars - 22)}`;
  const brandings = [
    { logos: [] }, { logo: '' }, { logo: PNG_LOGO }, { logo: 'http://x/y.png' }, 'branded', [],
    { logos: Array(5).fill(PNG_LOGO) }, { logos: Array(6).fill(PNG_LOGO) },
    { logos: [{ image: big(256 * 1024) }] }, { logos: [{ image: big(256 * 1024 + 1) }] },
    { logos: [{ image: big(200 * 1024) }, { image: big(184 * 1024) }] },
    { logos: [{ image: big(200 * 1024) }, { image: big(185 * 1024) }] },
    { logos: [{ image: 'data:image/svg+xml;base64,AAAA' }] }, { logos: [null] }, { logos: [{ image: 7 }] },
    { logos: 'nope', logo: PNG_LOGO }, { logo: PNG_LOGO.replace('png', 'jpeg') }, { logo: PNG_LOGO.replace('png', 'webp') },
    { logo: PNG_LOGO.replace('png', 'gif') }, { logo: `${PNG_LOGO}!` },
  ];
  brandings.forEach((b, i) => add(`inspectDocument.branding#${i}`, 'inspectDocument', { ...documents[3], branding: b }));

  /* A map track at the edges of its world and of its step budget. */
  const edge = documents[165];
  const at = (patch) => {
    const d = structuredClone(edge);
    Object.assign(d.elements[0], patch);
    return d;
  };
  const poses = [
    { position: { x: 3000, y: -3000, z: 3000 } }, { position: { x: 3000.01, y: 0, z: 0 } },
    { position: { x: 0, y: 0, z: -100 } }, { position: { x: 0, y: 0, z: -100.5 } }, { position: { x: 0, y: 0 } },
    { position: { x: '1', y: 0, z: 0 } }, { orientation: { w: 1, x: 0, y: 0, z: 0 } },
    { orientation: { w: 1.0009, x: 0, y: 0, z: 0 } }, { orientation: { w: 1.0011, x: 0, y: 0, z: 0 } },
    { orientation: { w: 0.5, x: 0.5, y: 0.5, z: 0.5 } }, { orientation: null }, { orientation: { w: 1, x: 0, y: 0 } },
    { type: 'startPads' }, { type: 'diveGate' }, { type: 'hoop30' },
  ];
  poses.forEach((p, i) => add(`inspectDocument.mappose#${i}`, 'inspectDocument', at(p)));
  const many = (k) => {
    const d = structuredClone(edge);
    const proto = d.elements[0];
    d.elements = Array.from({ length: k }, (_, i) => ({ ...structuredClone(proto), id: `el-${i + 1}` }));
    d.sequence = d.elements.map((el, i) => ({ id: `sq-${i + 1}`, elementId: el.id }));
    return d;
  };
  [255, 256, 257].forEach((k) => add(`inspectDocument.mapsteps#${k}`, 'inspectDocument', many(k)));
  ['yellowstone', 'city', undefined, 7].forEach((w, i) => add(`inspectDocument.mapworld#${i}`, 'inspectDocument', { ...edge, map: w }));
}

/* ---- ghosts ---- */
function ghost({ rate = 30, count, duration = 10000, splits = 1, magic = 'FPVGHST1', version = 1, extra = 0, trim = 0, claimSplits }) {
  const samples = count ?? Math.floor((duration * rate) / 1000) + 2;
  const bytes = Buffer.alloc(32 + splits * 4 + samples * 20 + extra);
  bytes.write(magic, 0, 'latin1');
  bytes.writeUInt32LE(version, 8);
  bytes.writeUInt32LE(rate, 12);
  bytes.writeUInt32LE(samples, 16);
  bytes.writeUInt32LE(duration, 20);
  bytes.writeUInt32LE(claimSplits ?? splits, 24);
  for (let i = 0; i < samples; i += 1) {
    bytes.writeFloatLE(i * 0.25, 32 + splits * 4 + i * 20);
  }
  return bytes.subarray(0, bytes.length - trim).toString('base64');
}
{
  const good = ghost({});
  const ghosts = [
    ...ODD, good, `${good}=`, good.slice(0, 40), good.replace(/A/g, '-'), 'A'.repeat(44), 'A'.repeat(48),
    ghost({ magic: 'FPVGHST2' }), ghost({ version: 2 }), ghost({ rate: 0 }), ghost({ rate: 240, duration: 1000 }),
    ghost({ rate: 241, duration: 1000 }), ghost({ count: 1 }), ghost({ count: 2, duration: 10 }), ghost({ duration: 0 }),
    ghost({ duration: 600_000, rate: 1 }), ghost({ duration: 600_001, rate: 1 }), ghost({ splits: 256 }),
    ghost({ splits: 257 }), ghost({ extra: 4 }), ghost({ trim: 4 }), ghost({ claimSplits: 2 }),
    ghost({ count: 300 }), ghost({ count: 299 }), ghost({ count: 301 }), ghost({ duration: 10250 }),
    ghost({ duration: 10251 }), ghost({ duration: 9750 }), ghost({ duration: 9749 }),
    'A'.repeat(500_000), 'A'.repeat(500_004), ghost({ rate: 120, duration: 600_000 }),
  ];
  const laps = [undefined, null, 10000, 9000];
  ghosts.forEach((g, i) => laps.forEach((l, j) => add(`inspectGhost#${i}.${j}`, 'inspectGhost', g, l)));
}

/* ---- card animations ---- */
{
  const gif = (w, h, magic = 'GIF89a', pad = 20) => {
    const b = Buffer.alloc(10 + pad);
    b.write(magic, 0, 'latin1');
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    return b.toString('base64');
  };
  const room = { schemaVersion: 3, trackClass: 'micro' };
  const field = { schemaVersion: 3, trackClass: 'full' };
  const uploads = [
    ...ODD, gif(160, 100), gif(64, 64), gif(63, 64), gif(64, 63), gif(4096, 4096), gif(4097, 100), gif(100, 4097),
    gif(160, 100, 'GIF87a'), gif(160, 100, 'GIF88a'), `data:image/gif;base64,${gif(160, 100)}`,
    `  ${gif(160, 100)}  `, gif(160, 100, 'GIF89a', 0).slice(0, 12), 'AAAA', '***', 'A'.repeat(2_500_000),
    'A'.repeat(2_500_004), `data:image/png;base64,${gif(160, 100)}`,
  ];
  uploads.forEach((u, i) => {
    add(`inspectGif.room#${i}`, 'inspectGif', { base64: u, document: room });
    if (i % 5 === 0) {
      add(`inspectGif.field#${i}`, 'inspectGif', { base64: u, document: field });
    }
  });
  add('inspectGif.nodoc', 'inspectGif', { base64: gif(160, 100), document: null });
  add('inspectGif.wing', 'inspectGif', { base64: gif(160, 100), document: { trackClass: 'wing' } });
}

/* ---- bug reports ---- */
const PNG_BYTES = Buffer.from(PNG_LOGO.split(',')[1], 'base64');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
{
  const images = [
    PNG_BYTES, JPEG_BYTES, WEBP_BYTES, Buffer.alloc(0), Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from([0xff, 0xd8]), Buffer.from('RIFF0000WEBX'), Buffer.from('GIF89a......'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ];
  images.forEach((b, i) => add(`imageTypeOf#${i}`, 'imageTypeOf', b));
  const b64 = (b) => b.toString('base64');
  const lists = [
    ...ODD, [b64(PNG_BYTES)], [`data:image/png;base64,${b64(PNG_BYTES)}`], [`data:image/svg+xml;base64,${b64(PNG_BYTES)}`],
    [b64(JPEG_BYTES), b64(WEBP_BYTES)], Array(4).fill(b64(PNG_BYTES)), Array(5).fill(b64(PNG_BYTES)), [''],
    [null], [b64(PNG_BYTES), '***'], [b64(Buffer.from('plain text'))], [`  ${b64(JPEG_BYTES)}  `],
    [b64(Buffer.concat([JPEG_BYTES, Buffer.alloc(1_048_576 - JPEG_BYTES.length)]))],
    [b64(Buffer.concat([JPEG_BYTES, Buffer.alloc(1_048_577 - JPEG_BYTES.length)]))],
    [b64(Buffer.concat([JPEG_BYTES, Buffer.alloc(1_048_578 - JPEG_BYTES.length)]))],
    ['A'.repeat(1_398_104)], ['A'.repeat(1_398_105)], [7], [{}],
  ];
  lists.forEach((l, i) => add(`inspectBugImages#${i}`, 'inspectBugImages', l));

  const report = {
    kind: 'crash', title: 'The gate vanished', what: 'I flew through the third gate and it disappeared from view.',
    expected: 'It stays', steps: '1. fly\r\n2. look', reporter: 'Ada Rook', context: { map: 'alps', gpu: 'x' },
  };
  add('inspectBugCreate.good', 'inspectBugCreate', report);
  const r = rng(3);
  const fields = Object.keys(report).concat(['images']);
  const values = [
    ...ODD, 'other', 'feel', 'wrong', 'a'.repeat(7), 'a'.repeat(8), 'a'.repeat(120), 'a'.repeat(121), 'a'.repeat(19),
    'a'.repeat(20), 'a'.repeat(4000), 'a'.repeat(4001), 'a'.repeat(2000), 'a'.repeat(2001), '  line\r\nline  ',
    { a: 'b'.repeat(8000) }, Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])),
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])), [b64(PNG_BYTES)], 'Ada!', 'A',
    '  title   with   gaps  ',
  ];
  for (const field of fields) {
    values.forEach((v, i) => add(`inspectBugCreate.${field}#${i}`, 'inspectBugCreate', { ...report, [field]: v }));
  }
  for (let k = 0; k < 60; k += 1) {
    const body = { ...report };
    for (const field of fields) {
      if (r.next() < 0.3) {
        body[field] = r.pick(values);
      }
    }
    add(`inspectBugCreate.mixed#${k}`, 'inspectBugCreate', body);
  }
  add('inspectBugCreate.bigint', 'inspectBugCreate', { ...report, context: { n: 10n } });
  [...ODD, 'string'].forEach((b, i) => add(`inspectBugCreate.odd#${i}`, 'inspectBugCreate', b));
  const patches = [
    ...ODD, { status: 'fixed' }, { status: 'closed' }, { resolution: '  done \r\n ' }, { status: 'open', resolution: 'x' },
    { resolution: 'a'.repeat(4000) }, { resolution: 'a'.repeat(4001) }, { status: null, resolution: null }, { other: 1 },
    { status: 0 }, { resolution: 0 }, { status: 'in_progress' }, { status: 'wontfix' }, { status: 'duplicate' },
  ];
  patches.forEach((p, i) => add(`inspectBugPatch#${i}`, 'inspectBugPatch', p));
}

/* ---- tags ---- */
{
  const lists = [
    ...ODD, ['race'], ['RACE', ' skills '], ['race', 'race'], ['showcase', 'race', 'micro'], ['race', 'skills', 'experiment', 'freestyle', 'beginner'],
    ['race', 'skills', 'experiment', 'freestyle', 'beginner', 'technical'], ['nope'], [null], ['x'.repeat(40)], [7], [['race']],
    ['big', 'micro', 'technical', 'beginner', 'freestyle'],
  ];
  lists.forEach((l, i) => add(`inspectTags#${i}`, 'inspectTags', l));
}

/* ---- freestyle runs ---- */
{
  const run = {
    name: 'Ada Rook', map: 'alps', style: 'expert', score: 25000, durationMs: 120000, tricks: 40, unique: 12,
    bestCombo: 9000, bestTrick: 850, crashes: 2, signature: 'Matty flip',
  };
  add('inspectRun.good', 'inspectRun', run);
  const values = [
    ...ODD, 'swiss2', 'yellowstone', 'city', 'arcade', 999, 1000, 900000, 900001, 600, 601, 40, 41, 12,
    'Ünïcödé flip \u0001', 'x'.repeat(60), 1e12, 25000, 25001,
  ];
  for (const field of Object.keys(run)) {
    values.forEach((v, i) => add(`inspectRun.${field}#${i}`, 'inspectRun', { ...run, [field]: v }));
  }
  const r = rng(4);
  for (let k = 0; k < 80; k += 1) {
    const body = { ...run };
    for (const field of Object.keys(run)) {
      if (r.next() < 0.25) {
        body[field] = r.pick(values);
      }
    }
    add(`inspectRun.mixed#${k}`, 'inspectRun', body);
  }
  const tight = { ...run, tricks: 1, unique: 1 };
  const ceiling1 = Math.ceil(1 * 850 * (1 + 0.085) * 12);
  [ceiling1, ceiling1 + 1].forEach((s, i) => add(`inspectRun.ceiling#${i}`, 'inspectRun', { ...tight, score: s, bestCombo: 1, bestTrick: 1 }));
  [...ODD, 'string'].forEach((b, i) => add(`inspectRun.odd#${i}`, 'inspectRun', b));
}

/* ---- statistics events ---- */
{
  const fold = (x) => (x == null ? 'direct' : (x === 'acme' ? 'acme' : 'other'));
  const events = [
    { v: 1, kind: 'visit', surface: 'board', returning: false, source: 'acme' },
    { v: 1, kind: 'session', craft: 'sky1800', map: 'custom', input: 'gamepad' },
    { v: 1, kind: 'flush', tab: '0f8fad5b-d9cb-469f-a165-70867728950e', craft: '5inch', map: 'city', laps: 2, flightS: 60, crashes: 1 },
  ];
  const values = [
    ...ODD, 'visit', 'session', 'flush', 'sim', 'builder', 'landing', 'acme', 'other', 'tigermoth1803', 'keyboard',
    'touch', 'joystick', 'custom', 'city', 'alps', 30, 31, 90, 91, 60, 61, 'abcdefgh', 'abcdefg', 'a'.repeat(36),
    'a'.repeat(37), 'abc_defgh', 2,
  ];
  events.forEach((ev, e) => {
    add(`inspectStatsEvent.good#${e}`, 'inspectStatsEvent', ev, fold);
    add(`inspectStatsEvent.nofold#${e}`, 'inspectStatsEvent', ev);
    const fields = [...new Set([...Object.keys(ev), 'source', 'returning', 'surface', 'tab', 'laps'])];
    for (const field of fields) {
      values.forEach((v, i) => add(`inspectStatsEvent.${e}.${field}#${i}`, 'inspectStatsEvent', { ...ev, [field]: v }, fold));
    }
  });
  [...ODD, 'string'].forEach((b, i) => add(`inspectStatsEvent.odd#${i}`, 'inspectStatsEvent', b, fold));
}

/* ---- pilot key and signature shapes ---- */
{
  const key = `B${'A'.repeat(86)}=`;
  const sig = `${'A'.repeat(86)}==`;
  const bodies = [
    {}, { key, sig }, { key }, { sig }, { key: key.slice(1), sig }, { key, sig: sig.slice(1) }, { key: `${key}=`, sig },
    { key: key.replace('B', '-'), sig }, { key: 7, sig }, { key, sig: ['x'] }, { key: '', sig: '' }, { key: ` ${key}`, sig },
    null, undefined, 'string',
  ];
  bodies.forEach((b, i) => add(`inspectAuth#${i}`, 'inspectAuth', b));
}

/* ---- constants ---- */
for (const name of Object.keys(V).sort()) {
  if (typeof V[name] !== 'function') {
    add(`const.${name}`, 'const', name);
  }
}

/* Canonical JSON: keys sorted, undefined kept visible, numbers exact. */
function canonical(value) {
  if (value === undefined) {
    return '"<undefined>"';
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? '"<-0>"' : (Number.isFinite(value) ? JSON.stringify(value) : `"<${value}>"`);
  }
  if (typeof value === 'bigint') {
    return `"<${value}n>"`;
  }
  if (value instanceof RegExp) {
    return JSON.stringify(`<re ${value.source} ${value.flags}>`);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value);
    return JSON.stringify(`<bytes ${b.length} ${createHash('sha256').update(b).digest('hex')}>`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function answer({ fn, args }) {
  if (fn === 'const') {
    return canonical(V[args[0]]);
  }
  try {
    return canonical(V[fn](...args.map((a) => (typeof a === 'function' ? a : structuredCloneSafe(a)))));
  } catch (err) {
    return canonical({ threw: err.constructor.name });
  }
}

/* An input with a toString method cannot be cloned, and needs no cloning. */
function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const labels = new Set();
for (const c of cases) {
  if (labels.has(c.label)) {
    throw new Error(`two cases are labelled ${c.label}`);
  }
  labels.add(c.label);
}

const now = cases.map((c) => `${c.label}\t${digest(answer(c))}`);
if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN, `${now.join('\n')}\n`);
  console.log(`validate golden: wrote ${now.length} cases to tests/golden/validate.txt`);
  process.exit(0);
}

const want = new Map(readFileSync(GOLDEN, 'utf8').trim().split('\n').map((l) => l.split('\t')));
let wrong = 0;
for (const [i, line] of now.entries()) {
  const [label, got] = line.split('\t');
  if (want.get(label) !== got) {
    wrong += 1;
    if (wrong <= 20) {
      const c = cases[i];
      const shown = canonical(c.args.map((a) => (typeof a === 'function' ? '<fold>' : a)));
      console.log(`  FAIL  ${label}: ${want.has(label) ? 'answer changed' : 'not in the golden file'}`);
      console.log(`        input  ${shown.slice(0, 300)}`);
      console.log(`        answer ${answer(c).slice(0, 300)}`);
    }
  }
}
const missing = [...want.keys()].filter((label) => !labels.has(label));
for (const label of missing.slice(0, 20)) {
  console.log(`  FAIL  ${label}: in the golden file but no longer generated`);
}
console.log(`validate golden: ${now.length} cases, ${wrong + missing.length} differ`);
process.exit(wrong + missing.length ? 1 : 0);
