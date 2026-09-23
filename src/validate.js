/*
 * validate.js: names, times, and the track document this board will store.
 *
 * The document is the same schema.md object the simulator's track builder
 * writes. This file does not import that code. It checks the few things
 * the board must believe before it will keep a copy: a version it knows,
 * a stable id, a flying order, and a logo that is an embedded image or
 * nothing. The simulator is the reader that decides what a gate means.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { createHash } from 'node:crypto';

/* MIRRORS NAME_RE in fdfpv/src/share/pilot.js. This copy is the
 * one that decides; the simulator's is a prediction of it so a pilot is told
 * before they upload. Two repos, so change both. */
export const NAME_RE = /^[A-Za-z0-9._\- ]{2,24}$/;
export const TRACK_ID_RE = /^trk-[0-9a-f]{8}$/;
export const TIME_ID_RE = /^tm-[0-9a-f]{8}$/;
/*
 * 560_000, up from 420_000, and the number is derived rather than picked.
 * A track carries up to five sponsors' logos now instead of one, sharing a
 * 384 kB budget (BRANDING_MAX_CHARS in the simulator's
 * src/trackbuilder/model.js). The old cap was one 256 kB logo plus about
 * 158 kB of headroom for the track itself; this is the new branding budget
 * plus the same headroom, so exactly as much room is left for gates as
 * before. See also the publish body limit in server.js, which has to be
 * above this or a track that fits is refused before it is read.
 */
const MAX_DOCUMENT_CHARS = 560_000;
const MAX_LAP_MS = 3_600_000;

export function normaliseName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

export function normaliseLapMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1 || raw > MAX_LAP_MS) {
    return null;
  }
  return Math.round(raw);
}

/*
 * The fastest THREE CONSECUTIVE laps of the run, in milliseconds, or null.
 *
 * RaceGOW is scored on three consecutive laps where MultiGP's time trial is
 * scored on one, so a time posted from a room carries both and a time posted
 * from the field carries the lap alone. Optional everywhere: absent, null and
 * unusable all mean the same thing, which is that this run did not put three
 * clean laps together.
 *
 * Bounded against the lap it arrived with rather than against a constant.
 * Three laps of a run cannot be faster than three of its own best lap, and
 * the posted lap IS the best lap, so anything under 3 x lapMs is not a
 * measurement, it is a claim the run's own numbers contradict.
 */
export function normaliseThreeMs(raw, lapMs) {
  if (raw == null) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  const ms = Math.round(raw);
  if (ms < 1 || ms > MAX_LAP_MS * 3) {
    return null;
  }
  if (lapMs != null && ms < lapMs * 3) {
    return null;
  }
  return ms;
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Ghost laps                                                          */
/* ------------------------------------------------------------------ */

/*
 * MIRRORS the wire format in fdfpv/src/share/ghostdata.js, the
 * same arrangement as NAME_RE above: the simulator's module is the copy of
 * record and encodes; this is the board's own reading of the header so it
 * never stores a blob the simulator could not replay. Two repos, so a
 * format change lands in both.
 *
 * The caps are the simulator's: 30 Hz grid, ten minutes of lap, 20 bytes a
 * sample. The largest legitimate blob is therefore ~360 KB of bytes, which
 * is ~480 KB of base64; the character cap sits just above that and well
 * under the route's body limit.
 */
const GHOST_MAGIC = 'FPVGHST1';
const GHOST_VERSION = 1;
const GHOST_HEADER_BYTES = 32;
const GHOST_SAMPLE_BYTES = 20;
const GHOST_MAX_MS = 600_000;
const GHOST_MAX_SPLITS = 256;
export const GHOST_MAX_CHARS = 500_000;
/* How far the blob's own duration may sit from the lap time it was posted
 * with. The simulator writes the same rounded number to both, so anything
 * past rounding slack is a blob for a different lap. */
const GHOST_LAP_SLACK_MS = 250;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/*
 * A posted ghost, judged: { ghost } with the base64 exactly as it will be
 * stored, or { error } with the reason. lapMs is the already-normalised
 * lap the ghost arrived beside.
 */
export function inspectGhost(raw, lapMs) {
  if (raw == null || raw === '') {
    return { ghost: null };
  }
  if (typeof raw !== 'string') {
    return { error: 'A ghost has to be a base64 string.' };
  }
  if (raw.length > GHOST_MAX_CHARS) {
    return { error: 'That ghost recording is too large.' };
  }
  if (raw.length < 44 || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
    return { error: 'That ghost recording is not usable base64.' };
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < GHOST_HEADER_BYTES) {
    return { error: 'That ghost recording is shorter than its header.' };
  }
  if (bytes.toString('latin1', 0, 8) !== GHOST_MAGIC) {
    return { error: 'That ghost recording is not in the ghost format.' };
  }
  if (bytes.readUInt32LE(8) !== GHOST_VERSION) {
    return { error: 'That ghost recording is from an unknown format version.' };
  }
  const rateHz = bytes.readUInt32LE(12);
  const count = bytes.readUInt32LE(16);
  const durationMs = bytes.readUInt32LE(20);
  const splitCount = bytes.readUInt32LE(24);
  if (rateHz < 1 || rateHz > 240) {
    return { error: 'That ghost recording claims an unusable sample rate.' };
  }
  if (count < 2) {
    return { error: 'That ghost recording is too short to replay.' };
  }
  if (durationMs < 1 || durationMs > GHOST_MAX_MS) {
    return { error: 'That ghost recording claims an unusable duration.' };
  }
  if (splitCount > GHOST_MAX_SPLITS) {
    return { error: 'That ghost recording claims too many splits.' };
  }
  const want = GHOST_HEADER_BYTES + splitCount * 4 + count * GHOST_SAMPLE_BYTES;
  if (bytes.length !== want) {
    return { error: 'That ghost recording does not match its own header.' };
  }
  /* The grid has to reach the finish, or replay near the line reads air. */
  const stepMs = 1000 / rateHz;
  if (((count - 1) * 1000) / rateHz + stepMs < durationMs) {
    return { error: 'That ghost recording ends before its lap does.' };
  }
  if (lapMs != null && Math.abs(durationMs - lapMs) > GHOST_LAP_SLACK_MS) {
    return { error: 'That ghost recording does not match the lap time beside it.' };
  }
  return { ghost: raw };
}

const LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/* The three caps on a track's branding, all of them the simulator's, from
 * LOGO_MAX_CHARS, LOGO_SLOTS and BRANDING_MAX_CHARS in its
 * src/trackbuilder/model.js. They live there because that is where an author
 * actually hits them; these copies exist so the board never holds a track
 * the tool that made it would not save. An earlier copy of the first one was
 * 280_000 rather than 256 KiB, and a logo between the two sizes was refused
 * by the builder and accepted here. Change all three together. */
const LOGO_MAX_CHARS = 256 * 1024;
const LOGO_SLOTS = 5;
const BRANDING_MAX_CHARS = 384 * 1024;

function usableLogo(value) {
  return typeof value === 'string' && value.length <= LOGO_MAX_CHARS && LOGO_RE.test(value);
}

/*
 * The sponsor logos a track carries, whichever way its document spells
 * them. Not to be confused with the plan's `marks`, which are the track's
 * own geometry: the builder calls the pictures sponsor logos and so does
 * every sentence the board shows an author.
 *
 * A schemaVersion 1 document has one `branding.logo`; a version 2 one has
 * `branding.logos`, a list of up to five { id, image, name }. Both are read,
 * because the board holds tracks published under the old spelling and they
 * have to keep working when their author republishes an unchanged copy.
 *
 * Returns { images } or { error }. The board does not repair a document: it
 * stores what it was given and the simulator is the reader that decides what
 * a gate means, so anything wrong here is refused with a sentence rather
 * than quietly dropped.
 */
function inspectBranding(document) {
  const branding = document.branding;
  if (branding == null) {
    return { images: [] };
  }
  if (!isObject(branding)) {
    return { error: 'That track\u2019s branding is not readable.' };
  }
  const raw = Array.isArray(branding.logos)
    ? branding.logos
    : (branding.logo != null && branding.logo !== '' ? [{ image: branding.logo }] : []);
  if (raw.length > LOGO_SLOTS) {
    return { error: `A track carries at most ${LOGO_SLOTS} sponsor logos.` };
  }
  const images = [];
  let spent = 0;
  for (const entry of raw) {
    const image = typeof entry === 'string' ? entry : (isObject(entry) ? entry.image : null);
    if (!usableLogo(image)) {
      return { error: 'A sponsor logo has to travel inside the track as an embedded image.' };
    }
    spent += image.length;
    images.push(image);
  }
  if (spent > BRANDING_MAX_CHARS) {
    return { error: `A track\u2019s sponsor logos share ${Math.round(BRANDING_MAX_CHARS / 1024)} kB and these come to ${Math.round(spent / 1024)} kB.` };
  }
  return { images };
}

/*
 * MIRRORS layoutFingerprint in fdfpv/src/share/listing.js. This is
 * the copy that decides whether a republished track keeps its times. The
 * hashes differ, the KEY LIST must not: field, elements, sequence.
 */
/*
 * Element types that are painted on rather than flown through, so changing
 * them cannot change a lap.
 *
 * THIS IS WHY A SPONSOR DOES NOT WIPE A LEADERBOARD. Selling a place on an
 * existing track means adding a logo to a track people have already flown,
 * and if that counted as a layout change every time on this board would be
 * cleared the moment the deal was signed. Paint has no collider and is not
 * in the flying order, so a lap flown before it was painted is the same lap.
 *
 * MIRRORS LAYOUT_SKIP in fdfpv/src/share/listing.js. Written out
 * as a literal in both, rather than derived from the simulator's element
 * library, because this repository has no element library and the two lists
 * have to be edited together on purpose. A track with no painted logos
 * hashes to exactly what it hashed to before this filter existed, which is
 * what keeps every already published track's times.
 */
const LAYOUT_SKIP = new Set(['groundLogo']);

export function layoutHash(document) {
  const payload = {
    field: document.field ?? {},
    elements: (document.elements ?? []).filter((el) => !(isObject(el) && LAYOUT_SKIP.has(el.type))),
    sequence: document.sequence ?? [],
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function hashEditKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

/* Drawn as nothing on a plan card. A waypoint pins the flying order with
 * nothing standing on the field, a label is an authoring note, and a ground
 * logo is paint: all three drew as gates once, which is how a championship
 * plan turned into a scatter of bars that are not on the track. */
const PLAN_SKIP = new Set(['label', 'waypoint', 'groundLogo']);
const PLAN_APERTURE = new Set([
  'gate', 'flaggedGate', 'doubleStack', 'flaggedDoubleStack', 'ladder', 'tower', 'diveGate',
]);

/*
 * The track's class, normalised the way the simulator's
 * src/trackbuilder/elements.js normalises it: anything that is not the word
 * 'micro' is the sixty metre field. A version 1 or 2 document has no such
 * key and is a field, which it is.
 *
 * It is derived from the stored document on every read rather than kept in
 * a column, for the same reason the plan is: there is one copy of the truth
 * and no migration to get wrong.
 */
export const TRACK_CLASSES = ['full', 'micro'];

export function trackClassOf(document) {
  return isObject(document) && document.trackClass === 'micro' ? 'micro' : 'full';
}

/*
 * WHO BUILT THE TRACK, WHICH IS NOT ALWAYS WHO PUBLISHED IT.
 *
 * A board track's `author` is the account that put it here. On a track
 * somebody built in their own living room those are the same person, and on
 * the eight RaceGOW5 rooms they are not: Skittles, AyyyKayyy, MrE, FPVBean,
 * Cumber and Hotspur and the Lego Dans designed them, and one person brought
 * all eight over. The builder writes that down in the document's `credit`
 * block, the publish has always sent it, and until now nothing on this board
 * read it back, so every one of those cards said "Built by" the wrong name.
 *
 * Derived from the stored document on every read, like the class and the
 * plan, so there is one copy of the truth and no migration. Drawn as text by
 * the page, never as markup.
 */
export function creditOf(document) {
  const c = isObject(document) && isObject(document.credit) ? document.credit : {};
  /*
   * A NAME IS A STRING, and nothing else is read as one. This used to
   * String() whatever it found, and String() of an object is
   * "[object Object]" and of an array is its elements joined with commas,
   * either of which would go on a card as if somebody had typed it. Control
   * characters go and runs of whitespace close up, so the summary the API
   * serves and the text the card draws are the same name.
   */
  const text = (v) => (typeof v === 'string'
    ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
    : '');
  return { designer: text(c.designer), series: text(c.series) };
}

/* ------------------------------------------------------------------ */
/* The card animation                                                  */
/* ------------------------------------------------------------------ */

/*
 * A TRACK'S ANIMATION, WHICH THIS BOARD STORES AND DOES NOT MAKE.
 *
 * The board renders nothing. A GIF is one lap of the track flown past the
 * gates, drawn by the simulator's own src/trackbuilder/animate.js in a real
 * WebGL context, and it arrives here as bytes the way a logo arrives inside
 * a document. What happens below is therefore not a picture being made, it
 * is a stranger's upload being bounded.
 *
 * WHY ONLY A ROOM GETS ONE, and this is the rule rather than a default the
 * caller may override. A sixty metre field has a plan worth drawing: the
 * flown line through twenty gates, read at a glance, and public/plan.js
 * already draws it from the list payload at no cost at all. A RaceGOW room
 * is five metres across with three gates in it, so its plan is an almost
 * empty rectangle with a dot in the middle, which says nothing about a
 * track whose whole difficulty is vertical. The animation is what a reader
 * needs there and the plan is what a reader needs on a field.
 *
 * It is enforced here rather than in the page, so that the rule has one
 * home. Twenty nine field tracks silently gaining a quarter of a megabyte
 * each because some future publisher uploaded one anyway is exactly the
 * thing a rule in the page would not stop. If this is ever wanted on a
 * field track, this function is the one line to change.
 */

/* Two and a half megabytes of base64, which is about 1.8 MB of GIF. The
 * card animations this was written for come in between 20 and 70 kB at 16
 * by 10, so the cap is two orders of magnitude clear of the thing it is
 * meant to allow and still small enough to refuse a video somebody renamed. */
export const MAX_GIF_BASE64_CHARS = 2_500_000;

const GIF_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/*
 * GIF87a or GIF89a, and then the logical screen descriptor's own width and
 * height, little endian, which is the only place in the file those numbers
 * live. Reading them costs ten bytes and catches the two uploads that would
 * otherwise get through: a file that is not a GIF at all, and a GIF of one
 * pixel standing in for a track.
 */
function readGifHeader(bytes) {
  if (bytes.length < 10) {
    return null;
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'GIF89a' && magic !== 'GIF87a') {
    return null;
  }
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
  };
}

/*
 * The upload, checked against the track it claims to be of.
 *
 * `document` is the stored track document, so the class rule above is read
 * off the copy of record rather than off anything the uploader said.
 */
export function inspectGif({ base64, document }) {
  if (trackClassOf(document) !== 'micro') {
    return { error: 'This board keeps an animation for a room, not for a field track.' };
  }
  const packed = String(base64 || '').replace(/^data:image\/gif;base64,/, '').trim();
  if (!packed) {
    return { error: 'That upload carried no animation.' };
  }
  if (packed.length > MAX_GIF_BASE64_CHARS) {
    return { error: 'That animation is too large for this board.' };
  }
  if (!GIF_BASE64_RE.test(packed)) {
    return { error: 'That animation is not base64.' };
  }
  let bytes;
  try {
    bytes = Buffer.from(packed, 'base64');
  } catch (e) {
    return { error: 'That animation is not base64.' };
  }
  const head = readGifHeader(bytes);
  if (!head) {
    return { error: 'That upload is not a GIF.' };
  }
  /* Sixty four is under any framing this produces and over any tracking
   * pixel; 4096 is over any card and under a frame buffer somebody is
   * trying to store here. */
  if (head.width < 64 || head.height < 64 || head.width > 4096 || head.height > 4096) {
    return { error: 'That animation is not a usable size.' };
  }
  return { bytes, width: head.width, height: head.height };
}

export function planFromDocument(document) {
  const field = isObject(document.field) ? document.field : {};
  const byId = new Map();
  const sequenced = new Set();
  for (const step of document.sequence || []) {
    if (isObject(step) && typeof step.elementId === 'string' && step.elementId) {
      sequenced.add(step.elementId);
    }
  }
  const marks = [];
  for (const el of document.elements || []) {
    if (!isObject(el) || !isObject(el.position)) {
      continue;
    }
    if (typeof el.id === 'string' && el.id) {
      byId.set(el.id, el);
    }
    const type = String(el.type || 'gate');
    /* A waypoint is a flying-order pin with nothing standing on the
     * field. Drawing it as a gate was how championship plans turned into
     * a scatter of bars that are not on the track. Labels are notes. */
    if (PLAN_SKIP.has(type)) {
      continue;
    }
    /*
     * The three numbers the drawer cannot guess. It used to reconstruct
     * every size from a hard copy of the builder's type DEFAULTS, but each
     * of these is editable per element: a ladder taken to five levels drew
     * three arcs, a twenty metre barrier drew as four, and the gate count
     * printed on the same card told the truth the picture did not.
     * Undefined when the element does not carry one, so an older stored
     * plan still falls back to the defaults.
     */
    const levels = Number(el.dims?.levels);
    const barrierW = Number(el.dims?.width);
    const barrierD = Number(el.dims?.depth);
    /*
     * THE GATE'S OWN OPENING, which is the fourth number of that family and
     * the one that was missing. A gate is 1.524 m on a MultiGP field and
     * 0.711 on a RaceGOW one, and an author can type any width into either,
     * so a drawer that assumes one draws every track that is not that one
     * wrongly: on a 5 by 6 m room it drew every gate a third of the width of
     * the room.
     */
    const clearW = Number(el.dims?.clearW);
    /* And the start line's length, which is a row rather than one number:
     * how many stands, how far apart, and how big one is. Four at 1.5 m is a
     * MultiGP grid; a RaceGOW start is a single 100 mm stand, because there
     * are no heats and every pilot flies alone at home. */
    const pads = Number(el.dims?.pads);
    const spacing = Number(el.dims?.spacing);
    const padSize = Number(el.dims?.padSize);
    marks.push({
      type,
      x: Number(el.position.x) || 0,
      y: Number(el.position.y) || 0,
      yaw: Number(el.yaw) || 0,
      seq: sequenced.has(el.id),
      levels: Number.isFinite(levels) && levels > 0 ? levels : undefined,
      w: Number.isFinite(barrierW) && barrierW > 0 ? barrierW : undefined,
      d: Number.isFinite(barrierD) && barrierD > 0 ? barrierD : undefined,
      clearW: Number.isFinite(clearW) && clearW > 0 ? clearW : undefined,
      pads: Number.isFinite(pads) && pads > 0 ? pads : undefined,
      spacing: Number.isFinite(spacing) && spacing >= 0 ? spacing : undefined,
      padSize: Number.isFinite(padSize) && padSize > 0 ? padSize : undefined,
    });
  }
  const path = [];
  const numbers = [];
  const stacked = new Map();
  let n = 0;
  for (const step of document.sequence || []) {
    if (!isObject(step)) {
      continue;
    }
    const el = byId.get(step.elementId);
    if (!el || !isObject(el.position)) {
      continue;
    }
    const x = Number(el.position.x) || 0;
    const y = Number(el.position.y) || 0;
    const last = path[path.length - 1];
    if (!last || last.x !== x || last.y !== y) {
      path.push({ x, y });
    }
    const type = String(el.type || '');
    /*
     * One badge per FLYING ORDER ENTRY, not per element. Numbering by
     * element id gave a stacked gate flown three times a single badge and
     * left the plan's last number short of the gate count printed on the
     * same card, and short of what the simulator's own OSD counts down.
     * `stack` is how many badges already sit on this exact spot, so the
     * drawer can step them apart the way the builder does.
     */
    if (PLAN_APERTURE.has(type) && el.id) {
      const spot = `${x},${y}`;
      const stack = stacked.get(spot) || 0;
      stacked.set(spot, stack + 1);
      n += 1;
      numbers.push({ n, x, y, stack });
    }
  }
  const small = trackClassOf(document) === 'micro';
  return {
    /* The class travels with the plan, because the drawer has three sizes it
     * cannot read off a mark: the marker symbol, and the two fallbacks a
     * plan with no dimensions falls through to. public/plan.js reads it. */
    trackClass: small ? 'micro' : 'full',
    /* A RaceGOW room when the document forgot to say, not a MultiGP field.
     * Neither producer emits a plan without a field, so this is the last
     * line rather than the usual one. */
    width: Number(field.width) || (small ? 5 : 60),
    depth: Number(field.depth) || (small ? 6 : 40),
    marks,
    path,
    numbers,
  };
}

/*
 * How many GATES a track has, which is not how long its flying order is.
 * A waypoint is an order pin with nothing standing on the field, and a
 * marker only scores when it carries clearance, so counting steps put a
 * number on the card that neither the plan's badges nor the simulator's own
 * count agreed with. Mirrors the station rules in the simulator's
 * src/game/trackdoc.js.
 */
function gateCount(document) {
  const byId = new Map();
  for (const el of document.elements || []) {
    if (isObject(el) && typeof el.id === 'string' && el.id) {
      byId.set(el.id, el);
    }
  }
  let n = 0;
  for (const step of document.sequence || []) {
    if (!isObject(step)) {
      continue;
    }
    const el = byId.get(step.elementId);
    if (!el) {
      continue;
    }
    const type = String(el.type || '');
    if (PLAN_APERTURE.has(type)) {
      n += 1;
    } else if (Number(el.dims && el.dims.clearance) >= 0.05) {
      n += 1;
    }
  }
  return n;
}

export function inspectDocument(raw) {
  if (typeof raw === 'string' && raw.length > MAX_DOCUMENT_CHARS) {
    return { error: 'That track is too large to publish.' };
  }
  const packed = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (packed.length > MAX_DOCUMENT_CHARS) {
    return { error: 'That track is too large to publish.' };
  }
  let document = raw;
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw);
    } catch (e) {
      return { error: 'That track is not valid JSON.' };
    }
  }
  if (!isObject(document)) {
    return { error: 'That file is not a track document.' };
  }
  /*
   * 1, 2 and 3.
   *
   * Version 2 is where a track grew from one logo to five, which is a
   * branding change and nothing else: field, elements and sequence read
   * identically, so a version 1 track already on this board keeps its times
   * when its author republishes it from a newer builder.
   *
   * Version 3 is the track CLASS. A version 3 document carries
   * `trackClass`, which is 'full' for the sixty metre field every track on
   * this board has been until now, or 'micro' for a RaceGOW room: a 65 mm
   * whoop, 28 inch gates out of 26.7 mm PVC, and a whole track inside about
   * 1.4 by 2.1 m. Nothing else about the document moved, so a version 1 or
   * 2 track keeps its times across a republish from a builder that writes 3,
   * and every stored track reads as 'full', which is what it is.
   */
  if (![1, 2, 3].includes(document.schemaVersion)) {
    return { error: 'This board accepts schemaVersion 1, 2 and 3 tracks.' };
  }
  const id = String(document.id || '');
  if (!TRACK_ID_RE.test(id)) {
    return { error: 'That track has no usable id.' };
  }
  const name = String(document.name || '').trim() || 'Untitled track';
  /* The message named the field and then never looked at it, so a track
   * with no field at all passed here and the board drew it on the 60 by 40
   * default while the simulator flew it on whatever the document said. */
  if (!isObject(document.field)) {
    return { error: 'That track is missing its field.' };
  }
  if (!Array.isArray(document.elements) || !Array.isArray(document.sequence)) {
    return { error: 'That track is missing its elements or its flying order.' };
  }
  if (document.sequence.length < 1) {
    return { error: 'A published track needs at least one gate in the flying order.' };
  }
  const elementIds = new Set();
  for (const el of document.elements) {
    if (isObject(el) && typeof el.id === 'string' && el.id) {
      elementIds.add(el.id);
    }
  }
  for (const step of document.sequence) {
    if (!isObject(step) || !elementIds.has(step.elementId)) {
      return { error: 'That flying order names a gate that is not in the track.' };
    }
  }
  const branding = inspectBranding(document);
  if (branding.error) {
    return { error: branding.error };
  }
  return {
    document,
    id,
    name: name.slice(0, 80),
    /* Whether the board's listing shows this track as branded. One logo or
     * five, the card says the same thing, so the flag stays a boolean. */
    hasLogo: branding.images.length > 0,
    logoCount: branding.images.length,
    gates: gateCount(document),
    elements: document.elements.length,
    trackClass: trackClassOf(document),
    layoutHash: layoutHash(document),
    plan: planFromDocument(document),
  };
}

/* ------------------------------------------------------------------ */
/* Bug tickets                                                         */
/* ------------------------------------------------------------------ */

export const BUG_ID_RE = /^bug-[0-9a-f]{8}$/;
export const BUG_KINDS = ['crash', 'blocking', 'wrong', 'visual', 'feel', 'other'];
export const BUG_STATUSES = ['open', 'in_progress', 'fixed', 'wontfix', 'duplicate'];

const BUG_TITLE_MIN = 8;
const BUG_TITLE_MAX = 120;
const BUG_WHAT_MIN = 20;
const BUG_WHAT_MAX = 4000;
const BUG_NOTE_MAX = 2000;
const BUG_RESOLUTION_MAX = 4000;
const BUG_CONTEXT_CHARS = 8000;
/*
 * 32, up from 24. The simulator's feel reports already attach twenty top
 * level keys (feelSnapshot in its src/ui/ui.js spreads bugSnapshot and adds
 * five of its own), so 24 left four keys of headroom before feedback
 * started bouncing with "too many fields", and the client has no check of
 * its own. The character cap above is still the real bound on size; this
 * one only exists to stop a pathological object of thousands of tiny keys.
 */
const BUG_CONTEXT_KEYS = 32;

function inspectContext(raw) {
  if (raw == null || raw === '') {
    return { context: {} };
  }
  if (!isObject(raw)) {
    return { error: 'Context has to be a JSON object.' };
  }
  let packed;
  try {
    packed = JSON.stringify(raw);
  } catch (e) {
    return { error: 'Context is not usable JSON.' };
  }
  if (packed.length > BUG_CONTEXT_CHARS) {
    return { error: 'That context is too large.' };
  }
  if (Object.keys(raw).length > BUG_CONTEXT_KEYS) {
    return { error: 'That context has too many fields.' };
  }
  return { context: JSON.parse(packed) };
}

/*
 * A tester's report, as the board will store it. Kind, title and what
 * happened are required. The name can be blank, in which case it is stored
 * as Anonymous. Context is whatever the simulator attached: map, GPU,
 * browser. Agents read that so they do not have to ask.
 */
export function inspectBugCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  const kind = String(body.kind || 'other');
  if (!BUG_KINDS.includes(kind)) {
    return { error: 'Pick a kind: crash, blocking, wrong, visual, feel or other.' };
  }
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  if (title.length < BUG_TITLE_MIN || title.length > BUG_TITLE_MAX) {
    return { error: 'A title needs eight to one hundred and twenty characters.' };
  }
  const what = String(body.what ?? '').replace(/\r\n/g, '\n').trim();
  if (what.length < BUG_WHAT_MIN || what.length > BUG_WHAT_MAX) {
    return { error: 'Say what happened, twenty to four thousand characters.' };
  }
  const expected = String(body.expected ?? '').replace(/\r\n/g, '\n').trim();
  if (expected.length > BUG_NOTE_MAX) {
    return { error: 'Expected result is too long.' };
  }
  const steps = String(body.steps ?? '').replace(/\r\n/g, '\n').trim();
  if (steps.length > BUG_NOTE_MAX) {
    return { error: 'Steps are too long.' };
  }
  const named = normaliseName(body.reporter);
  const rawName = String(body.reporter ?? '').trim();
  if (rawName && !named) {
    return { error: 'A name is two to twenty four letters, numbers, spaces, dots, underscores or hyphens, or leave it blank.' };
  }
  const ctx = inspectContext(body.context);
  if (ctx.error) {
    return ctx;
  }
  return {
    kind,
    title,
    what,
    expected,
    steps,
    reporter: named || 'Anonymous',
    context: ctx.context,
  };
}

export function inspectBugPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  const out = {};
  if (body.status != null) {
    const status = String(body.status);
    if (!BUG_STATUSES.includes(status)) {
      return { error: 'Status is open, in_progress, fixed, wontfix or duplicate.' };
    }
    out.status = status;
  }
  if (body.resolution != null) {
    const resolution = String(body.resolution).replace(/\r\n/g, '\n').trim();
    if (resolution.length > BUG_RESOLUTION_MAX) {
      return { error: 'That resolution is too long.' };
    }
    out.resolution = resolution;
  }
  if (out.status == null && out.resolution == null) {
    return { error: 'Send a status or a resolution.' };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

/*
 * THE TAG VOCABULARY, AND WHY IT IS CLOSED.
 *
 * A tag exists so that a visitor looking for one kind of track can stop
 * looking at the other kinds. That only works if the same idea is spelled
 * the same way by everybody, and free text does not do that: a board with
 * "race", "racing", "Race Track" and "racetrack" on it has four tags and no
 * filter. So the board decides the list and the builder offers exactly it.
 *
 * The three the owner named are the three kinds of thing people actually
 * build, and they are about the AUTHOR'S INTENT rather than about the
 * geometry, because intent is the thing a visitor is choosing between and
 * the geometry is already on the card as a gate count and a field size.
 *
 *   race        built to be raced against a clock
 *   skills      built to practise one thing until it is easy
 *   experiment  built to find out whether something works
 *
 * The rest are the shapes that kept turning up in the tracks already
 * published and that the three above cannot say:
 *
 *   beginner, technical   how hard, which is the first thing anybody asks
 *   micro, big            how much room it wants, which decides whether it
 *                         is flyable at all on a small screen at speed.
 *                         The `micro` id is printed as "Small field", and
 *                         that is a RENAME rather than a new tag: it means
 *                         a five inch track with a small footprint, and it
 *                         has meant that since before there was a micro
 *                         CLASS. On a page that now also carries a "65 mm
 *                         whoop" filter, a tag labelled "Micro" is two
 *                         different things one word apart. The id cannot
 *                         move without stranding the tracks that carry it;
 *                         the label is what the board prints and it can.
 *   freestyle             gates as furniture rather than as a course
 *   showcase              built to be looked at
 *
 * `label` is what the board and the builder print. `id` is what travels and
 * never changes: renaming a label must never orphan a published track.
 * Adding an id is additive and needs no migration; REMOVING one would strand
 * tracks that carry it, so a retired tag keeps its row and loses its offer.
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

const TAG_IDS = new Set(TAGS.map((t) => t.id));

/*
 * At most this many on one track. Five is the point past which a tag stops
 * narrowing anything: a track wearing every tag answers every filter, which
 * is the same as wearing none, and it is how an author games a list.
 */
export const TAGS_MAX = 5;

/*
 * Clean a tag list, or refuse it.
 *
 * Returns { tags } or { error }. An absent list is an empty list and is
 * fine: tags are optional and every track published before they existed
 * has none. An unknown id is refused rather than dropped, because a builder
 * that offered it and a board that ignored it would disagree silently and
 * the author would never learn their tag did not stick.
 */
export function inspectTags(raw) {
  if (raw == null) {
    return { tags: [] };
  }
  if (!Array.isArray(raw)) {
    return { error: 'Tags are a list.' };
  }
  if (raw.length > TAGS_MAX) {
    return { error: `A track wears at most ${TAGS_MAX} tags.` };
  }
  const out = [];
  for (const entry of raw) {
    const id = String(entry ?? '').trim().toLowerCase();
    if (!TAG_IDS.has(id)) {
      return { error: `There is no tag called "${String(entry ?? '').slice(0, 24)}".` };
    }
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  /* Stored in the board's own order rather than the order they were ticked,
   * so two tracks wearing the same tags carry the same list and a card
   * cannot read differently from one publish to the next. */
  return { tags: TAGS.filter((t) => out.includes(t.id)).map((t) => t.id) };
}

/* ------------------------------------------------------------------ */
/* Freestyle runs                                                      */
/* ------------------------------------------------------------------ */

export const RUN_ID_RE = /^run-[0-9a-f]{8}$/;

/*
 * WHAT THE BOARD CAN AND CANNOT KNOW ABOUT A SCORE.
 *
 * It cannot recompute one. Doing that would mean importing the simulator's
 * recogniser, its catalogue and its plant, and this file imports nothing
 * from the simulator on purpose: the board is a place to put things, not a
 * second implementation of the game. So every number below is CLAIMED by
 * the page that posted it, and nothing here should be written or read as if
 * it had been verified.
 *
 * What it can do is bound the claim and check it against itself, which is
 * exactly what inspectGhost does for a recorded lap. A run that says it
 * landed four tricks and scored a billion is refused, not because the board
 * knows what those four tricks were, but because no four tricks can be
 * worth that under rules the board can state in one line. That catches the
 * careless and the curious. It does not catch somebody determined, and the
 * README says so rather than implying otherwise.
 */

/* The map a run was flown on. One today, and it is a list rather than a
 * constant so the second one is a line here and not a migration. */
export const RUN_MAPS = ['city'];

/*
 * The two physics models the simulator offers, which is not a cosmetic
 * setting: arcade turns off propwash, gyro noise and build asymmetry, so an
 * arcade run and an expert run are not the same sport. The board records
 * which and lets a reader filter, rather than quietly ranking them together
 * and letting somebody find out later.
 */
export const RUN_STYLES = ['expert', 'arcade'];

/* A run is two minutes of simulated time. The slack is generous because the
 * clock stops on the trick that ended the run, not on the millisecond, and
 * because a future map may want a different heat length. */
const RUN_MS_MIN = 1_000;
const RUN_MS_MAX = 900_000;
const RUN_TRICKS_MAX = 600;
const SIGNATURE_MAX = 40;

/*
 * The most a run of `tricks` tricks could possibly be worth, derived rather
 * than picked.
 *
 * The dearest trick in the simulator's catalogue is 850 points. The streak
 * multiplier grows by the previous trick's raw score over ten thousand, so
 * after n tricks it is at most 1 + n * 850 / 10000. The combo multiplier is
 * capped at twelve. Nothing else in the scorer multiplies. So no single
 * trick can be worth more than 850 * (1 + n * 0.085) * 12, and no run of n
 * tricks more than n times that.
 *
 * This is a loose bound and it is meant to be: its job is to refuse a
 * number that could not have come from the game at all, not to guess what a
 * good run looks like. Every real run measured while this was written came
 * in three orders of magnitude under it.
 */
export function maxPlausibleScore(tricks) {
  const n = tricks > 0 ? tricks : 1;
  return Math.ceil(n * 850 * (1 + n * 0.085) * 12);
}

function counted(raw, max) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) {
    return null;
  }
  return Math.round(raw);
}

/*
 * Check a posted run. Returns the row the store should keep, or { error }.
 *
 * Every field is checked, including the ones only the display reads, because
 * a field that is stored unchecked is a field that reaches every visitor's
 * browser unchecked.
 */
export function inspectRun(body) {
  if (!isObject(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  const name = normaliseName(body.name);
  if (!name) {
    return { error: 'A pilot name is 2 to 24 letters, digits, dots, dashes or spaces.' };
  }
  const map = String(body.map ?? '');
  if (!RUN_MAPS.includes(map)) {
    return { error: 'That is not a map this board keeps scores for.' };
  }
  const style = String(body.style ?? '');
  if (!RUN_STYLES.includes(style)) {
    return { error: 'A run is flown on the expert or the arcade physics model.' };
  }
  const durationMs = counted(body.durationMs, RUN_MS_MAX);
  if (durationMs == null || durationMs < RUN_MS_MIN) {
    return { error: 'That run is not long enough to be a run.' };
  }
  const tricks = counted(body.tricks, RUN_TRICKS_MAX);
  if (tricks == null || tricks < 1) {
    return { error: 'A run with no tricks in it is not a score.' };
  }
  const unique = counted(body.unique, RUN_TRICKS_MAX);
  if (unique == null || unique < 1 || unique > tricks) {
    return { error: 'A run cannot have more distinct tricks than tricks.' };
  }
  const ceiling = maxPlausibleScore(tricks);
  const score = counted(body.score, ceiling);
  if (score == null || score < 1) {
    return { error: 'That score could not have come from that many tricks.' };
  }
  const bestCombo = counted(body.bestCombo, ceiling);
  if (bestCombo == null || bestCombo > score) {
    return { error: 'The best chain in a run cannot be worth more than the run.' };
  }
  const bestTrick = counted(body.bestTrick, ceiling);
  if (bestTrick == null || bestTrick > score) {
    return { error: 'One trick in a run cannot be worth more than the run.' };
  }
  const crashes = counted(body.crashes, RUN_TRICKS_MAX);
  if (crashes == null) {
    return { error: 'That crash count is not a count.' };
  }
  /* The one trick the run is remembered by. Free text, because it is a name
   * out of a catalogue this file deliberately does not hold, so it is
   * bounded and stripped rather than checked against a list. */
  const signature = String(body.signature ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, SIGNATURE_MAX);
  return {
    run: {
      name, map, style, score, durationMs, tricks, unique,
      bestCombo, bestTrick, crashes, signature,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Site statistics                                                     */
/* ------------------------------------------------------------------ */

/*
 * WHAT THE BOARD WILL BELIEVE ABOUT A VISIT, AND WHAT IT REFUSES TO HOLD.
 *
 * The statistics page counts sessions, laps, countries and returning
 * pilots. Every one of those numbers is a COUNTER: the store adds to a
 * daily total and keeps nothing that describes one browser. This function
 * is the gate in front of that, and its job is smaller than it looks,
 * because most of the privacy work is in what the wire format does not
 * carry rather than in what is checked here.
 *
 * NOTHING IDENTIFYING IS ACCEPTED, so nothing identifying can be stored by
 * mistake later. There is no field for an address, a user agent, a screen
 * size, a referrer, a pilot name or a track id, and an event carrying one
 * is not cleaned of it: the extra key is simply never read. The one string
 * that travels per tab, `tab`, is a random value the browser makes fresh on
 * every page load, is held in memory by the server for three minutes to
 * answer "how many are flying now", and is never written to the store.
 *
 * EVERY DIMENSION IS A CLOSED LIST. A source folds to a sponsor slug or to
 * `other`, a country to two capitals or to `ZZ`, and craft, map, input and
 * surface are refused outright if they are not on the lists below. That is
 * what stops a stranger with curl growing the dims table: the number of
 * rows it can ever hold is the product of these lists and the days.
 *
 * THE DELTAS ARE SMALL AND BOUNDED. A flush covers at most a minute of
 * flying, so thirty laps, ninety seconds and sixty crashes are all well
 * past anything a minute can hold and far under anything worth inflating a
 * public number with. A claim outside them is refused rather than clamped:
 * clamping would store a number the sender did not send.
 */

export const STATS_KINDS = ['visit', 'session', 'flush'];

/* Which page sent it. The landing page is on the list before it sends
 * anything, because the board ships before the pages that talk to it and a
 * surface the board refuses is a deploy order this repository already has
 * a rule about. See DEPLOY.md in the simulator's repository. */
export const STATS_SURFACES = ['sim', 'builder', 'board', 'landing'];

/* The aircraft, spelled as the simulator's own settings spell it, so the
 * page can print "Five inch" and "65 mm whoop" from a key that is not a
 * translation of anything. */
export const STATS_CRAFT = ['5inch', 'whoop65'];

/* The maps the shell can be standing in. `custom` is the track, built or
 * fetched; `city` is freestyle. Anything else folds, rather than being
 * refused, because a map added to the simulator must not start refusing
 * every session an older board sees. */
export const STATS_MAPS = ['custom', 'city'];

/* How the pilot is flying. The simulator knows a fourth thing, a radio in
 * joystick mode, and reports it as `gamepad`, because to this page a radio
 * and a controller are the same answer to "did they use sticks". */
export const STATS_INPUTS = ['gamepad', 'keyboard', 'touch'];

export const STATS_OTHER = 'other';
export const STATS_COUNTRY_UNKNOWN = 'ZZ';

/* One flush covers at most a minute. See the header. */
const FLUSH_LAPS_MAX = 30;
const FLUSH_FLIGHT_S_MAX = 90;
const FLUSH_CRASHES_MAX = 60;

/*
 * The per tab handle, and the ONLY string in this format that is unique to
 * a browser. It is `crypto.randomUUID()` from the page, it changes on every
 * page load, the server holds it in memory for three minutes and no store
 * ever sees it. The pattern is loose on purpose: it has to accept a UUID
 * and it has no reason to insist on one, because nothing is derived from
 * its shape. What it does insist on is a bound, so this cannot become a
 * place to post a kilobyte.
 */
const STATS_TAB_RE = /^[A-Za-z0-9-]{8,36}$/;

/*
 * Two capitals from the edge, or ZZ.
 *
 * The board never looks an address up and never stores one. Cloudflare puts
 * the country on the request in edge/router.js in the simulator's
 * repository, and it is believed only when BOARD_TRUST_PROXY says something
 * in front of this process sets it, exactly like the forwarded host. On a
 * checkout, and on the bare Render address, every row is ZZ and the page
 * prints Unknown, which is honest and needs no table.
 *
 * XX and T1 are Cloudflare's own answers for "no country" and "Tor exit",
 * and both mean the same thing to this page as an absent header.
 */
export function normaliseCountry(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') {
    return STATS_COUNTRY_UNKNOWN;
  }
  return code;
}

/* A word from a closed list, or `other`. Used where a new value in a newer
 * simulator must not start refusing events on an older board. */
function foldedTo(raw, list) {
  const word = String(raw ?? '').trim();
  return list.includes(word) ? word : STATS_OTHER;
}

/* A bounded whole number, or null. Absent counts as nought, because a flush
 * with nothing to report is the heartbeat that answers "flying now" and
 * refusing it would cost that number. */
function delta(raw, max) {
  if (raw == null) {
    return 0;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) {
    return null;
  }
  return Math.round(raw);
}

/*
 * Check one posted event. Returns { event } with exactly the fields the
 * store will read, or { error } with a sentence.
 *
 * `sourceKey` is passed in rather than imported so this file keeps its one
 * import and the sponsor list has exactly one home. The server hands it
 * src/sponsors.js's fold; the tests hand it whichever fold they are
 * checking against.
 */
export function inspectStatsEvent(body, sourceKey) {
  if (!isObject(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  if (body.v !== 1) {
    return { error: 'That is not a version of this format the board reads.' };
  }
  const kind = String(body.kind ?? '');
  if (!STATS_KINDS.includes(kind)) {
    return { error: 'That is not a kind of event this board counts.' };
  }
  const fold = typeof sourceKey === 'function' ? sourceKey : (x) => (x == null ? 'direct' : STATS_OTHER);
  const source = fold(body.source);
  if (kind === 'visit') {
    const surface = String(body.surface ?? '');
    if (!STATS_SURFACES.includes(surface)) {
      return { error: 'That is not a page this board counts visits from.' };
    }
    /* The browser answers the question rather than sending the date it
     * answered it from. A date would be a fingerprint; a boolean is not. */
    if (typeof body.returning !== 'boolean') {
      return { error: 'A visit says whether this browser has been here before.' };
    }
    return { event: { kind, surface, returning: body.returning, source } };
  }
  if (kind === 'session') {
    const craft = String(body.craft ?? '');
    if (!STATS_CRAFT.includes(craft)) {
      return { error: 'That is not an aircraft this board counts.' };
    }
    return {
      event: {
        kind,
        craft,
        map: foldedTo(body.map, STATS_MAPS),
        input: foldedTo(body.input, STATS_INPUTS),
        source,
      },
    };
  }
  /* A flush. */
  const tab = String(body.tab ?? '');
  if (!STATS_TAB_RE.test(tab)) {
    return { error: 'That is not a usable tab handle.' };
  }
  const craft = String(body.craft ?? '');
  if (!STATS_CRAFT.includes(craft)) {
    return { error: 'That is not an aircraft this board counts.' };
  }
  const laps = delta(body.laps, FLUSH_LAPS_MAX);
  const flightS = delta(body.flightS, FLUSH_FLIGHT_S_MAX);
  const crashes = delta(body.crashes, FLUSH_CRASHES_MAX);
  if (laps == null || flightS == null || crashes == null) {
    return { error: 'That is more than a minute of flying can hold.' };
  }
  return {
    event: {
      kind,
      tab,
      craft,
      map: foldedTo(body.map, STATS_MAPS),
      laps,
      flightS,
      crashes,
      source,
    },
  };
}

/*
 * The UTC day a write belongs to, as the text the store keys on.
 *
 * The SERVER's day, never the client's. A browser's clock is wrong often
 * enough that letting it name the day would put laps in tomorrow, and it
 * would be one more thing an event could claim. UTC, so that the day
 * boundary does not move when a host changes region, which is a thing
 * Render deploys do.
 */
export function statsDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/*
 * The pilot key and the signature a posted time carries, as the simulator's
 * src/share/identity.js makes them: the raw 65 byte P-256 public key and the
 * 64 byte signature, both base64. Only the shape is checked here; whether
 * the signature holds is the identity module's business, on the server.
 */
const KEY_B64_RE = /^[A-Za-z0-9+/]{87}=$/;
const SIG_B64_RE = /^[A-Za-z0-9+/]{86}==$/;

export function inspectAuth(body) {
  const key = typeof body.key === 'string' ? body.key : '';
  const sig = typeof body.sig === 'string' ? body.sig : '';
  if (!key && !sig) {
    return { error: 'A time on the board is signed by the pilot key the simulator keeps. Post from there.' };
  }
  if (!KEY_B64_RE.test(key)) {
    return { error: 'That pilot key is not usable.' };
  }
  if (!SIG_B64_RE.test(sig)) {
    return { error: 'That signature is not usable.' };
  }
  return { key, sig };
}
