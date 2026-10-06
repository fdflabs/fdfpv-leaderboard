/*
 * validate.js: what the board believes before it keeps anything.
 *
 * Every write the API takes passes through one function here first: a
 * track document, a lap and its ghost, a freestyle run, a bug report and
 * its screenshots, a statistics event. Each answers with the cleaned value
 * the store will keep or with { error } holding the sentence the client is
 * shown, and the simulator shows those sentences to a pilot as they are,
 * so their wording is part of the API.
 *
 * Several lists and formats here are mirrors of the simulator's copies of
 * record (named where they appear). This repository does not import them
 * at run time, on purpose: the board must keep refusing what it refused
 * yesterday when somebody re-pins vendor/fdfpv, and src/selftest.js is
 * what holds each mirror against the pinned simulator.
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

const refuse = (error) => ({ error });

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/* A whole number in [0, max] rounded from the claim, or null. */
function wholeUpTo(raw, max) {
  return finiteNumber(raw) && raw >= 0 && raw <= max ? Math.round(raw) : null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/* Multi-line free text as stored: Windows line ends folded, ends trimmed. */
function prose(raw) {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim();
}

/* ================================================================== */
/* Pilots and times                                                    */
/* ================================================================== */

/* The simulator's src/share/pilot.js carries the same pattern so a pilot
 * hears about a bad name before uploading. That copy predicts; this one
 * decides. Change both together. */
export const NAME_RE = /^[A-Za-z0-9._\- ]{2,24}$/;
export const TRACK_ID_RE = /^trk-[0-9a-f]{8}$/;
export const TIME_ID_RE = /^tm-[0-9a-f]{8}$/;

/* An hour. No lap on any track is near it, and a number past it is not a
 * lap but a stopwatch left running. */
const LAP_CEILING_MS = 60 * 60 * 1000;

/* Inner whitespace closes up to one space, so "Ana  Maria" and "Ana Maria"
 * are one pilot rather than two rows that look the same. */
export function normaliseName(raw) {
  const tidy = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(tidy) ? tidy : null;
}

export function normaliseLapMs(raw) {
  if (!finiteNumber(raw) || raw < 1 || raw > LAP_CEILING_MS) {
    return null;
  }
  return Math.round(raw);
}

/*
 * The best three consecutive laps of a run, optional. A room is scored on
 * three in a row and a field on one, so a time from a room carries both.
 * Anything faster than three of the run's own best lap is a contradiction
 * of the run's own numbers, so it reads as absent, which is what absent,
 * null and garbage all mean here: no clean three.
 */
export function normaliseThreeMs(raw, lapMs) {
  if (!finiteNumber(raw)) {
    return null;
  }
  const ms = Math.round(raw);
  const tooFast = lapMs != null && ms < lapMs * 3;
  return ms >= 1 && ms <= LAP_CEILING_MS * 3 && !tooFast ? ms : null;
}

/*
 * The airframe a plane's lap names. Only the shape is judged here; whether
 * that airframe is a wing that fits the track's gates is the lap check's
 * question in the simulator's src/game/verify.js, which the server asks.
 */
const AIRFRAME_ID = /^[a-z0-9]{1,32}$/;

export function inspectCraft(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { craft: null };
  }
  return typeof raw === 'string' && AIRFRAME_ID.test(raw)
    ? { craft: raw }
    : refuse('That is not an aircraft this board knows.');
}

/*
 * A time's pilot key and signature as the simulator's src/share/identity.js
 * makes them: a raw 65 byte P-256 key and a 64 byte signature, base64. The
 * shape is all that is read here; the server checks the signature itself.
 */
const PILOT_KEY = /^[A-Za-z0-9+/]{87}=$/;
const PILOT_SIG = /^[A-Za-z0-9+/]{86}==$/;

export function inspectAuth(body) {
  const key = typeof body.key === 'string' ? body.key : '';
  const sig = typeof body.sig === 'string' ? body.sig : '';
  if (key === '' && sig === '') {
    return refuse('A time on the board is signed by the pilot key the simulator keeps. Post from there.');
  }
  if (!PILOT_KEY.test(key)) {
    return refuse('That pilot key is not usable.');
  }
  return PILOT_SIG.test(sig) ? { key, sig } : refuse('That signature is not usable.');
}

/* ================================================================== */
/* Ghosts                                                              */
/* ================================================================== */

/*
 * The replay a time is posted with, in the simulator's ghost format (its
 * src/share/ghostdata.js encodes it and is the copy of record). The board
 * reads the 32 byte header and refuses a blob the simulator could not play
 * back, then stores the base64 untouched.
 *
 *   bytes 0-7    "FPVGHST1"
 *   then six little endian u32: version, sample rate in Hz, sample count,
 *   lap duration in ms, split count, reserved
 *   then a u32 per split and 20 bytes per sample
 *
 * At the simulator's limits (30 Hz, ten minutes) a ghost is about 360 kB,
 * 480 kB as base64, which is what the character cap sits just above.
 */
export const GHOST_MAX_CHARS = 500_000;
const GHOST_HEAD = 32;
const GHOST_SAMPLE = 20;
const GHOST_SPLITS_MAX = 256;
/* The simulator writes one rounded number to both the lap and the blob,
 * so more than rounding apart means the blob is another lap's. */
const GHOST_LAP_TOLERANCE_MS = 250;

function readGhostHead(bytes) {
  return {
    magic: bytes.toString('latin1', 0, 8),
    version: bytes.readUInt32LE(8),
    rateHz: bytes.readUInt32LE(12),
    samples: bytes.readUInt32LE(16),
    durationMs: bytes.readUInt32LE(20),
    splits: bytes.readUInt32LE(24),
  };
}

/* The first rule a header breaks, as the sentence for it, or null. */
function ghostFault(bytes, lapMs) {
  const h = readGhostHead(bytes);
  /* The last sample, plus one step, has to reach the finish line, or the
   * replay goes blank just before it. */
  const reach = ((h.samples - 1) * 1000) / h.rateHz + 1000 / h.rateHz;
  const rules = [
    [() => h.magic === 'FPVGHST1', 'That ghost recording is not in the ghost format.'],
    [() => h.version === 1, 'That ghost recording is from an unknown format version.'],
    [() => h.rateHz >= 1 && h.rateHz <= 240, 'That ghost recording claims an unusable sample rate.'],
    [() => h.samples >= 2, 'That ghost recording is too short to replay.'],
    [() => h.durationMs >= 1 && h.durationMs <= 600_000, 'That ghost recording claims an unusable duration.'],
    [() => h.splits <= GHOST_SPLITS_MAX, 'That ghost recording claims too many splits.'],
    [() => bytes.length === GHOST_HEAD + h.splits * 4 + h.samples * GHOST_SAMPLE,
      'That ghost recording does not match its own header.'],
    [() => !(reach < h.durationMs), 'That ghost recording ends before its lap does.'],
    [() => lapMs == null || Math.abs(h.durationMs - lapMs) <= GHOST_LAP_TOLERANCE_MS,
      'That ghost recording does not match the lap time beside it.'],
  ];
  const broken = rules.find(([holds]) => !holds());
  return broken ? broken[1] : null;
}

export function inspectGhost(raw, lapMs) {
  if (raw === undefined || raw === null || raw === '') {
    return { ghost: null };
  }
  if (typeof raw !== 'string') {
    return refuse('A ghost has to be a base64 string.');
  }
  if (raw.length > GHOST_MAX_CHARS) {
    return refuse('That ghost recording is too large.');
  }
  /* 44 characters is the shortest base64 that can hold the header. */
  if (raw.length < 44 || raw.length % 4 !== 0 || !BASE64.test(raw)) {
    return refuse('That ghost recording is not usable base64.');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < GHOST_HEAD) {
    return refuse('That ghost recording is shorter than its header.');
  }
  const fault = ghostFault(bytes, lapMs);
  return fault ? refuse(fault) : { ghost: raw };
}

/* ================================================================== */
/* Track documents                                                     */
/* ================================================================== */

/*
 * The largest document the board takes, as JSON characters. It is the
 * simulator's branding budget (five logos sharing 384 kB) plus the 158 kB
 * a track had beside its single logo before there were five, so a track's
 * gates kept the same room. The publish route's body limit in server.js
 * sits above this so a track that fits is never refused for the wrong
 * reason.
 */
const DOCUMENT_MAX_CHARS = 560_000;
const SCHEMA_VERSIONS = [1, 2, 3, 4];

/*
 * Sponsor logos. The three limits are the simulator's (LOGO_MAX_CHARS,
 * LOGO_SLOTS and BRANDING_MAX_CHARS in its src/trackbuilder/model.js),
 * copied so the board never holds a track the builder would refuse to
 * save. They move together or not at all.
 */
const LOGO_MAX_CHARS = 256 * 1024;
const LOGO_SLOTS = 5;
const BRANDING_MAX_CHARS = 384 * 1024;
const EMBEDDED_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/*
 * Schema 1 spells branding as one `logo`; schema 2 on as `logos`, up to
 * five entries, each an { image } or a bare string. Both are read, since
 * tracks published under the old spelling are still on the board. A bad
 * logo refuses the track rather than being dropped: the board stores what
 * it was given or nothing.
 */
function logoImage(entry) {
  if (typeof entry === 'string') {
    return entry;
  }
  return plainObject(entry) ? entry.image : null;
}

function sponsorLogos(document) {
  const { branding } = document;
  if (branding === undefined || branding === null) {
    return { images: [] };
  }
  if (!plainObject(branding)) {
    return refuse('That track’s branding is not readable.');
  }
  let images = [];
  if (Array.isArray(branding.logos)) {
    images = branding.logos.map(logoImage);
  } else if (branding.logo != null && branding.logo !== '') {
    images = [branding.logo];
  }
  if (images.length > LOGO_SLOTS) {
    return refuse(`A track carries at most ${LOGO_SLOTS} sponsor logos.`);
  }
  const usable = (image) => typeof image === 'string' && image.length <= LOGO_MAX_CHARS && EMBEDDED_IMAGE.test(image);
  if (!images.every(usable)) {
    return refuse('A sponsor logo has to travel inside the track as an embedded image.');
  }
  const total = images.reduce((sum, image) => sum + image.length, 0);
  if (total > BRANDING_MAX_CHARS) {
    return refuse(`A track’s sponsor logos share ${Math.round(BRANDING_MAX_CHARS / 1024)} kB and these come to ${Math.round(total / 1024)} kB.`);
  }
  return { images };
}

/*
 * The worlds a schema 4 track may stand in: the simulator's src/maps/
 * registry.js entries marked `build: true`. The name picks the world every
 * pilot who presses Fly loads, so it is a closed list. A world added there
 * is added here first and deployed first.
 */
export const MAP_IDS = ['swiss2', 'alps'];

/*
 * What the simulator's in-world builder can place (BUILD_TYPES in its
 * src/builder/course.js). Anything else on a schema 4 track is a hand edit
 * the simulator would not know the openings of. `pylon` is scored through
 * the square beside it; the three retired hoop sizes still load and fly,
 * so old tracks carrying them still publish. src/selftest.js compares this
 * with the pinned simulator.
 */
export const MAP_ELEMENT_TYPES = [
  'gate', 'flaggedGate', 'doubleStack', 'ladder', 'tower', 'wideGate3', 'wideGate5', 'pylonPair', 'pylon',
  'hoop175', 'hoop250', 'hoop30', 'hoop6', 'hoop12', 'hoop20',
];

/*
 * Where a schema 4 element may stand, metres from the world's centre. Both
 * worlds are 6000 m squares (FIELD in the simulator's src/maps/alps/
 * terrain.js), the floor is z 0 with the lake just under it and the peaks
 * about 1.4 km up. The vertical band is wide on purpose: it is there to
 * refuse a number that is not a place, not to second guess the builder.
 */
const WORLD_HALF_M = 3000;
const WORLD_FLOOR_M = -100;
const WORLD_CEILING_M = 3000;

/* A schema 4 track's step budget is the ghost's split budget: one split
 * per scored step, so a longer track could never post a lap. */
const WORLD_STEPS_MAX = GHOST_SPLITS_MAX;

/* The builder stores a unit quaternion to six places; a thousandth off
 * unit length is rounding, more is not a rotation. */
const UNIT_TOLERANCE = 1e-3;

export function mapOf(document) {
  if (!plainObject(document) || document.schemaVersion !== 4) {
    return null;
  }
  return MAP_IDS.includes(document.map) ? document.map : null;
}

function standsInWorld(p) {
  return Math.abs(p.x) <= WORLD_HALF_M && Math.abs(p.y) <= WORLD_HALF_M
    && p.z >= WORLD_FLOOR_M && p.z <= WORLD_CEILING_M;
}

function isRotation(q) {
  return plainObject(q) && [q.w, q.x, q.y, q.z].every(finiteNumber)
    && Math.abs(Math.hypot(q.w, q.x, q.y, q.z) - 1) <= UNIT_TOLERANCE;
}

/* The sentence for the first way a schema 4 element is wrong, or null. */
function worldElementFault(el) {
  if (!plainObject(el) || !MAP_ELEMENT_TYPES.includes(el.type)) {
    return 'A track built in a world carries only the gates its builder places.';
  }
  const p = el.position;
  if (!plainObject(p) || ![p.x, p.y, p.z].every(finiteNumber)) {
    return 'Every gate on a track built in a world needs a position.';
  }
  if (!standsInWorld(p)) {
    return 'A gate on that track stands outside its world.';
  }
  return isRotation(el.orientation) ? null : 'Every gate on a track built in a world needs an orientation.';
}

/* What a schema 4 track needs beyond what every track needs. */
function worldTrackFault(document) {
  if (!MAP_IDS.includes(document.map)) {
    return `A version 4 track names the world it stands in, and this board knows ${MAP_IDS.join(' and ')}.`;
  }
  if (Math.max(document.elements.length, document.sequence.length) > WORLD_STEPS_MAX) {
    return `A track built in a world carries at most ${WORLD_STEPS_MAX} gates.`;
  }
  for (const el of document.elements) {
    const fault = worldElementFault(el);
    if (fault) {
      return fault;
    }
  }
  return null;
}

/*
 * 'full' is the sixty metre field, 'micro' a RaceGOW room, 'wing' a fixed
 * wing's airfield, as the simulator's src/trackbuilder/elements.js has it.
 * Schema 1 and 2 carry no class and are fields. Read off the document every
 * time rather than kept in a column: one copy of the truth.
 */
export const TRACK_CLASSES = ['full', 'micro', 'wing'];

export function trackClassOf(document) {
  if (plainObject(document) && TRACK_CLASSES.includes(document.trackClass)) {
    return document.trackClass;
  }
  return 'full';
}

/*
 * Who designed the track, which on the RaceGOW rooms is not who published
 * it. Only a string is a name: String() of an object would put "[object
 * Object]" on a card. Control characters become spaces and runs of space
 * close up, so the API and the card agree on the text.
 */
function creditLine(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, 80).trim();
}

export function creditOf(document) {
  const credit = plainObject(document) && plainObject(document.credit) ? document.credit : {};
  return { designer: creditLine(credit.designer), series: creditLine(credit.series) };
}

/*
 * Painted on, not flown through: a ground logo has no collider and is not
 * in the flying order, so adding one cannot change a lap. Leaving it out
 * of the layout hash is what lets a sponsor's logo go onto a track without
 * wiping its times. The simulator's src/share/listing.js has the same list
 * as LAYOUT_SKIP; both are literals and are edited together.
 */
const PAINT_TYPES = new Set(['groundLogo']);

/*
 * The fingerprint that decides whether a republished track keeps its
 * times: field, elements and sequence, the same key list as the
 * simulator's layoutFingerprint. A schema 4 track's world goes in front,
 * because the same gates in another world are another race; no other
 * track carries the key, so every schema 1 to 3 hash is unchanged.
 */
export function layoutHash(document) {
  const layout = {};
  if (mapOf(document)) {
    layout.map = document.map;
  }
  layout.field = document.field ?? {};
  layout.elements = (document.elements ?? []).filter((el) => !plainObject(el) || !PAINT_TYPES.has(el.type));
  layout.sequence = document.sequence ?? [];
  return sha256(JSON.stringify(layout));
}

export function hashEditKey(key) {
  return sha256(String(key));
}

/* Not drawn on a plan: a waypoint is an order pin with nothing standing,
 * a label is an authoring note, a ground logo is paint. */
const UNDRAWN_TYPES = new Set(['label', 'waypoint', 'groundLogo']);

/* The field elements that are flown through, which earn a number badge
 * and count as gates. */
const OPENING_TYPES = new Set([
  'gate', 'flaggedGate', 'doubleStack', 'flaggedDoubleStack', 'ladder', 'tower', 'diveGate',
]);

/* A positive size from an element's dims, or undefined so the page falls
 * back to the type's default. `zeroOk` admits nought, which a start row's
 * spacing can be. */
function size(raw, zeroOk = false) {
  const n = Number(raw);
  return Number.isFinite(n) && (zeroOk ? n >= 0 : n > 0) ? n : undefined;
}

/*
 * One mark on the plan. The sizes are copied per element because each is
 * editable in the builder: a ladder raised to five levels, a twenty metre
 * barrier, a room's 0.711 m gate in a 5 m room. Drawn from defaults, they
 * came out wrong while the card's own gate count was right.
 */
function planMark(el, type, flown) {
  const dims = el.dims;
  return {
    type,
    x: Number(el.position.x) || 0,
    y: Number(el.position.y) || 0,
    yaw: Number(el.yaw) || 0,
    seq: flown.has(el.id),
    levels: size(dims?.levels),
    w: size(dims?.width),
    d: size(dims?.depth),
    clearW: size(dims?.clearW),
    pads: size(dims?.pads),
    spacing: size(dims?.spacing, true),
    padSize: size(dims?.padSize),
  };
}

/*
 * A schema 4 plan, framed on its own gates. Its positions are metres from
 * the middle of a six kilometre world, so drawn on the page's corner-origin
 * rectangle they would be a speck. The frame is the gates' extent plus a
 * margin, everything moves into it, and the builder's types draw as the
 * two symbols the page has: a gate, or a cone for the pylon.
 */
function framedOnGates(document, plan) {
  if (plan.marks.length === 0) {
    return { ...plan, map: document.map, width: 60, depth: 40 };
  }
  const xs = plan.marks.map((m) => m.x);
  const ys = plan.marks.map((m) => m.y);
  const [left, right, near, far] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const margin = Math.max(10, Math.max(right - left, far - near) * 0.12);
  const originX = left - margin;
  const originY = near - margin;
  const moved = (p) => ({ ...p, x: p.x - originX, y: p.y - originY });
  return {
    ...plan,
    map: document.map,
    width: right + margin - originX,
    depth: far + margin - originY,
    marks: plan.marks.map((m) => moved({ ...m, type: m.type === 'pylon' ? 'cone' : 'gate' })),
    path: plan.path.map(moved),
    numbers: plan.numbers.map(moved),
  };
}

/*
 * What a card draws: the marks standing on the field, the flown line
 * through them, and a number per step of the flying order. A badge is per
 * step, not per element, so a gate flown three times shows three numbers
 * (`stack` says how many already sit on that spot, so the page can fan
 * them out) and the last badge agrees with the gate count and the OSD.
 */
export function planFromDocument(document) {
  const field = plainObject(document.field) ? document.field : {};
  const inWorld = mapOf(document) !== null;
  const steps = document.sequence || [];

  const flown = new Set();
  for (const step of steps) {
    if (plainObject(step) && typeof step.elementId === 'string' && step.elementId !== '') {
      flown.add(step.elementId);
    }
  }

  const placed = new Map();
  const marks = [];
  for (const el of document.elements || []) {
    if (!plainObject(el) || !plainObject(el.position)) {
      continue;
    }
    if (typeof el.id === 'string' && el.id !== '') {
      placed.set(el.id, el);
    }
    const type = String(el.type || 'gate');
    if (!UNDRAWN_TYPES.has(type)) {
      marks.push(planMark(el, type, flown));
    }
  }

  const path = [];
  const numbers = [];
  const badgesAt = new Map();
  for (const step of steps) {
    const el = plainObject(step) ? placed.get(step.elementId) : undefined;
    if (!el) {
      continue;
    }
    const x = Number(el.position.x) || 0;
    const y = Number(el.position.y) || 0;
    const previous = path.at(-1);
    if (!previous || previous.x !== x || previous.y !== y) {
      path.push({ x, y });
    }
    const type = String(el.type || '');
    const scored = OPENING_TYPES.has(type) || (inWorld && MAP_ELEMENT_TYPES.includes(type));
    if (scored && el.id) {
      const spot = `${x},${y}`;
      const stack = badgesAt.get(spot) ?? 0;
      badgesAt.set(spot, stack + 1);
      numbers.push({ n: numbers.length + 1, x, y, stack });
    }
  }

  const trackClass = trackClassOf(document);
  /* A room that forgot its field is a room, not a sixty metre field. */
  const [fallbackW, fallbackD] = trackClass === 'micro' ? [5, 6] : [60, 40];
  const plan = {
    trackClass,
    width: Number(field.width) || fallbackW,
    depth: Number(field.depth) || fallbackD,
    marks,
    path,
    numbers,
  };
  return inWorld ? framedOnGates(document, plan) : plan;
}

/*
 * Gates, which is not the length of the flying order: a waypoint step
 * stands for nothing and a marker only scores with clearance, as in the
 * simulator's src/game/trackdoc.js. In a world every step is scored, so
 * there the order is the count.
 */
const SCORED_CLEARANCE_M = 0.05;

function gateCount(document) {
  if (mapOf(document)) {
    return document.sequence.length;
  }
  const byId = new Map();
  for (const el of document.elements) {
    if (plainObject(el) && typeof el.id === 'string' && el.id !== '') {
      byId.set(el.id, el);
    }
  }
  return document.sequence.filter((step) => {
    const el = byId.get(step.elementId);
    return OPENING_TYPES.has(String(el.type || '')) || Number(el.dims?.clearance) >= SCORED_CLEARANCE_M;
  }).length;
}

function parsedDocument(raw) {
  if (typeof raw === 'string' && raw.length > DOCUMENT_MAX_CHARS) {
    return refuse('That track is too large to publish.');
  }
  const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (json.length > DOCUMENT_MAX_CHARS) {
    return refuse('That track is too large to publish.');
  }
  if (typeof raw !== 'string') {
    return { document: raw };
  }
  try {
    return { document: JSON.parse(raw) };
  } catch {
    return refuse('That track is not valid JSON.');
  }
}

/* The checks every track shares, in order; the first sentence wins. */
function trackFault(document) {
  if (!plainObject(document)) {
    return 'That file is not a track document.';
  }
  if (!SCHEMA_VERSIONS.includes(document.schemaVersion)) {
    return 'This board accepts schemaVersion 1, 2, 3 and 4 tracks.';
  }
  if (!TRACK_ID_RE.test(String(document.id || ''))) {
    return 'That track has no usable id.';
  }
  if (!plainObject(document.field)) {
    return 'That track is missing its field.';
  }
  if (!Array.isArray(document.elements) || !Array.isArray(document.sequence)) {
    return 'That track is missing its elements or its flying order.';
  }
  if (document.sequence.length === 0) {
    return 'A published track needs at least one gate in the flying order.';
  }
  const ids = new Set(document.elements
    .filter((el) => plainObject(el) && typeof el.id === 'string' && el.id !== '')
    .map((el) => el.id));
  if (!document.sequence.every((step) => plainObject(step) && ids.has(step.elementId))) {
    return 'That flying order names a gate that is not in the track.';
  }
  return document.schemaVersion === 4 ? worldTrackFault(document) : null;
}

/*
 * A track to publish, as the object or as its JSON text. Schema 1 is the
 * original; 2 grew five logos; 3 added the class; 4 is built inside a
 * world and read more strictly. 1 to 3 differ only in branding and class,
 * so a track republished from a newer builder keeps its layout hash and
 * its times. Returns the summary the store keeps beside the document.
 */
export function inspectDocument(raw) {
  const parsed = parsedDocument(raw);
  if (parsed.error) {
    return parsed;
  }
  const { document } = parsed;
  const fault = trackFault(document);
  if (fault) {
    return refuse(fault);
  }
  const logos = sponsorLogos(document);
  if (logos.error) {
    return refuse(logos.error);
  }
  const name = String(document.name || '').trim() || 'Untitled track';
  return {
    document,
    id: String(document.id),
    name: name.slice(0, 80),
    hasLogo: logos.images.length > 0,
    logoCount: logos.images.length,
    gates: gateCount(document),
    elements: document.elements.length,
    trackClass: trackClassOf(document),
    map: mapOf(document),
    layoutHash: layoutHash(document),
    plan: planFromDocument(document),
  };
}

/* ================================================================== */
/* Card animations                                                     */
/* ================================================================== */

/*
 * A room's card animation: a GIF the simulator's builder renders and
 * uploads; the board only bounds it. Only a room gets one. A field's plan
 * already says everything at a glance and costs nothing, while a room's
 * plan is a near empty rectangle and its difficulty is vertical. The rule
 * lives here, read off the stored document, so no uploader can add a
 * quarter megabyte to every field card.
 *
 * The cap is about 1.8 MB of GIF, far above the 20 to 70 kB real ones and
 * well under a renamed video.
 */
export const MAX_GIF_BASE64_CHARS = 2_500_000;
const GIF_SIDE_MIN = 64;
const GIF_SIDE_MAX = 4096;

/* Width and height from the logical screen descriptor, or null when the
 * bytes are not a GIF at all. */
function gifSize(bytes) {
  const magic = bytes.subarray(0, 6).toString('latin1');
  if (bytes.length < 10 || (magic !== 'GIF87a' && magic !== 'GIF89a')) {
    return null;
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

export function inspectGif({ base64, document }) {
  if (trackClassOf(document) !== 'micro') {
    return refuse('This board keeps an animation for a room, not for a field track.');
  }
  const packed = String(base64 || '').replace(/^data:image\/gif;base64,/, '').trim();
  if (packed === '') {
    return refuse('That upload carried no animation.');
  }
  if (packed.length > MAX_GIF_BASE64_CHARS) {
    return refuse('That animation is too large for this board.');
  }
  if (!BASE64.test(packed)) {
    return refuse('That animation is not base64.');
  }
  const bytes = Buffer.from(packed, 'base64');
  const dims = gifSize(bytes);
  if (!dims) {
    return refuse('That upload is not a GIF.');
  }
  /* Under 64 is a tracking pixel standing in for a track; over 4096 is a
   * frame buffer, not a card. */
  const fits = (side) => side >= GIF_SIDE_MIN && side <= GIF_SIDE_MAX;
  if (!fits(dims.width) || !fits(dims.height)) {
    return refuse('That animation is not a usable size.');
  }
  return { bytes, width: dims.width, height: dims.height };
}

/* ================================================================== */
/* Bug reports                                                         */
/* ================================================================== */

export const BUG_ID_RE = /^bug-[0-9a-f]{8}$/;
export const BUG_KINDS = ['crash', 'blocking', 'wrong', 'visual', 'feel', 'other'];
export const BUG_STATUSES = ['open', 'in_progress', 'fixed', 'wontfix', 'duplicate'];

/*
 * Whatever the simulator attaches about the session (map, GPU, browser),
 * so whoever fixes the report need not ask. Bounded by size, and by key
 * count only against an object of thousands of tiny keys: the simulator's
 * feel reports already send about twenty, so 32 leaves room.
 */
const CONTEXT_MAX_CHARS = 8000;
const CONTEXT_MAX_KEYS = 32;

function reportContext(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { context: {} };
  }
  if (!plainObject(raw)) {
    return refuse('Context has to be a JSON object.');
  }
  let json;
  try {
    json = JSON.stringify(raw);
  } catch {
    return refuse('Context is not usable JSON.');
  }
  if (json.length > CONTEXT_MAX_CHARS) {
    return refuse('That context is too large.');
  }
  if (Object.keys(raw).length > CONTEXT_MAX_KEYS) {
    return refuse('That context has too many fields.');
  }
  return { context: JSON.parse(json) };
}

/*
 * A tester's report. Kind, title and what happened are required; a blank
 * name is stored as Anonymous, and a name that is given has to be a name.
 */
export function inspectBugCreate(body) {
  if (!plainObject(body)) {
    return refuse('That request was not a JSON object.');
  }
  const kind = String(body.kind || 'other');
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  const what = prose(body.what);
  const expected = prose(body.expected);
  const steps = prose(body.steps);
  const reporter = normaliseName(body.reporter);
  const fault = [
    [!BUG_KINDS.includes(kind), 'Pick a kind: crash, blocking, wrong, visual, feel or other.'],
    [title.length < 8 || title.length > 120, 'A title needs eight to one hundred and twenty characters.'],
    [what.length < 20 || what.length > 4000, 'Say what happened, twenty to four thousand characters.'],
    [expected.length > 2000, 'Expected result is too long.'],
    [steps.length > 2000, 'Steps are too long.'],
    [String(body.reporter ?? '').trim() !== '' && !reporter,
      'A name is two to twenty four letters, numbers, spaces, dots, underscores or hyphens, or leave it blank.'],
  ].find(([broken]) => broken);
  if (fault) {
    return refuse(fault[1]);
  }
  const context = reportContext(body.context);
  if (context.error) {
    return context;
  }
  const shots = inspectBugImages(body.images);
  if (shots.error) {
    return shots;
  }
  return {
    kind, title, what, expected, steps,
    reporter: reporter || 'Anonymous',
    context: context.context,
    images: shots.images,
  };
}

/*
 * Screenshots on a report, bounded like any stranger's upload: count, size
 * each and together, and the type read off the bytes. A declared type is
 * only stripped, never believed, because these are served to the admin's
 * browser, which holds the board's one credential, and an SVG sent as a
 * "PNG" must not reach it as anything but refused. The simulator scales
 * and re-encodes under a million bytes before sending, so a mebibyte each
 * is headroom. BUG_BODY_MAX in server.js is derived from the total.
 */
export const MAX_BUG_IMAGES = 4;
export const MAX_BUG_IMAGE_BYTES = 1_048_576;
export const MAX_BUG_IMAGES_BYTES = MAX_BUG_IMAGES * MAX_BUG_IMAGE_BYTES;
const SHOT_MAX_CHARS = Math.ceil(MAX_BUG_IMAGE_BYTES / 3) * 4;

const MAGIC_TYPES = [
  { type: 'image/png', at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', at: 0, bytes: [0xff, 0xd8, 0xff] },
];

export function imageTypeOf(bytes) {
  const starts = ({ at, bytes: sig }) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
  const known = MAGIC_TYPES.find(starts);
  if (known) {
    return known.type;
  }
  const riff = bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  return riff ? 'image/webp' : null;
}

function screenshot(item, n) {
  const packed = String(item ?? '').replace(/^data:image\/(png|jpeg|webp);base64,/, '').trim();
  if (packed === '') {
    return refuse(`Image ${n} is empty.`);
  }
  if (packed.length > SHOT_MAX_CHARS) {
    return refuse(`Image ${n} is larger than a megabyte.`);
  }
  if (!BASE64.test(packed)) {
    return refuse(`Image ${n} is not base64.`);
  }
  const bytes = Buffer.from(packed, 'base64');
  if (bytes.length > MAX_BUG_IMAGE_BYTES) {
    return refuse(`Image ${n} is larger than a megabyte.`);
  }
  const type = imageTypeOf(bytes);
  return type ? { type, bytes } : refuse(`Image ${n} is not a PNG, JPEG or WebP.`);
}

export function inspectBugImages(raw) {
  if (raw === undefined || raw === null) {
    return { images: [] };
  }
  if (!Array.isArray(raw)) {
    return refuse('Images have to be a list.');
  }
  if (raw.length > MAX_BUG_IMAGES) {
    return refuse('Attach at most four images.');
  }
  const images = [];
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const shot = screenshot(raw[i], i + 1);
    if (shot.error) {
      return shot;
    }
    bytes += shot.bytes.length;
    if (bytes > MAX_BUG_IMAGES_BYTES) {
      return refuse('The images are too large together.');
    }
    images.push(shot);
  }
  return { images };
}

/* An agent's update to a report: a status, a resolution, or both. */
export function inspectBugPatch(body) {
  if (!plainObject(body)) {
    return refuse('That request was not a JSON object.');
  }
  const patch = {};
  if (body.status != null) {
    patch.status = String(body.status);
    if (!BUG_STATUSES.includes(patch.status)) {
      return refuse('Status is open, in_progress, fixed, wontfix or duplicate.');
    }
  }
  if (body.resolution != null) {
    patch.resolution = prose(body.resolution);
    if (patch.resolution.length > 4000) {
      return refuse('That resolution is too long.');
    }
  }
  return Object.keys(patch).length ? patch : refuse('Send a status or a resolution.');
}

/* ================================================================== */
/* Tags                                                                */
/* ================================================================== */

/*
 * A closed vocabulary, because a filter only narrows when everybody spells
 * an idea the same way, and free text gives a board "race", "racing" and
 * "Race Track" as three tags. The first three are the author's intent, the
 * rest the shapes published tracks kept having.
 *
 * `id` travels and is stored, so it never changes and is never removed
 * (that would strand the tracks wearing it); `label` is printed and can
 * change. `micro` prints as "Small field" because "Micro" now also names a
 * track class, a different thing one word away.
 */
export const TAGS = [
  { id: 'race', label: 'Race track' },
  { id: 'skills', label: 'Skills practice' },
  { id: 'experiment', label: 'Experiment' },
  { id: 'freestyle', label: 'Freestyle' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'technical', label: 'Technical' },
  { id: 'micro', label: 'Small field' },
  { id: 'big', label: 'Big field' },
  { id: 'showcase', label: 'Showcase' },
];

/* Past five a tag stops narrowing: a track wearing every tag answers
 * every filter. */
export const TAGS_MAX = 5;

/*
 * Absent is none, which every track from before tags is. An unknown id is
 * refused, not dropped, so an author learns their tag did not stick. The
 * stored list is in the board's order, so the same tags always read the
 * same on a card.
 */
export function inspectTags(raw) {
  if (raw === undefined || raw === null) {
    return { tags: [] };
  }
  if (!Array.isArray(raw)) {
    return refuse('Tags are a list.');
  }
  if (raw.length > TAGS_MAX) {
    return refuse(`A track wears at most ${TAGS_MAX} tags.`);
  }
  const chosen = new Set();
  for (const entry of raw) {
    const id = String(entry ?? '').trim().toLowerCase();
    if (!TAGS.some((t) => t.id === id)) {
      return refuse(`There is no tag called "${String(entry ?? '').slice(0, 24)}".`);
    }
    chosen.add(id);
  }
  return { tags: TAGS.map((t) => t.id).filter((id) => chosen.has(id)) };
}

/* ================================================================== */
/* Freestyle runs                                                      */
/* ================================================================== */

export const RUN_ID_RE = /^run-[0-9a-f]{8}$/;

/* The simulator's freestyle worlds, its src/maps/registry.js entries with
 * `mode: 'freestyle'`; src/selftest.js holds the two together. */
export const RUN_MAPS = ['alps', 'swiss2', 'yellowstone'];

/* Expert and arcade are different sports (arcade drops propwash, gyro
 * noise and build asymmetry), so a run records which and the board never
 * ranks them together. */
export const RUN_STYLES = ['expert', 'arcade'];

const RUN_MIN_MS = 1000;
const RUN_MAX_MS = 900_000;
const RUN_MAX_TRICKS = 600;
const SIGNATURE_MAX_CHARS = 40;

/*
 * The most n tricks could score under the simulator's rules. The board
 * cannot recompute a score without becoming a second copy of the game, so
 * every number in a run is a claim; this bounds it. The dearest trick is
 * 850 points, the streak multiplier after n tricks is at most
 * 1 + n * 850 / 10000, and the combo multiplier caps at 12, so n tricks
 * are worth at most n * 850 * (1 + 0.085 n) * 12. Loose on purpose: it
 * refuses what the game could not produce, and stops nobody determined,
 * which the README says.
 */
export function maxPlausibleScore(tricks) {
  const n = tricks > 0 ? tricks : 1;
  return Math.ceil(n * 850 * (1 + n * 0.085) * 12);
}

/*
 * A posted run, as the row the store keeps. Every field is checked,
 * including those only the page displays, because what is stored unchecked
 * reaches every visitor unchecked.
 */
export function inspectRun(body) {
  if (!plainObject(body)) {
    return refuse('That request was not a JSON object.');
  }
  const name = normaliseName(body.name);
  if (!name) {
    return refuse('A pilot name is 2 to 24 letters, digits, dots, dashes or spaces.');
  }
  const map = String(body.map ?? '');
  if (!RUN_MAPS.includes(map)) {
    return refuse('That is not a map this board keeps scores for.');
  }
  const style = String(body.style ?? '');
  if (!RUN_STYLES.includes(style)) {
    return refuse('A run is flown on the expert or the arcade physics model.');
  }
  const durationMs = wholeUpTo(body.durationMs, RUN_MAX_MS);
  if (durationMs === null || durationMs < RUN_MIN_MS) {
    return refuse('That run is not long enough to be a run.');
  }
  const tricks = wholeUpTo(body.tricks, RUN_MAX_TRICKS);
  if (tricks === null || tricks < 1) {
    return refuse('A run with no tricks in it is not a score.');
  }
  const unique = wholeUpTo(body.unique, RUN_MAX_TRICKS);
  if (unique === null || unique < 1 || unique > tricks) {
    return refuse('A run cannot have more distinct tricks than tricks.');
  }
  const ceiling = maxPlausibleScore(tricks);
  const score = wholeUpTo(body.score, ceiling);
  if (score === null || score < 1) {
    return refuse('That score could not have come from that many tricks.');
  }
  const bestCombo = wholeUpTo(body.bestCombo, ceiling);
  if (bestCombo === null || bestCombo > score) {
    return refuse('The best chain in a run cannot be worth more than the run.');
  }
  const bestTrick = wholeUpTo(body.bestTrick, ceiling);
  if (bestTrick === null || bestTrick > score) {
    return refuse('One trick in a run cannot be worth more than the run.');
  }
  const crashes = wholeUpTo(body.crashes, RUN_MAX_TRICKS);
  if (crashes === null) {
    return refuse('That crash count is not a count.');
  }
  /* The trick the run is remembered by, a name from a catalogue the board
   * does not hold, so it is trimmed to printable ASCII and bounded. */
  const signature = String(body.signature ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, SIGNATURE_MAX_CHARS);
  return {
    run: { name, map, style, score, durationMs, tricks, unique, bestCombo, bestTrick, crashes, signature },
  };
}

/* ================================================================== */
/* Site statistics                                                     */
/* ================================================================== */

/*
 * The gate in front of the counters. The store adds to daily totals and
 * keeps nothing about one browser, and most of that promise is the wire
 * format: there is no field for an address, an agent, a screen, a
 * referrer, a name or a track, and an extra key is never read. The one per
 * tab string, `tab`, is random per page load, held in server memory three
 * minutes for "flying now", and never stored.
 *
 * Every dimension is a closed list (a source folds to a sponsor or
 * `other`, a country to two capitals or ZZ, craft, map and input to
 * `other`), which bounds the rows a stranger with curl can create. The
 * deltas a flush may carry are a minute's worth with room; a claim past
 * that is refused, never clamped to a number nobody sent.
 */
export const STATS_KINDS = ['visit', 'session', 'flush'];

/* The landing page is listed ahead of it sending anything: the board
 * deploys before the pages that talk to it (DEPLOY.md in the simulator). */
export const STATS_SURFACES = ['sim', 'builder', 'board', 'landing'];

/*
 * Airframe ids as the simulator's configs/airframes.js spells them, so the
 * page can print a name from the id. `5inch` and `whoop65` left that
 * catalogue on 2026-10-03 but stay: older clients folded every aircraft
 * onto them and their stored rows are history. An unknown id folds to
 * `other` instead of being refused, since refusing would drop the session
 * and its minute of "flying now" whenever the simulator adds an airframe.
 */
export const STATS_CRAFT = [
  '5inch', 'whoop65',
  '7inch', '10inch', 'interceptor', 'sky1800', 'cub1400', 'radian2000', 'bramor2300', 'slowstick1180',
  'timber1500', 'timber1500f', 'cub1400f', 'bombshell1118', 'kadet1981', 'uglystik1567', 'tigermoth1803',
  'p51d1450', 'f16878', 'zagi1219', 'nrj1490', 'striker2500',
];

/* `custom` is a track, built or fetched; `city` is freestyle. Others fold
 * so a new simulator map never makes an older board refuse sessions. */
export const STATS_MAPS = ['custom', 'city'];

/* A radio in joystick mode reports as `gamepad`: either way, sticks. */
export const STATS_INPUTS = ['gamepad', 'keyboard', 'touch'];

export const STATS_OTHER = 'other';
export const STATS_COUNTRY_UNKNOWN = 'ZZ';

const FLUSH_LIMITS = { laps: 30, flightS: 90, crashes: 60 };

/* Loose on purpose (a UUID fits, nothing depends on its shape) but
 * bounded, so it cannot carry a kilobyte. */
const TAB_HANDLE = /^[A-Za-z0-9-]{8,36}$/;

/*
 * The edge's two letters, or ZZ. Nothing here looks an address up; the
 * server believes the header only behind BOARD_TRUST_PROXY. XX (no
 * country) and T1 (Tor) are Cloudflare's, and mean unknown here too.
 */
export function normaliseCountry(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  const known = /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1';
  return known ? code : STATS_COUNTRY_UNKNOWN;
}

function oneOf(list, raw) {
  const word = String(raw ?? '').trim();
  return list.includes(word) ? word : STATS_OTHER;
}

/* Absent is nought: an empty flush is the heartbeat behind "flying now". */
function flushCount(raw, max) {
  return raw === undefined || raw === null ? 0 : wholeUpTo(raw, max);
}

/* No sponsor fold given: absent is direct, anything else is other. */
function plainSource(raw) {
  return raw == null ? 'direct' : STATS_OTHER;
}

/*
 * One posted event, as { event } holding exactly what the store reads.
 * The source fold is passed in (the server hands src/sponsors.js's) so
 * the sponsor list keeps one home.
 */
export function inspectStatsEvent(body, sourceKey) {
  if (!plainObject(body)) {
    return refuse('That request was not a JSON object.');
  }
  if (body.v !== 1) {
    return refuse('That is not a version of this format the board reads.');
  }
  const kind = String(body.kind ?? '');
  if (!STATS_KINDS.includes(kind)) {
    return refuse('That is not a kind of event this board counts.');
  }
  const source = (typeof sourceKey === 'function' ? sourceKey : plainSource)(body.source);
  if (kind === 'session') {
    return {
      event: {
        kind,
        craft: oneOf(STATS_CRAFT, body.craft),
        map: oneOf(STATS_MAPS, body.map),
        input: oneOf(STATS_INPUTS, body.input),
        source,
      },
    };
  }
  if (kind === 'visit') {
    const surface = String(body.surface ?? '');
    if (!STATS_SURFACES.includes(surface)) {
      return refuse('That is not a page this board counts visits from.');
    }
    /* The browser sends its answer, never the date it kept: a date would
     * be a fingerprint and a boolean is not. */
    if (typeof body.returning !== 'boolean') {
      return refuse('A visit says whether this browser has been here before.');
    }
    return { event: { kind, surface, returning: body.returning, source } };
  }
  const tab = String(body.tab ?? '');
  if (!TAB_HANDLE.test(tab)) {
    return refuse('That is not a usable tab handle.');
  }
  const counts = {};
  for (const [field, max] of Object.entries(FLUSH_LIMITS)) {
    counts[field] = flushCount(body[field], max);
  }
  if (Object.values(counts).includes(null)) {
    return refuse('That is more than a minute of flying can hold.');
  }
  return {
    event: {
      kind,
      tab,
      craft: oneOf(STATS_CRAFT, body.craft),
      map: oneOf(STATS_MAPS, body.map),
      ...counts,
      source,
    },
  };
}

/*
 * The UTC day a counter lands on, by the server's clock: a browser's clock
 * is too often wrong to name the day, and UTC keeps the boundary still
 * when a host moves region.
 */
export function statsDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}
