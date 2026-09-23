/*
 * selftest.js: the board's own checks. Names, documents, the file store,
 * and a live HTTP pass against the server.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  inspectBugCreate, inspectBugPatch, inspectDocument, inspectGhost, layoutHash, normaliseLapMs, normaliseName,
  creditOf, normaliseThreeMs, planFromDocument, trackClassOf,
  inspectStatsEvent, normaliseCountry, statsDay,
} from './validate.js';
import { sourceKey } from './sponsors.js';
import { openStore, rowToSummary, summaryOf } from './store.js';
import { guessSimOrigin, landingOrigin, isLoopback } from '../public/origins.js';
import { syntheticLapBytes } from '../vendor/fdfpv/tests/lib/synthlap.js';

/*
 * Documents with two gates, for the routes that post times. A course of one
 * gate is a lap every millisecond by the detector's own rules (the gate is
 * both the start and the next gate, and the craft is still in its slab), so
 * a lap that the board can measure needs somewhere to go in between.
 */
function lapDoc(id = 'trk-1a2b3c4d', extra = {}) {
  const gate = (gid, x) => ({
    id: gid, type: 'gate', name: 'Gate', position: { x, y: 8, z: 0 }, yaw: 0, pitch: 0, yawOverridden: false,
    dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
  });
  return sampleDoc(id, {
    ...extra,
    elements: [gate('el-1', 10), gate('el-2', 30)],
    sequence: [
      { id: 'seq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 },
      { id: 'seq-2', elementId: 'el-2', apertureIndex: 0, entry: 1 },
    ],
  });
}

function lapRoom(id = 'trk-2b3c4d5e') {
  const room = roomDoc(id);
  room.elements.push({
    id: 'el-3', type: 'gate', position: { x: 2, y: 0.6, z: 0 }, yaw: 0,
    dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 },
  });
  room.sequence.push({ id: 'seq-2', elementId: 'el-3', apertureIndex: 0, entry: 1 });
  return room;
}

/* A lap the board must accept: flown through every gate of the document by
 * the simulator's own test helper, as the base64 the simulator would post. */
function honestLap(document, opts = {}) {
  const lap = syntheticLapBytes(document, opts);
  return { ghost: Buffer.from(lap.bytes).toString('base64'), lapMs: lap.lapMs, durationMs: lap.durationMs };
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  pass  ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
}

/*
 * A RaceGOW room: a 5 by 6 m field, a 28 inch gate out of 26.7 mm PVC and a
 * single 100 mm start stand, because there are no heats and every pilot
 * flies alone at home. It is the only kind of track this board keeps a card
 * animation for, so both halves of this file want one and both want the
 * same one.
 */
/*
 * A structurally valid, and entirely empty, 64 by 64 GIF89a: the signature,
 * the logical screen descriptor, and the trailer. inspectGif reads the first
 * ten bytes and the byte count, so this exercises everything the board does
 * with an upload without a hundred kilobytes of rendered track in the source
 * of a test file. The real ones come out of the simulator's animate.js.
 */
const GIF_64 = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([64, 0, 64, 0, 0x00, 0x00, 0x00]),
  Buffer.from([0x3b]),
]);

/* The token the http half starts its server with, so both halves of the
 * admin path are exercised: it opens the door, and an unset one has no
 * door at all. */
const ADMIN_TOKEN = 'selftest-admin-token';

/*
 * THE ADMIN THE HTTP HALF SIGNS IN AS, AND WHY IT IS NOT THE REAL ONE.
 *
 * The board ships with one address on its whitelist and the password behind
 * an scrypt hash, so the word itself is not in this repository. Writing it
 * into a test file would put it back, in plaintext, in the one file
 * everybody reads. So the http half starts its server with BOARD_ADMINS set
 * to this instead: a made up address, a made up password, and the whole
 * login path exercised end to end against them.
 *
 * What that leaves uncovered is whether the SHIPPED hash matches the
 * password somebody was given for it, which no test in a public repository
 * can check without publishing that password. Set BOARD_SELFTEST_PASSWORD
 * to check it on a machine where knowing it is fine; the unit half below
 * uses it when it is there and says so when it is not.
 *
 * `plain:` is also the one thing in src/admin.js that nothing else would
 * exercise, so this doubles as its check.
 */
const ADMIN_EMAIL = 'boardkeeper@example.com';
const ADMIN_PASSWORD = 'selftest-password-42';

function roomDoc(id = 'trk-2b3c4d5e') {
  const room = sampleDoc(id, {
    elements: [
      {
        id: 'el-1',
        type: 'startPads',
        position: { x: 0, y: 1.5, z: 0 },
        yaw: 0,
        dims: { pads: 1, spacing: 0.3, padSize: 0.1 },
      },
      {
        id: 'el-2',
        type: 'gate',
        position: { x: 0, y: 0.6, z: 0 },
        yaw: 0,
        dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 },
      },
    ],
    sequence: [{ id: 'seq-1', elementId: 'el-2', apertureIndex: 0, entry: 1 }],
  });
  room.schemaVersion = 3;
  room.trackClass = 'micro';
  room.field = { width: 5, depth: 6, gridSize: 0.0254 };
  return room;
}

function sampleDoc(id = 'trk-1a2b3c4d', extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: extra.name || 'Ladder Loop',
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 0.4, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: extra.logos
      ? { logos: extra.logos }
      : {
        logo: extra.logo === undefined ? null : extra.logo,
        logoName: extra.logoName || '',
      },
    elements: extra.elements || [
      {
        id: 'el-1',
        type: 'gate',
        name: 'Gate',
        position: { x: 10, y: 8, z: 0 },
        yaw: 0,
        pitch: 0,
        yawOverridden: false,
        dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
      },
    ],
    sequence: extra.sequence || [{ id: 'seq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 }],
  };
}

/*
 * A well formed ghost blob, built by hand. MIRRORS the wire format in the
 * simulator's src/share/ghostdata.js the same way inspectGhost does: header,
 * splits, then 20 byte samples. The overrides exist to build the malformed
 * blobs the inspector must refuse.
 */
function makeGhostB64(durationMs, {
  rateHz = 30, splits = null, magic = 'FPVGHST1', version = 1, trimBytes = 0,
} = {}) {
  const count = Math.floor((durationMs * rateHz) / 1000) + 2;
  const splitList = splits ?? [durationMs];
  const bytes = Buffer.alloc(32 + splitList.length * 4 + count * 20);
  bytes.write(magic, 0, 'latin1');
  bytes.writeUInt32LE(version, 8);
  bytes.writeUInt32LE(rateHz, 12);
  bytes.writeUInt32LE(count, 16);
  bytes.writeUInt32LE(durationMs, 20);
  bytes.writeUInt32LE(splitList.length, 24);
  let at = 32;
  for (const s of splitList) {
    bytes.writeUInt32LE(s, at);
    at += 4;
  }
  for (let i = 0; i < count; i += 1) {
    bytes.writeFloatLE(i * 0.4, at);
    bytes.writeFloatLE(3, at + 4);
    bytes.writeFloatLE(0, at + 8);
    bytes.writeInt16LE(0, at + 12);
    bytes.writeInt16LE(0, at + 14);
    bytes.writeInt16LE(0, at + 16);
    bytes.writeInt16LE(32767, at + 18);
    at += 20;
  }
  return bytes.subarray(0, bytes.length - trimBytes).toString('base64');
}

async function testValidate() {
  console.log('validate');
  check('accepts a real name', normaliseName('Ada Rook') === 'Ada Rook');
  check('rejects a one letter name', normaliseName('A') == null);
  check('rejects a symbol name', normaliseName('Ada!') == null);
  check('accepts a lap', normaliseLapMs(12345) === 12345);
  check('rejects a zero lap', normaliseLapMs(0) == null);
  check('rejects a boolean lap', normaliseLapMs(true) == null);
  check('rejects an array lap', normaliseLapMs([1234]) == null);
  const ok = inspectDocument(sampleDoc());
  check('accepts a schema 1 track', !ok.error && ok.id === 'trk-1a2b3c4d' && ok.gates === 1);
  /* The field is what the plan is drawn on. The old message named it and
   * then never checked it. */
  const noField = sampleDoc();
  delete noField.field;
  check('refuses a track with no field', Boolean(inspectDocument(noField).error));
  /*
   * gates is the count of things you FLY THROUGH, not the length of the
   * flying order: a waypoint pins the line and nothing stands there. This
   * is the number printed on the card beside the plan, and the plan's own
   * badges come from the same rule in planFromDocument.
   */
  const withWaypoint = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [
      { id: 'el-1', type: 'gate', position: { x: 0, y: 0, z: 0 }, yaw: 0, dims: { levels: 1 } },
      { id: 'el-2', type: 'waypoint', position: { x: 5, y: 5, z: 0 }, yaw: 0, dims: {} },
    ],
    sequence: [{ elementId: 'el-1' }, { elementId: 'el-2' }],
  }));
  check('a waypoint in the order is not a gate', !withWaypoint.error && withWaypoint.gates === 1);
  /*
   * MIRROR CHECK. layoutHash decides whether a republished track keeps its
   * times, and the simulator's layoutFingerprint predicts that answer so it
   * can warn first. They hash differently on purpose; they must agree on
   * which keys ARE the layout. If this list changes, change
   * fdfpv/src/share/listing.js with it.
   */
  const layoutKeys = sampleDoc();
  const movedGate = sampleDoc();
  movedGate.elements = movedGate.elements.map((el) => ({ ...el, position: { ...el.position, x: 99 } }));
  check('layoutHash follows elements', layoutHash(layoutKeys) !== layoutHash(movedGate));
  const recoloured = sampleDoc();
  recoloured.branding = { logo: null, logoName: 'ignored' };
  check('layoutHash ignores branding', layoutHash(layoutKeys) === layoutHash(recoloured));
  check('refuses an empty flying order', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { sequence: [] })).error));
  check('refuses a flying order that names nothing', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', {
    sequence: [{ id: 'seq-1', elementId: 'missing', apertureIndex: 0, entry: 1 }],
  })).error));
  check('refuses a remote logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'https://evil.example/x.png' })).error));
  check('refuses an svg logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/svg+xml;base64,PHN2Zy8+' })).error));
  const withLogo = inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/png;base64,aaa' }));
  check('keeps an embedded logo', !withLogo.error && withLogo.hasLogo);

  /*
   * FIVE MARKS. A schemaVersion 2 track spells its branding as a list, and
   * the board has to read both spellings: the old one, because tracks
   * published under it are already stored, and the new one, because that is
   * what a current builder writes.
   */
  const png = (n) => `data:image/png;base64,${'a'.repeat(n)}`;
  const logos = (count, size = 64) => Array.from({ length: count }, (unused, i) => ({
    id: `logo-${i + 1}`, image: png(size), name: `m${i + 1}`,
  }));
  const v2 = sampleDoc('trk-1a2b3c4d', { logos: logos(5) });
  v2.schemaVersion = 2;
  const five = inspectDocument(v2);
  check('accepts a schema 2 track with five logos', !five.error && five.logoCount === 5);
  /*
   * SCHEMA 3 IS THE TRACK CLASS, and this used to assert the refusal. It was
   * right while there was one class: an unknown version is a document from a
   * builder this board has not been taught, and letting one in unread is how
   * a board ends up storing a shape it cannot draw.
   *
   * Version 3 has now been read. It adds `trackClass` and nothing else:
   * field, elements and sequence are identical, so a version 1 or 2 track
   * keeps its times across a republish and every stored track reads as the
   * sixty metre field it was built on.
   */
  const v3 = sampleDoc('trk-1a2b3c4d');
  v3.schemaVersion = 3;
  const three = inspectDocument(v3);
  check('accepts a schema 3 track', !three.error, three.error);
  check('and a schema 3 track with no class is the field', three.trackClass === 'full', three.trackClass);
  const v4 = sampleDoc('trk-1a2b3c4d');
  v4.schemaVersion = 4;
  check('but still refuses a version it has not been taught', Boolean(inspectDocument(v4).error));

  /*
   * A ROOM. RaceGOW's own dimensions: a 5 by 6 m field, a 28 inch gate out
   * of 26.7 mm PVC, and a single 100 mm start stand, because there are no
   * heats and every pilot flies alone at home.
   *
   * The three things checked here are the three the drawer cannot guess and
   * used to assume: the class, the gate's own opening and the start row.
   * Held at the MultiGP figures, that plan drew a gate a third of the width
   * of the room and a start line two thirds of the way across it.
   */
  const room = roomDoc();
  const roomOut = inspectDocument(room);
  check('accepts a RaceGOW room', !roomOut.error, roomOut.error);
  check('and reads its class', roomOut.trackClass === 'micro', roomOut.trackClass);
  check('trackClassOf defaults anything else to the field',
    trackClassOf({}) === 'full' && trackClassOf(null) === 'full'
    && trackClassOf({ trackClass: 'nonsense' }) === 'full');

  /*
   * THE DESIGNER SURVIVES THE ROUND TRIP.
   *
   * Eight of the tracks on this board were built by six other people and
   * published by one, and for a while the card said "Built by" the
   * publisher. The document has always carried the designer; this is the
   * read that puts it in front of a visitor, so it is checked here.
   */
  const credited = { ...roomDoc(), credit: { designer: '  Skittles  ', series: 'RaceGOW5', broughtOverBy: 'andAgainFPV' } };
  const creditOut = inspectDocument(credited);
  check('a credited track is accepted', !creditOut.error, creditOut.error);
  check('and its designer is kept on the document',
    creditOut.document.credit.designer === '  Skittles  ', JSON.stringify(creditOut.document.credit));
  const read = creditOf(creditOut.document);
  check('and creditOf trims it for the page',
    read.designer === 'Skittles' && read.series === 'RaceGOW5', JSON.stringify(read));
  check('creditOf is empty on a track with no credit block',
    creditOf(roomDoc()).designer === '' && creditOf(null).designer === ''
    && creditOf({ credit: 'nonsense' }).designer === '');
  /*
   * AND IT READS STRINGS AND NOTHING ELSE. The simulator's writer only ever
   * sends strings, but the document is whatever the publish request said it
   * was, and String() of an object or an array is a name nobody typed.
   */
  const odd = creditOf({ credit: { designer: { name: 'x' }, series: ['a', 'b'] } });
  check('creditOf reads a string and nothing else',
    odd.designer === '' && odd.series === ''
    && creditOf({ credit: { designer: 7, series: true } }).designer === ''
    && creditOf({ credit: ['MrE'] }).designer === '',
    JSON.stringify(odd));
  const spaced = creditOf({ credit: { designer: ' Cumber \n\n and\t Hotspur\u0000 ' } });
  check('creditOf closes up whitespace and drops control characters',
    spaced.designer === 'Cumber and Hotspur', JSON.stringify(spaced.designer));
  check('creditOf caps a name at eighty characters',
    creditOf({ credit: { designer: 'x'.repeat(200) } }).designer.length === 80);
  const rowOdd = rowToSummary({
    id: 'trk-00000002', name: 'Room', author: 'somebody', document: { ...roomDoc(), credit: { designer: ['a'] } },
    gates: 1, elements: 1, has_logo: false, published_utc: '', updated_utc: '', tags: [],
  });
  check('a Postgres row with a junk credit block still summarises, with no designer',
    rowOdd.designer === '' && rowOdd.series === '' && rowOdd.name === 'Room', JSON.stringify(rowOdd.designer));

  /*
   * THE TWO WRITERS OF ONE CONTRACT, HELD AGAINST EACH OTHER.
   *
   * A track summary is built twice: summaryOf from the file store's object
   * and rowToSummary from a Postgres row. The comment on rowToSummary has
   * said for a while that anything added to one has to be added to the
   * other, because `best` was once missing from it. The designer was missing
   * from it too, for exactly one deploy: the file store named the builder,
   * the live board went on naming the publisher, and nothing here noticed.
   * So the shapes are compared now rather than trusted.
   */
  const credDoc = { ...roomDoc(), credit: { designer: 'MrE', series: 'RaceGOW5' } };
  const fileSide = summaryOf({
    id: 'trk-00000001', name: 'Room', author: 'somebody', document: credDoc,
    gates: 1, elements: 1, hasLogo: false, publishedUtc: '', updatedUtc: '', tags: [],
  }, []);
  const pgSide = rowToSummary({
    id: 'trk-00000001', name: 'Room', author: 'somebody', document: credDoc,
    gates: 1, elements: 1, has_logo: false, published_utc: '', updated_utc: '', tags: [],
  });
  /* `times` and `best` are the two the Postgres path adds around
   * rowToSummary, from its own queries, so they are not expected on the row
   * side. Everything else has to match. */
  const keysOf = (o) => Object.keys(o).filter((k) => k !== 'times' && k !== 'best').sort().join(',');
  check('the file store and the Postgres row build the same summary shape',
    keysOf(fileSide) === keysOf(pgSide),
    `file ${keysOf(fileSide)} | row ${keysOf(pgSide)}`);
  check('and both of them name the designer',
    fileSide.designer === 'MrE' && pgSide.designer === 'MrE'
    && fileSide.series === 'RaceGOW5' && pgSide.series === 'RaceGOW5',
    `${fileSide.designer}/${pgSide.designer}`);
  const roomPlan = planFromDocument(room);
  check('the plan carries the class', roomPlan.trackClass === 'micro', roomPlan.trackClass);
  check('the plan carries the room, not a field',
    roomPlan.width === 5 && roomPlan.depth === 6, `${roomPlan.width} by ${roomPlan.depth}`);
  const planGate = roomPlan.marks.find((m) => m.type === 'gate');
  check('the plan carries the gate\u2019s own opening',
    planGate && Math.abs(planGate.clearW - 0.7112) < 1e-9, planGate && planGate.clearW);
  const planStart = roomPlan.marks.find((m) => m.type === 'startPads');
  check('the plan carries the start row',
    planStart && planStart.pads === 1 && planStart.spacing === 0.3 && planStart.padSize === 0.1,
    JSON.stringify(planStart));
  /* And the field is untouched: every track already on this board is one. */
  const fieldPlan = planFromDocument(sampleDoc());
  check('a field plan is still a field plan',
    fieldPlan.trackClass === 'full' && fieldPlan.width === 60 && fieldPlan.depth === 40);
  const fieldGate = fieldPlan.marks.find((m) => m.type === 'gate');
  check('and it carries its own 5 ft opening',
    fieldGate && Math.abs(fieldGate.clearW - 1.524) < 1e-9, fieldGate && fieldGate.clearW);

  /*
   * THE THREE LAP TOTAL is optional, and every way of not having one has to
   * come out as null rather than as an error: a time from the field never
   * has one, and a run in a room only has one when it put three clean laps
   * together. The lower bound is the run's own arithmetic. Three laps cannot
   * be faster than three of the run's best lap, and the posted lap IS the
   * best lap, so anything under three times it is a claim the run's own
   * numbers contradict.
   */
  check('a three lap total is kept', normaliseThreeMs(21590, 6990) === 21590);
  check('no three lap total is null', normaliseThreeMs(undefined, 6990) === null);
  check('an explicit null is null', normaliseThreeMs(null, 6990) === null);
  check('a string is null, not a NaN', normaliseThreeMs('21590', 6990) === null);
  check('a total faster than three of its own lap is null',
    normaliseThreeMs(20000, 6990) === null);
  check('exactly three of its own lap is kept', normaliseThreeMs(6990 * 3, 6990) === 20970);
  check('a negative total is null', normaliseThreeMs(-1, 6990) === null);
  const six = sampleDoc('trk-1a2b3c4d', { logos: logos(6) });
  six.schemaVersion = 2;
  check('refuses a sixth logo', Boolean(inspectDocument(six).error));
  const fat = sampleDoc('trk-1a2b3c4d', { logos: logos(3, 200 * 1024) });
  fat.schemaVersion = 2;
  check('refuses logos past the shared budget', Boolean(inspectDocument(fat).error));
  const remoteInList = sampleDoc('trk-1a2b3c4d', {
    logos: [{ id: 'logo-1', image: 'https://evil.example/x.png', name: 'x' }],
  });
  remoteInList.schemaVersion = 2;
  check('refuses a remote logo in the list', Boolean(inspectDocument(remoteInList).error));

  /*
   * PAINT IS NOT LAYOUT. Selling a sponsor a place on a track that people
   * have already flown must not clear the times on it, so a ground logo is
   * filtered out of the layout hash. MIRRORS LAYOUT_SKIP in the simulator's
   * src/share/listing.js: change one and change the other.
   */
  const painted = sampleDoc();
  painted.elements = [...painted.elements, {
    id: 'el-9',
    type: 'groundLogo',
    name: '',
    position: { x: 30, y: 20, z: 0 },
    yaw: 0,
    pitch: 0,
    yawOverridden: false,
    logoId: 'logo-1',
    dims: { width: 10, depth: 4 },
  }];
  check('layoutHash ignores paint on the grass', layoutHash(layoutKeys) === layoutHash(painted));
  const paintedPlan = inspectDocument(painted);
  check('a ground logo is not a gate', !paintedPlan.error && paintedPlan.gates === 1);
  check('a ground logo is not drawn on the plan',
    !paintedPlan.error && !paintedPlan.plan.marks.some((m) => m.type === 'groundLogo'));
  const a = layoutHash(sampleDoc());
  const b = layoutHash(sampleDoc('trk-1a2b3c4d', { name: 'Renamed' }));
  check('layout hash ignores the title', a === b);
  const pinned = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [
      {
        id: 'el-1',
        type: 'gate',
        name: 'Gate',
        position: { x: 10, y: 8, z: 0 },
        yaw: 0,
        pitch: 0,
        yawOverridden: false,
        dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
      },
      {
        id: 'el-2',
        type: 'waypoint',
        name: 'Pin',
        position: { x: 22, y: 18, z: 1.2 },
        yaw: 0.4,
        pitch: 0,
        yawOverridden: false,
        dims: { height: 1.6, poleRadius: 0.02, clearance: 0 },
      },
      {
        id: 'el-3',
        type: 'flag',
        name: 'Dress',
        position: { x: 40, y: 30, z: 0 },
        yaw: 0,
        pitch: 0,
        yawOverridden: false,
        dims: { height: 2.5, poleRadius: 0.025, clearance: 1.5 },
      },
    ],
    sequence: [
      { id: 'seq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 },
      { id: 'seq-2', elementId: 'el-2', apertureIndex: 0, entry: 1 },
    ],
  }));
  check('plan omits waypoints', pinned.plan.marks.every((m) => m.type !== 'waypoint'));
  check('plan path follows the flying order through a waypoint',
    pinned.plan.path.length === 2
    && pinned.plan.path[0].x === 10
    && pinned.plan.path[1].x === 22);
  check('an unused flag is marked off the flying order',
    pinned.plan.marks.some((m) => m.type === 'flag' && m.seq === false));
  check('the start of the flying order is numbered 1',
    pinned.plan.numbers.length === 1 && pinned.plan.numbers[0].n === 1);
  const bugOk = inspectBugCreate({
    kind: 'visual',
    title: 'Trees flicker at the shrine',
    what: 'Flying past the shrine the treeline pops in and out every few frames.',
    reporter: 'Ada Rook',
    context: { map: 'city', screen: 'paused' },
  });
  check('accepts a real bug report', !bugOk.error && bugOk.reporter === 'Ada Rook' && bugOk.kind === 'visual');
  check('blank reporter becomes Anonymous', inspectBugCreate({
    kind: 'other',
    title: 'A short enough title here',
    what: 'Twenty characters at least in this description.',
  }).reporter === 'Anonymous');
  check('refuses a one word title', Boolean(inspectBugCreate({
    kind: 'other', title: 'Short', what: 'Twenty characters at least in this description.',
  }).error));
  check('refuses an unknown kind', Boolean(inspectBugCreate({
    kind: 'explode', title: 'A short enough title here', what: 'Twenty characters at least in this description.',
  }).error));
  check('refuses a symbol reporter', Boolean(inspectBugCreate({
    kind: 'other', title: 'A short enough title here', what: 'Twenty characters at least in this description.', reporter: 'Ada!',
  }).error));
  check('accepts a status patch', inspectBugPatch({ status: 'fixed', resolution: 'Trees no longer pop.' }).status === 'fixed');
  check('refuses a made up status', Boolean(inspectBugPatch({ status: 'maybe' }).error));
  /* Feel reports carry a wide context: twenty keys today, and the cap has
   * to keep headroom over that or feedback bounces with "too many fields". */
  const wide = {};
  for (let i = 0; i < 32; i += 1) {
    wide[`k${i}`] = i;
  }
  check('a thirty two key context is accepted', !inspectBugCreate({
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run, no complaints.', context: wide,
  }).error);
  wide.k32 = 32;
  check('a thirty three key context is refused', Boolean(inspectBugCreate({
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run, no complaints.', context: wide,
  }).error));

  const ghostB64 = makeGhostB64(29110);
  check('accepts a well formed ghost', inspectGhost(ghostB64, 29110).ghost === ghostB64);
  check('an absent ghost is not an error', inspectGhost(null, 29110).ghost === null && inspectGhost('', 29110).ghost === null);
  check('refuses a ghost that is not a string', Boolean(inspectGhost(42, 29110).error));
  check('refuses a ghost that is not base64', Boolean(inspectGhost('not*base64!!'.repeat(8), 29110).error));
  check('refuses a ghost with the wrong magic', Boolean(inspectGhost(makeGhostB64(29110, { magic: 'NOTGHOST' }), 29110).error));
  check('refuses a ghost from another format version', Boolean(inspectGhost(makeGhostB64(29110, { version: 3 }), 29110).error));
  check('refuses a ghost whose bytes disagree with its header', Boolean(inspectGhost(makeGhostB64(29110, { trimBytes: 20 }), 29110).error));
  check('refuses a ghost that does not match the lap beside it', Boolean(inspectGhost(ghostB64, 35000).error));
  check('refuses a ghost past the size cap', Boolean(inspectGhost('A'.repeat(500_004), 1000).error));
  check('refuses a ghost claiming an hour of lap', Boolean(inspectGhost(makeGhostB64(3_000_000, { rateHz: 1 }), 3_000_000).error));
}

async function testStore() {
  console.log('store');
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-board-'));
  process.env.BOARD_FILE = join(dir, 'board.json');
  delete process.env.DATABASE_URL;
  const store = await openStore();
  const inspected = inspectDocument(sampleDoc());
  const first = await store.publish({ inspected, author: 'Ada Rook', editKey: '' });
  check('first publish returns an edit key', Boolean(first.editKey) && first.updated === false);
  const clash = await store.publish({ inspected, author: 'Ada Rook', editKey: '' });
  check('second publish without the key is refused', clash.status === 409 && clash.conflict === true);
  const again = await store.publish({ inspected, author: 'Ada Rook', editKey: first.editKey });
  check('second publish with the key updates', again.updated === true && !again.editKey);
  await store.addTime({ trackId: inspected.id, name: 'Ada Rook', lapMs: 42000 });
  const renamed = inspectDocument(sampleDoc('trk-1a2b3c4d', { name: 'Renamed Loop' }));
  const named = await store.publish({ inspected: renamed, author: 'Ada Rook', editKey: first.editKey });
  check('a rename does not clear times', named.timesCleared === false);
  const afterName = await store.getTrack(inspected.id);
  check('the board shows the new name and keeps the time', afterName.name === 'Renamed Loop' && afterName.times.length === 1 && afterName.times[0].lapMs === 42000);
  await store.addTime({ trackId: inspected.id, name: 'Bo', lapMs: 51000 });
  const reauthor = await store.publish({ inspected: renamed, author: 'Ada Two', editKey: first.editKey });
  check('an author rename does not clear times', reauthor.timesCleared === false);
  const afterAuthor = await store.getTrack(inspected.id);
  check('an author rename retitles their times and leaves others', afterAuthor.author === 'Ada Two' && afterAuthor.times[0].name === 'Ada Two' && afterAuthor.times[1].name === 'Bo');
  const moved = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [{
      id: 'el-1',
      type: 'gate',
      name: 'Gate',
      position: { x: 20, y: 8, z: 0 },
      yaw: 0,
      pitch: 0,
      yawOverridden: false,
      dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
    }],
  }));
  const cleared = await store.publish({ inspected: moved, author: 'Ada Rook', editKey: first.editKey });
  check('a layout change clears times', cleared.timesCleared === true);
  const after = await store.getTrack(inspected.id);
  check('cleared board has no times', after.times.length === 0);
  const posted = await store.addTime({ trackId: inspected.id, name: 'Ada Rook', lapMs: 33400 });
  check('a posted time is rank 1', posted.rank === 1);
  const slower = await store.addTime({ trackId: inspected.id, name: 'Bo', lapMs: 40000 });
  check('a slower time is rank 2', slower.rank === 2);
  await Promise.all([
    store.addTime({ trackId: inspected.id, name: 'Cy', lapMs: 45000 }),
    store.addTime({ trackId: inspected.id, name: 'Di', lapMs: 46000 }),
  ]);
  const afterParallel = await store.getTrack(inspected.id);
  check('parallel posts both land', afterParallel.times.length === 4);
  const ghostBlob = makeGhostB64(47000);
  const ghosted = await store.addTime({
    trackId: inspected.id, name: 'Ev', lapMs: 47000, ghost: ghostBlob,
  });
  check('a posted time gets a public id', /^tm-[0-9a-f]{8}$/.test(String(ghosted.id)));
  const withGhost = await store.getTrack(inspected.id);
  const evRow = withGhost.times.find((t) => t.name === 'Ev');
  check('the list marks the ghost and keeps the blob out of it', Boolean(evRow) && evRow.hasGhost === true && !('ghost' in evRow));
  check('times posted without a ghost read hasGhost false', withGhost.times.filter((t) => t.name !== 'Ev').every((t) => t.hasGhost === false));
  const fetchedGhost = await store.getGhost(inspected.id, ghosted.id);
  check('the ghost comes back whole', Boolean(fetchedGhost) && fetchedGhost.ghost === ghostBlob && fetchedGhost.lapMs === 47000);
  check('an unknown time id has no ghost row', (await store.getGhost(inspected.id, 'tm-00000000')) === null);
  /*
   * THE THREE LAP TOTAL, through the store. It is optional at every step, so
   * the two cases that matter are that one posted comes back and one not
   * posted comes back as null rather than as undefined: the page prints it
   * or does not, and undefined would print the word.
   */
  const withThree = await store.addTime({
    trackId: inspected.id, name: 'Fi', lapMs: 48000, threeMs: 146000,
  });
  check('a posted three lap total comes back', withThree.threeMs === 146000, withThree.threeMs);
  const threeListed = (await store.getTrack(inspected.id)).times.find((t) => t.name === 'Fi');
  check('and it is in the list', threeListed && threeListed.threeMs === 146000,
    threeListed && threeListed.threeMs);
  const adaListed = (await store.getTrack(inspected.id)).times.find((t) => t.name === 'Ada Rook');
  check('a time posted without one lists null, not undefined',
    adaListed && adaListed.threeMs === null, adaListed && String(adaListed.threeMs));
  /* A row written before ghosts existed: no id, no ghost key at all. It
   * has to list cleanly, not crash the mapper. */
  store.data.times[inspected.id].push({ name: 'Old Row', lapMs: 60000, postedUtc: '2026-01-01T00:00:00.000Z' });
  const legacyRow = (await store.getTrack(inspected.id)).times.find((t) => t.name === 'Old Row');
  check('a time from before ghosts lists with a null id and no ghost', Boolean(legacyRow) && legacyRow.id === null && legacyRow.hasGhost === false);
  const list = await store.listTracks();
  check('the list names the author', list[0].author === 'Ada Rook' && list[0].best.lapMs === 33400);
  store.data.tracks[inspected.id].plan = {
    width: 60,
    depth: 40,
    marks: [{ type: 'waypoint', x: 1, y: 1, yaw: 0 }],
  };
  const relist = await store.listTracks();
  check('the list plan is rebuilt from the document',
    relist[0].plan.marks.every((m) => m.type !== 'waypoint')
    && relist[0].plan.path.length === 1
    && relist[0].plan.path[0].x === 20);
  const doc = await store.getDocument(inspected.id);
  check('the document is still there', doc.document.id === inspected.id);
  const filed = await store.addBug(inspectBugCreate({
    kind: 'feel',
    title: 'Yaw feels late on the field',
    what: 'A right yaw stick on the field map takes a beat before the quad turns.',
    reporter: 'Ada Rook',
    context: { map: 'field', screen: 'flight' },
  }));
  check('a filed bug has an id and is open', Boolean(filed.id) && /^bug-[0-9a-f]{8}$/.test(filed.id) && filed.status === 'open');
  const listed = await store.listBugs({ status: 'open' });
  check('the open list names the bug', listed.length === 1 && listed[0].id === filed.id && listed[0].title === filed.title);
  const got = await store.getBug(filed.id);
  check('the full ticket keeps what happened', got.what.includes('yaw stick') && got.context.map === 'field');
  const marked = await store.updateBug(filed.id, { status: 'fixed', resolution: 'Checked rates. Not a sim bug.' });
  check('an update marks the ticket fixed', marked.status === 'fixed' && marked.resolution.includes('rates'));
  const stillOpen = await store.listBugs({ status: 'open' });
  check('a fixed ticket leaves the open list', stillOpen.length === 0);
  const missing = await store.updateBug('bug-00000000', { status: 'open' });
  check('updating a missing ticket is a 404', missing.status === 404);
  await rm(dir, { recursive: true, force: true });

  const legacyDir = await mkdtemp(join(tmpdir(), 'fdfpv-board-legacy-'));
  process.env.BOARD_FILE = join(legacyDir, 'board.json');
  delete process.env.DATABASE_URL;
  await writeFile(join(legacyDir, 'board.json'), JSON.stringify({ tracks: {}, times: {} }), 'utf8');
  const legacy = await openStore();
  const legacyBugs = await legacy.listBugs();
  check('a board.json without bugs still lists an empty ticket list', Array.isArray(legacyBugs) && legacyBugs.length === 0);
  const stillTracks = await legacy.listTracks();
  check('a board.json without bugs still lists tracks', Array.isArray(stillTracks) && stillTracks.length === 0);
  await rm(legacyDir, { recursive: true, force: true });
}

function waitFor(child, needle, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), ms);
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function testHttp() {
  console.log('http');
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-board-'));
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '3199',
      BOARD_FILE: join(dir, 'board.json'),
      DATABASE_URL: '',
      SIM_ORIGIN: 'http://127.0.0.1:8000',
      BOARD_ADMIN_TOKEN: ADMIN_TOKEN,
      BOARD_ADMINS: `${ADMIN_EMAIL}:plain:${ADMIN_PASSWORD}`,
      /* One sponsor, so the fold has a real slug to keep as well as an
       * invented one to refuse, and BOARD_TRUST_PROXY so the country header
       * is believed the way it is behind the edge. */
      BOARD_SPONSORS: 'rotorriot:Rotor Riot',
      BOARD_TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitFor(child, 'FDFPV leaderboard');
    const health = await fetch('http://127.0.0.1:3199/api/health').then((r) => r.json());
    check('health', health.ok === true && health.store === 'file');
    const created = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: lapDoc() }),
    });
    const body = await created.json();
    check('publish over HTTP', created.status === 201 && body.id === 'trk-1a2b3c4d');
    const adaLap = honestLap(lapDoc());
    const time = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Rook', lapMs: adaLap.lapMs, ghost: adaLap.ghost }),
    });
    const posted = await time.json();
    check('post a time over HTTP', time.status === 201 && posted.rank === 1, `${time.status} ${JSON.stringify(posted).slice(0, 120)}`);
    const bare = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Rook', lapMs: adaLap.lapMs }),
    });
    check('a time without a ghost is refused', bare.status === 400);
    const renamed = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: { ...lapDoc(), name: 'HTTP Rename' },
        editKey: body.editKey,
      }),
    });
    const renamedBody = await renamed.json();
    check('rename over HTTP', renamed.status === 200 && renamedBody.updated === true && renamedBody.timesCleared !== true);
    const page = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    check('expanded track has the new name and the time', page.name === 'HTTP Rename' && page.times[0].lapMs === Math.round(adaLap.lapMs));
    const reauthor = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Two',
        document: { ...lapDoc(), name: 'HTTP Rename' },
        editKey: body.editKey,
      }),
    });
    const reauthorBody = await reauthor.json();
    check('author rename over HTTP', reauthor.status === 200 && reauthorBody.updated === true && reauthorBody.timesCleared !== true);
    const renamedTimes = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    check('author rename retitles the posted time', renamedTimes.author === 'Ada Two' && renamedTimes.times[0].name === 'Ada Two');
    const boLap = honestLap(lapDoc(), { speed: 15 });
    const ghostWire = boLap.ghost;
    const ghostPost = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: boLap.lapMs, ghost: ghostWire }),
    });
    const ghostPosted = await ghostPost.json();
    check('post a time with a ghost over HTTP', ghostPost.status === 201 && /^tm-[0-9a-f]{8}$/.test(String(ghostPosted.id)));
    const ghostList = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    const boRow = ghostList.times.find((t) => t.name === 'Bo');
    check('the track lists the ghost without carrying it', Boolean(boRow) && boRow.hasGhost === true && boRow.ghost === undefined);
    const ghostGet = await fetch(`http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times/${ghostPosted.id}/ghost`);
    const ghostBody = await ghostGet.json();
    check('the ghost is fetched whole', ghostGet.status === 200 && ghostBody.ghost === ghostWire && ghostBody.lapMs === Math.round(boLap.lapMs));
    const skipped = honestLap(lapDoc(), { hoverAfterMs: 1500 });
    const padded = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: skipped.durationMs, ghost: skipped.ghost }),
    });
    const paddedBody = await padded.json();
    check('a ghost that hovers past the line cannot claim the long time',
      padded.status === 422 && /does not hold up/.test(paddedBody.error), `${padded.status} ${paddedBody.error}`);
    const badGhostId = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times/constructor/ghost');
    check('a non-time ghost address is not a 500', badGhostId.status === 400 || badGhostId.status === 404);
    const badGhost = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: 31500, ghost: 'AAAA' }),
    });
    check('a malformed ghost is refused, not stored', badGhost.status === 400);
    const wrongLap = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: 90000, ghost: ghostWire }),
    });
    check('a ghost for a different lap is refused', wrongLap.status === 400);
    const noSuch = await fetch('http://127.0.0.1:3199/api/tracks/trk-0000dead/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: boLap.lapMs, ghost: ghostWire }),
    });
    check('a time on a track that is not on the board is a 404', noSuch.status === 404, `${noSuch.status}`);
    const html = await fetch('http://127.0.0.1:3199/').then((r) => r.text());
    check('the page is served', html.includes('Tracks and Statistics') && html.includes('app.js'));
    /* The two tabs are in the MARKUP rather than built by the script, so a
     * pasted #stats link works on a board whose track list failed to load
     * and a reader with no JavaScript still sees what this page holds. */
    check('the page carries both tabs', html.includes('id="tab-tracks"') && html.includes('id="tab-stats"'));
    check('the statistics section is in the markup', html.includes('id="view-stats"'));
    /* The promise, in the one place a visitor reads it. If this sentence
     * ever stops being true the check below is the thing that has to be
     * argued with rather than quietly deleted. */
    check('the page says what it counts', html.includes('No cookie is set'));
    /* Relative, not root absolute. The board is served at its own root here
     * and under /board/ on fdfpv.example, and a leading slash on either of these
     * asks the landing page for the board's script. The old assertion above
     * matched both spellings, so it could not see the difference. */
    check('the page loads its script relatively', html.includes('src="./app.js"'));
    check('the page has no root absolute reference', !html.includes('src="/') && !html.includes('href="/'));
    check('the page does not load a webfont', !html.includes('fonts.googleapis.com'));
    const app = await fetch('http://127.0.0.1:3199/app.js').then((r) => r.text());
    /*
     * app.js imports origins.js. A module import that 404s takes the WHOLE
     * page down, not just the links, so the one thing this file must prove
     * about it is that it is actually served and is actually a module.
     */
    const origins = await fetch('http://127.0.0.1:3199/origins.js');
    const originsBody = await origins.text();
    check('origins.js is served', origins.status === 200);
    check('origins.js is served as javascript',
      String(origins.headers.get('content-type') || '').includes('javascript'));
    check('app.js imports it relatively', app.includes("from './origins.js'"));
    check('origins.js exports what app.js imports',
      originsBody.includes('export function guessSimOrigin')
      && originsBody.includes('export function landingOrigin'));
    /* The mark in the masthead and the one in the spine are the same mark
     * and both are the way home, so both carry the id bindHome looks for.
     * A rename on one side and not the other leaves a link pointed at a
     * checkout's port 8080 on a public board, and it looks fine. */
    check('both marks are bound to the front door',
      html.includes('id="brand-home"') && html.includes('id="spine-home"')
      && app.includes("['brand-home', 'spine-home']"));
    const homeAnchors = html.match(/<a\b[^>]*id="(?:brand|spine)-home"[^>]*>/g) || [];
    check('the way home stays in this tab',
      homeAnchors.length === 2 && homeAnchors.every((a) => !a.includes('target=')));
    const cardFn = app.slice(app.indexOf('function cardFor('));
    const attach = cardFn.indexOf('card.append(body)');
    const paint = cardFn.indexOf('paintPodium(');
    check('a track card is attached before its times are painted', attach !== -1 && paint !== -1 && attach < paint);
    const cfg = await fetch('http://127.0.0.1:3199/api/config').then((r) => r.json());
    check('config names the simulator', cfg.simOrigin === 'http://127.0.0.1:8000');
    /*
     * One simulator tab. A named target is the whole mechanism, and a
     * rel="noopener" sitting beside it undoes it in silence: the spec
     * rewrites a noopener target to "_blank" before looking the name up,
     * so the link opens a fresh simulator on every click and the page
     * looks correct while doing it. Both halves are asserted, on the
     * fallback anchors in the page and on the links app.js builds.
     */
    const simAnchors = html.match(/<a\b[^>]*href="http:\/\/127\.0\.0\.1:8000[^"]*"[^>]*>/g) || [];
    check('every fallback link to the simulator names the simulator tab',
      simAnchors.length === 7 && simAnchors.every((a) => a.includes('target="fdfpv-sim"')));
    /* Six: the card's Fly, the sheet's Fly and Remix, the header and
     * footer rewrite helper, the empty-page Build link, and the chase link
     * builder the podium and the sheet's table both go through. Credits
     * uses the same rewrite helper.
     *
     * It was eight while the freestyle board had a Fly button on an empty
     * table and another under a full one. That board is gone, so those two
     * links are gone, and the number moved because the page did.
     *
     * The number is the point of the check rather than a detail of it: a
     * new link that forgets the tab name opens a fresh simulator on every
     * click, each one running a physics loop and holding a WebGL context,
     * and the page looks perfectly correct while doing it. */
    check('the links app.js builds name the simulator tab',
      app.includes("const SIM_WINDOW = 'fdfpv-sim'")
      && (app.match(/\.target = SIM_WINDOW/g) || []).length === 6);
    check('nothing app.js builds opens a bare new tab or asks for noopener',
      !app.includes("'_blank'") && !app.includes("noopener'"));
    const sneak = await fetch('http://127.0.0.1:3199/%2e%2e/package.json');
    const sneakText = await sneak.text();
    check('encoded parent path cannot read the package', sneak.status !== 200 && !sneakText.includes('fdfpvboard'));
    const badPct = await fetch('http://127.0.0.1:3199/%');
    check('a malformed percent is not a 500', badPct.status === 400 || badPct.status === 404);
    const filed = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'visual',
        title: 'City trees flicker at dusk',
        what: 'Near the shrine the treeline pops in and out every few frames.',
        expected: 'Trees stay put.',
        steps: 'Load city. Fly to the shrine. Look at the treeline.',
        reporter: 'Ada Rook',
        context: { map: 'city', screen: 'paused', graphics: 'high' },
      }),
    });
    const ticket = await filed.json();
    check('file a bug over HTTP', filed.status === 201 && /^bug-[0-9a-f]{8}$/.test(ticket.id) && ticket.status === 'open');
    const short = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'other', title: 'Nope', what: 'Too short.' }),
    });
    check('a short bug title is refused', short.status === 400);
    const listed = await fetch('http://127.0.0.1:3199/api/bugs?status=open').then((r) => r.json());
    check('the open list includes the new ticket', listed.bugs.some((b) => b.id === ticket.id && b.map === 'city'));
    const one = await fetch(`http://127.0.0.1:3199/api/bugs/${ticket.id}`).then((r) => r.json());
    check('the full ticket keeps context', one.context.map === 'city' && one.what.includes('shrine'));
    const patched = await fetch(`http://127.0.0.1:3199/api/bugs/${ticket.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    const patchedBody = await patched.json();
    check('an agent can mark a ticket in progress', patched.status === 200 && patchedBody.status === 'in_progress');
    const feel = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'feel',
        title: 'Flight feel: about right',
        what: 'The quad felt about right this run. Locked in, no complaints.',
        reporter: 'Ada Rook',
        context: { map: 'field', tune: 'crapshack' },
      }),
    });
    const feelTicket = await feel.json();
    check('flight feel feedback lands as a ticket', feel.status === 201 && feelTicket.kind === 'feel');
    const feelList = await fetch('http://127.0.0.1:3199/api/bugs?kind=feel').then((r) => r.json());
    check('the feedback filter lists only feel reports',
      feelList.bugs.length === 1 && feelList.bugs[0].id === feelTicket.id
      && feelList.bugs.every((b) => b.kind === 'feel'));
    const inbox = await fetch('http://127.0.0.1:3199/bugs.html').then((r) => r.text());
    check('the inbox page is served', inbox.includes('Bugs and feedback') && inbox.includes('bugs.js'));
    check('the inbox can filter by kind', inbox.includes('id="kind"') && inbox.includes('Feedback, flight feel'));
    check('the inbox loads its script relatively', inbox.includes('src="bugs.js"'));
    check('the inbox has no root absolute reference', !inbox.includes('src="/') && !inbox.includes('href="/'));
    const bugsJs = await fetch('http://127.0.0.1:3199/bugs.js').then((r) => r.text());
    check('neither script fetches from the site root',
      !app.includes("fetch('/") && !app.includes('fetch(`/')
      && !bugsJs.includes("fetch('/") && !bugsJs.includes('fetch(`/'));
    const inboxShort = await fetch('http://127.0.0.1:3199/bugs');
    check('/bugs serves the inbox', inboxShort.status === 200 && (await inboxShort.text()).includes('Bugs and feedback'));
    const proto = await fetch('http://127.0.0.1:3199/api/bugs/constructor');
    check('a non-ticket id is not a 500', proto.status === 400 || proto.status === 404);
    const stillBoard = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('filing a bug does not drop tracks', stillBoard.tracks[0].id === 'trk-1a2b3c4d' && stillBoard.tracks[0].best.lapMs === Math.round(adaLap.lapMs));

    /* ---------------------------------------------------------------- */
    /* Tags                                                              */
    /* ---------------------------------------------------------------- */

    const untagged = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('a track published without tags carries an empty list, never undefined',
      Array.isArray(untagged.tracks[0].tags) && untagged.tracks[0].tags.length === 0);
    const tagged = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: lapDoc('trk-7a7a7a7a'),
        tags: ['experiment', 'race', 'race'],
      }),
    });
    const taggedBody = await tagged.json();
    check('a track can be published with tags', tagged.status === 201);
    const withTags = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    const tagRow = withTags.tracks.find((t) => t.id === 'trk-7a7a7a7a');
    /* Deduplicated, and in the board's own order rather than the order they
     * were sent, so two tracks wearing the same tags carry the same list. */
    check('and they come back deduplicated in the board\'s order',
      tagRow && tagRow.tags.join() === 'race,experiment');
    const badTag = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook', document: sampleDoc('trk-8b8b8b8b'), tags: ['racing'],
      }),
    });
    /* Refused, not dropped: a builder that offered a tag and a board that
     * ignored it would disagree silently and the author would never learn. */
    check('an unknown tag is refused rather than dropped', badTag.status === 400);
    const manyTags = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: sampleDoc('trk-9c9c9c9c'),
        tags: ['race', 'skills', 'experiment', 'freestyle', 'beginner', 'technical'],
      }),
    });
    check('and a track cannot wear every tag on the board', manyTags.status === 400);
    /*
     * A tag is not part of the layout, so retagging must not clear a time.
     * That is the whole reason tags travel in the envelope beside the
     * author rather than inside the document, where they would have to be
     * kept out of layoutHash by hand.
     */
    const finchLap = honestLap(lapDoc('trk-7a7a7a7a'));
    await fetch('http://127.0.0.1:3199/api/tracks/trk-7a7a7a7a/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo Finch', lapMs: finchLap.lapMs, ghost: finchLap.ghost }),
    });
    const retagged = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: lapDoc('trk-7a7a7a7a'),
        editKey: taggedBody.editKey,
        tags: ['skills'],
      }),
    });
    const retaggedBody = await retagged.json();
    const afterRetag = await fetch('http://127.0.0.1:3199/api/tracks/trk-7a7a7a7a').then((r) => r.json());
    check('retagging a track keeps its times',
      retagged.status === 200 && retaggedBody.timesCleared === false
      && afterRetag.times.length === 1 && afterRetag.tags.join() === 'skills');
    /* And clearing them is one empty list, not an omission: an omitted list
     * is "this builder does not know about tags" and must leave them be. */
    const cleared = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: lapDoc('trk-7a7a7a7a'),
        editKey: taggedBody.editKey,
        tags: [],
      }),
    });
    const afterClear = await fetch('http://127.0.0.1:3199/api/tracks/trk-7a7a7a7a').then((r) => r.json());
    check('and a track can be untagged again',
      cleared.status === 200 && afterClear.tags.length === 0);

    /* ---------------------------------------------------------------- */
    /* The freestyle board                                               */
    /* ---------------------------------------------------------------- */

    const aRun = (over) => ({
      name: 'Ada Rook',
      map: 'city',
      style: 'expert',
      score: 24800,
      durationMs: 120000,
      tricks: 31,
      unique: 14,
      bestCombo: 9100,
      bestTrick: 1450,
      crashes: 2,
      signature: 'Trippy Spin x2',
      ...over,
    });
    const emptyRuns = await fetch('http://127.0.0.1:3199/api/runs').then((r) => r.json());
    check('the freestyle board starts empty and still answers',
      Array.isArray(emptyRuns.runs) && emptyRuns.runs.length === 0
      && Array.isArray(emptyRuns.tags) && emptyRuns.tags.length > 0);
    const firstRun = await fetch('http://127.0.0.1:3199/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(aRun()),
    });
    const firstBody = await firstRun.json();
    check('post a freestyle run',
      firstRun.status === 201 && firstBody.rank === 1 && firstBody.improved === true);
    const rival = await fetch('http://127.0.0.1:3199/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(aRun({ name: 'Bo Finch', score: 31200 })),
    });
    const rivalBody = await rival.json();
    check('a better run takes the top of the board', rivalBody.rank === 1);
    const ordered = await fetch('http://127.0.0.1:3199/api/runs').then((r) => r.json());
    check('and the board is ordered highest first',
      ordered.runs.length === 2 && ordered.runs[0].name === 'Bo Finch'
      && ordered.runs[1].name === 'Ada Rook');
    /*
     * ONE ROW PER PILOT. A leaderboard is a list of who is good, not a log
     * of who pressed the button, and this endpoint is the board's only
     * public write with no owner: without this rule one pilot could own the
     * whole visible table.
     */
    const worse = await fetch('http://127.0.0.1:3199/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      /* A whole, plausible run that simply is not as good. bestCombo and
       * bestTrick come down with the score, because a chain cannot be worth
       * more than the run it is in and inspectRun refuses one that is. */
      body: JSON.stringify(aRun({ score: 100, bestCombo: 90, bestTrick: 50 })),
    });
    const worseBody = await worse.json();
    const afterWorse = await fetch('http://127.0.0.1:3199/api/runs').then((r) => r.json());
    check('a worse run by the same pilot does not take their place',
      worse.status === 200 && worseBody.improved === false && worseBody.score === 24800
      && afterWorse.runs.length === 2);
    const better = await fetch('http://127.0.0.1:3199/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(aRun({ name: 'ADA ROOK', score: 40000 })),
    });
    const afterBetter = await fetch('http://127.0.0.1:3199/api/runs').then((r) => r.json());
    check('a better one replaces it, and a capital letter is the same pilot',
      better.status === 201 && afterBetter.runs.length === 2
      && afterBetter.runs[0].name === 'ADA ROOK' && afterBetter.runs[0].score === 40000);
    /*
     * The board cannot recompute a score, so it bounds the claim and checks
     * it against itself. These are the refusals that catches.
     */
    const refusals = [
      ['a score no number of tricks could reach', aRun({ score: 1e12 })],
      ['a run with no tricks in it', aRun({ tricks: 0 })],
      ['more distinct tricks than tricks', aRun({ unique: 99, tricks: 4 })],
      ['one trick worth more than the whole run', aRun({ bestTrick: 999999 })],
      ['a chain worth more than the whole run', aRun({ bestCombo: 999999 })],
      ['a map this board keeps no scores for', aRun({ map: 'bando' })],
      ['a physics model that does not exist', aRun({ style: 'godmode' })],
      ['a run that lasted no time at all', aRun({ durationMs: 0 })],
      ['a pilot name that is not a name', aRun({ name: '!!' })],
    ];
    let refused = 0;
    for (const [, payload] of refusals) {
      const r = await fetch('http://127.0.0.1:3199/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 400) {
        refused += 1;
      }
    }
    check('every implausible run is refused with a 400', refused === refusals.length);
    const notObject = await fetch('http://127.0.0.1:3199/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '7',
    });
    check('and a JSON non-object is a 400, not a 500', notObject.status === 400);
    const badMapQuery = await fetch('http://127.0.0.1:3199/api/runs?map=nowhere');
    check('an unknown map in the query is a 400', badMapQuery.status === 400);
    const stillTracks = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('and none of it disturbed the tracks',
      stillTracks.tracks.some((t) => t.id === 'trk-1a2b3c4d'));
    /* The tag vocabulary moved here from the freestyle board's request when
     * that board left the page, and the page reads it off this payload. */
    check('the track list carries the tag vocabulary',
      Array.isArray(stillTracks.tags) && stillTracks.tags.some((t) => t.id === 'skills'));

    /* ---------------------------------------------------------------- */
    /* The card animation                                                 */
    /* ---------------------------------------------------------------- */

    console.log('\nthe card animation');

    const roomPosted = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: lapRoom() }),
    });
    const roomBody = await roomPosted.json();
    check('publish a room', roomPosted.status === 201 && Boolean(roomBody.editKey));
    const roomKey = roomBody.editKey;

    const noArt = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif');
    check('a track with no animation is a 404, not an empty image', noArt.status === 404);

    const up = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: roomKey, gif: GIF_64.toString('base64') }),
    });
    const upBody = await up.json();
    check('the browser that published a room can upload its animation',
      up.status === 200 && upBody.bytes === GIF_64.length, JSON.stringify(upBody));

    const served = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif');
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check('and it comes back as an image, byte for byte',
      served.status === 200
      && served.headers.get('content-type') === 'image/gif'
      && servedBytes.equals(GIF_64));
    /* The card's src carries gifUtc, so this response may be cached hard.
     * It is the only one on the board that is not no-store. */
    check('and it is cacheable, which nothing else here is',
      /max-age=\d\d\d/.test(served.headers.get('cache-control') || ''),
      served.headers.get('cache-control'));

    const withArt = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    const roomRow = withArt.tracks.find((t) => t.id === 'trk-2b3c4d5e');
    const fieldRow = withArt.tracks.find((t) => t.id === 'trk-1a2b3c4d');
    check('the list says there is one, and does not carry it',
      roomRow.hasGif === true && Boolean(roomRow.gifUtc)
      && !JSON.stringify(roomRow).includes(GIF_64.toString('base64')));
    check('and a field track says there is not', fieldRow.hasGif === false);

    /*
     * A FIELD TRACK IS REFUSED ONE, and this is the rule rather than a
     * default: a sixty metre course has a plan worth drawing and public
     * plan.js draws it for nothing. Enforced in the board because a rule
     * enforced in the page is a rule the next publisher walks past.
     */
    const onField = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: 'whatever', gif: GIF_64.toString('base64') }),
    });
    check('a field track is refused an animation', onField.status === 400);

    const wrongKey = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: 'not-the-key', gif: GIF_64.toString('base64') }),
    });
    check('another browser cannot overwrite it', wrongKey.status === 403);

    const notAGif = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: roomKey, gif: Buffer.from('not a gif at all').toString('base64') }),
    });
    check('and a file that is not a GIF is refused', notAGif.status === 400);

    const tiny = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0]), Buffer.from([0x3b])]);
    const tooSmall = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: roomKey, gif: tiny.toString('base64') }),
    });
    check('and a one pixel GIF is refused', tooSmall.status === 400);

    /* The one way past the edit key, for the rooms published before any of
     * this existed. Unset, there is no such way. */
    const asAdmin = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ gif: GIF_64.toString('base64') }),
    });
    check('the admin token can upload without an edit key', asAdmin.status === 200);

    /*
     * A RELAYOUT THROWS IT AWAY AND A RENAME DOES NOT. It is a picture of a
     * layout, so it goes for the same reason the times go.
     */
    const renamedRoom = lapRoom();
    renamedRoom.name = 'The same room, renamed';
    const roomRenamed = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: renamedRoom, editKey: roomKey }),
    });
    check('a rename republishes the room', roomRenamed.status === 200);
    const afterRename = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('and the animation is still there',
      afterRename.tracks.find((t) => t.id === 'trk-2b3c4d5e').hasGif === true);

    const movedRoom = lapRoom();
    movedRoom.elements[1].position = { x: 1, y: 1.2, z: 0 };
    const roomMoved = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: movedRoom, editKey: roomKey }),
    });
    const movedBody = await roomMoved.json();
    check('moving a gate republishes and clears the times',
      roomMoved.status === 200 && movedBody.timesCleared === true, JSON.stringify(movedBody));
    const afterMove = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('and the animation goes with them, because it is a picture of the old layout',
      afterMove.tracks.find((t) => t.id === 'trk-2b3c4d5e').hasGif === false);
    const goneArt = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/gif');
    check('so the image is a 404 again', goneArt.status === 404);

    /* ---------------------------------------------------------------- */
    /* Taking a track off the board                                       */
    /* ---------------------------------------------------------------- */

    console.log('\ntaking a track off the board');

    /* A time on it first, because the point of the route is that the times
     * go with the track and the point of the gate is that the publisher
     * alone may not throw somebody else's away. */
    /* Against the room as it is on the board now, gate moved and all: a
     * lap flown through the old layout is exactly what the check refuses. */
    const roomNow = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/document').then((r) => r.json());
    const kiteLap = honestLap(roomNow.document, { speed: 6 });
    const kitePost = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo Kite', lapMs: kiteLap.lapMs, ghost: kiteLap.ghost }),
    });
    check('a lap in the micro room is accepted', kitePost.status === 201, `${kitePost.status} ${(await kitePost.clone().text()).slice(0, 120)}`);
    const beforeRemoval = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('the room is on the board, with a time on it',
      beforeRemoval.tracks.find((t) => t.id === 'trk-2b3c4d5e')?.times === 1);

    const noToken = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/remove', {
      method: 'POST',
    });
    check('a stranger cannot remove a track', noToken.status === 403);

    /* The edit key is NOT a way in, and this is the check that says so. The
     * browser that published it can change its layout and clear the times
     * that way; it cannot delete other pilots' records outright. */
    const withEditKey = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editKey: roomKey }),
    });
    check('and neither can the browser that published it', withEditKey.status === 403);

    /* An unauthorised caller learns nothing about which ids exist: the token
     * is checked before the id is, so a real id and a made up one answer
     * alike. */
    const madeUpId = await fetch('http://127.0.0.1:3199/api/tracks/trk-00000000/remove', {
      method: 'POST',
    });
    check('and an id that is not here answers the same way', madeUpId.status === 403);

    const missing = await fetch('http://127.0.0.1:3199/api/tracks/trk-00000000/remove', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    check('with the token, a track that is not here is a 404', missing.status === 404);

    const removed = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/remove', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const removedBody = await removed.json();
    check('the board\'s own token takes it off',
      removed.status === 200 && removedBody.times === 1,
      JSON.stringify(removedBody));
    check('and says what went, rather than echoing the id back',
      removedBody.name === 'Ladder Loop' && removedBody.author === 'Ada Rook',
      JSON.stringify(removedBody));

    const afterRemoval = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('the list no longer carries it',
      !afterRemoval.tracks.some((t) => t.id === 'trk-2b3c4d5e'));
    check('and the field track beside it is untouched',
      afterRemoval.tracks.some((t) => t.id === 'trk-1a2b3c4d'));
    const removedOne = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e');
    check('its detail is a 404', removedOne.status === 404);
    const removedDoc = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/document');
    check('and so is the document behind it', removedDoc.status === 404);

    /* The id is free again, which is what makes this the way to replace a
     * track somebody published from a browser nobody still has. */
    const republished = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: lapRoom() }),
    });
    check('and the id is free to publish again', republished.status === 201);

    /* ------------------------------------------------------------------ */
    console.log('\nsigning in');

    const wrongPassword = await fetch('http://127.0.0.1:3199/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'not it' }),
    });
    const wrongBody = await wrongPassword.json();
    check('a wrong password is refused', wrongPassword.status === 401);

    const stranger = await fetch('http://127.0.0.1:3199/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: ADMIN_PASSWORD }),
    });
    const strangerBody = await stranger.json();
    check('an address that is not on the list is refused', stranger.status === 401);
    /* The same sentence for both, so the route cannot be asked which
     * addresses are worth attacking. */
    check('and the two refusals say exactly the same thing',
      wrongBody.error === strangerBody.error, `${wrongBody.error} / ${strangerBody.error}`);

    const noSession = await fetch('http://127.0.0.1:3199/api/admin/session');
    check('with no token, the session route says nobody', noSession.status === 401);

    const signedIn = await fetch('http://127.0.0.1:3199/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      /* Mixed case and a stray space, the way a person types their own
       * address into a form. */
      body: JSON.stringify({ email: `  ${ADMIN_EMAIL.toUpperCase()} `, password: ADMIN_PASSWORD }),
    });
    const session = await signedIn.json();
    check('the right address and password sign in',
      signedIn.status === 200 && typeof session.token === 'string' && session.token.length > 40,
      JSON.stringify({ status: signedIn.status, error: session.error }));
    check('and the address comes back normalised', session.email === ADMIN_EMAIL);
    check('with a time it runs out', typeof session.expiresUtc === 'string' && session.expiresUtc.endsWith('Z'));

    const who = await fetch('http://127.0.0.1:3199/api/admin/session', {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((r) => r.json());
    check('the session route reads the token back', who.email === ADMIN_EMAIL && who.kind === 'session');

    const asToken = await fetch('http://127.0.0.1:3199/api/admin/session', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((r) => r.json());
    check('and answers for BOARD_ADMIN_TOKEN with no address',
      asToken.kind === 'token' && asToken.email === '');

    const tampered = await fetch('http://127.0.0.1:3199/api/admin/session', {
      headers: { authorization: `Bearer ${session.token.slice(0, -3)}zzz` },
    });
    check('a token with the signature changed is nobody', tampered.status === 401);

    /*
     * The point of all of it: a signed in person can do the thing that used
     * to need a string in an environment. The track republished above is
     * the one that goes.
     */
    const bySession = await fetch('http://127.0.0.1:3199/api/tracks/trk-2b3c4d5e/remove', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    });
    check('a signed in admin takes a track off the board', bySession.status === 200);
    const afterSession = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('and it is gone', !afterSession.tracks.some((t) => t.id === 'trk-2b3c4d5e'));

    /* The bugs inbox opens to an admin without a second secret. This server
     * runs with BUGS_TOKEN unset, so the useful half of that is the shape of
     * the answer rather than the gate; the gate itself is checked in the
     * unit half, where bugsAuthorized's two callers are one function. */
    const inboxByAdmin = await fetch('http://127.0.0.1:3199/api/bugs', {
      headers: { authorization: `Bearer ${session.token}` },
    });
    check('and reads the bugs inbox with the same token', inboxByAdmin.status === 200);

    /* ---------------------------------------------------------------- */
    /* Site statistics, over the wire                                     */
    /* ---------------------------------------------------------------- */

    console.log('\nsite statistics, over the wire');
    const B = 'http://127.0.0.1:3199';
    const post = (body, headers = {}) => fetch(`${B}/api/stats/events`, {
      method: 'POST',
      /* text/plain, because that is what a beacon sends and a beacon is
       * what the pages use: it cannot set a header, and a simple request
       * needs no preflight. If this route ever starts insisting on
       * application/json, every event from every page stops arriving and
       * nothing else would say so. */
      headers: { 'content-type': 'text/plain', ...headers },
      body: JSON.stringify(body),
    });

    const visit = await post({
      v: 1, kind: 'visit', surface: 'sim', returning: false, source: 'rotorriot',
    }, { 'x-fdfpv-country': 'AU' });
    check('a visit posted as text/plain is taken', visit.status === 204);
    check('and it answers with no body at all', (await visit.text()) === '');

    await post({ v: 1, kind: 'visit', surface: 'board', returning: true, source: 'not-a-sponsor' },
      { 'x-fdfpv-country': 'nonsense' });
    await post({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad' },
      { 'x-fdfpv-country': 'NZ' });
    await post({
      v: 1, kind: 'flush', tab: 'tab-11112222', craft: '5inch', map: 'custom', laps: 4, flightS: 61, crashes: 1,
    }, { 'x-fdfpv-country': 'AU' });

    /* Global Privacy Control. The same 204 an accepted event gets, on
     * purpose, and nothing counted. A different status would tell a script
     * whether the signal was seen. */
    const gpc = await post({ v: 1, kind: 'visit', surface: 'sim', returning: false }, { 'sec-gpc': '1' });
    check('a browser that asked not to be counted gets the same answer', gpc.status === 204);

    const badKind = await post({ v: 1, kind: 'pageview' });
    check('an event this board does not count is refused', badKind.status === 400);
    const badDelta = await post({ v: 1, kind: 'flush', tab: 'tab-11112222', craft: '5inch', laps: 900 });
    check('and so is a claim bigger than a minute', badDelta.status === 400);
    const notJson = await fetch(`${B}/api/stats/events`, { method: 'POST', body: 'not json at all' });
    check('and so is something that is not JSON', notJson.status === 400);

    const statsRes = await fetch(`${B}/api/stats`);
    const stats = await statsRes.json();
    check('the statistics read answers', statsRes.status === 200);
    /* The one response besides a card animation that is not no-store. A
     * hundred readers polling this should cost the database what one does. */
    check('and is cacheable for a short while',
      /max-age=\d+/.test(statsRes.headers.get('cache-control') || ''));
    check('the visit is on the board', stats.today.visits === 2);
    check('and the GPC one is not', stats.today.newVisitors === 1);
    check('the returning one moved its own column', stats.today.returningVisitors === 1);
    check('the session and its laps are counted',
      stats.today.sessions === 1 && stats.today.laps === 4 && stats.today.flightS === 61);
    check('the flying tab is counted as flying now', stats.live.flying === 1);
    check('the window is thirty days', stats.days.length === 30);

    const sourceRow = (key) => stats.sources.find((r) => r.key === key) || {};
    check("a real sponsor keeps its own row", sourceRow('rotorriot').visits === 1);
    check('and travels with the name the board prints', sourceRow('rotorriot').name === 'Rotor Riot');
    check('a source this board never heard of folds into other', sourceRow('not-a-sponsor').visits === undefined
      && sourceRow('other').visits === 1);
    const countryRow = (key) => stats.countries.find((r) => r.key === key) || {};
    check('the country from the edge is counted', countryRow('AU').visits === 1);
    check('and a header that is not a country is unknown', countryRow('ZZ').visits === 1);

    /*
     * Cloudflare's own header is read when the Worker's is absent, which is
     * a Worker from before it learned to set one. Posted as flushes with a
     * lap in them, because a lap moves the country row and a visit has
     * already been spent on this browser's day above. Read back after the
     * cache has aged out, since the read above was built before these.
     */
    await post({
      v: 1, kind: 'flush', tab: 'tab-cf-1', craft: '5inch', map: 'custom', laps: 1,
    }, { 'cf-ipcountry': 'NZ' });
    await post({
      v: 1, kind: 'flush', tab: 'tab-cf-2', craft: '5inch', map: 'custom', laps: 1,
    }, { 'cf-ipcountry': 'NZ', 'x-fdfpv-country': 'FR' });
    await new Promise((r) => setTimeout(r, 20_100));
    const later = await fetch(`${B}/api/stats`).then((r) => r.json());
    const laterRow = (key) => later.countries.find((r) => r.key === key) || {};
    check("Cloudflare's own country header is read when the Worker's is absent", laterRow('NZ').laps === 1);
    check("and the Worker's header wins when both are present", laterRow('FR').laps === 1);

    /* The four numbers off the board's own tables. Two tracks were
     * published above and one was removed, so one is left. */
    /* Checked against the live list rather than against a number written
     * here: the count is whatever this suite has published and removed by
     * now, and a hardcoded one would have to be edited every time a check
     * above it published another track. What matters is that the two
     * agree. Nothing mutates tracks between the read above and this one. */
    const live = await fetch(`${B}/api/tracks`).then((r) => r.json());
    const namedPilots = new Set(
      live.tracks.flatMap((t) => (t.best ? [String(t.best.name).toLowerCase()] : [])),
    );
    check('the board facts count the tracks that are actually on the board',
      stats.board.tracks === live.tracks.length);
    check('and the times posted on them',
      stats.board.times === live.tracks.reduce((sum, t) => sum + (t.times || 0), 0));
    check('and at least the pilots holding a record', stats.board.pilots >= namedPilots.size);
    check('and nobody has been back another day inside one test run',
      stats.board.pilotsOnMoreThanOneDay === 0);

    /* The flood gate. Its allowance is 600 in ten minutes, which is fifty
     * pilots behind one address each flushing once a minute, and this spends
     * the rest of it. Every one of these is a file write, so it is the slow
     * part of this suite and it is worth exactly what it costs. */
    let flooded = 0;
    const ATTEMPTS = 660;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      /* eslint-disable-next-line no-await-in-loop */
      const r = await post({ v: 1, kind: 'flush', tab: `tab-flood-${i}`, craft: '5inch', flightS: 1 });
      if (r.status === 429) {
        flooded += 1;
      }
    }
    check('an address that posts hundreds of events is shut off', flooded > 0);

    /* And it closed AFTER a room's worth went through, not before: at least
     * five hundred of these landed. A refused event never spends the
     * allowance, which is why the junk posted above did not bring the gate
     * forward. */
    check('the gate closed after the allowance rather than before it', ATTEMPTS - flooded >= 500);

    /* The one thing an admin gets that the public page does not: the list
     * of sponsors, with the link each one is given. */
    const panel = await fetch(`${B}/api/admin/session`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((r) => r.json());
    check('a signed in admin is handed the sponsor links',
      Array.isArray(panel.sponsors) && panel.sponsors.length === 1);
    check('and the link points at the simulator with the slug on it',
      panel.sponsors[0].link === 'http://127.0.0.1:8000/?utm_source=rotorriot&utm_medium=sponsor');
    const anon = await fetch(`${B}/api/stats`).then((r) => r.json());
    check('the public read does not carry the list of sponsors',
      anon.sponsors === undefined);
  } finally {
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}


/*
 * The links a visitor clicks must be right whether or not /api/config
 * answers. bindLinks used to run only after that request came back, so one
 * failure left every cross-origin href on the loopback address baked into
 * the HTML. app.js itself cannot be imported here, it touches `document` at
 * module load, which is why the resolution lives in public/origins.js.
 */
function testOrigins() {
  console.log('\norigins, without asking the server');

  const at = (href) => {
    const u = new URL(href);
    /* HERE in app.js: this page's own directory. */
    return [u, new URL('./', href)];
  };

  check('a checkout on 127.0.0.1 finds the simulator on 8000',
    guessSimOrigin(...at('http://127.0.0.1:3180/')) === 'http://127.0.0.1:8000');
  check('localhost by name, same answer',
    guessSimOrigin(...at('http://localhost:3180/')) === 'http://localhost:8000');
  check('a track hash does not change the answer',
    guessSimOrigin(...at('http://127.0.0.1:3180/#course=trk-1a2b3c4d')) === 'http://127.0.0.1:8000');

  check('the /board mount finds its sibling /sim',
    guessSimOrigin(...at('https://fdfpv.example/board/')) === 'https://fdfpv.example/sim');
  check('the bug page under the mount answers the same',
    guessSimOrigin(...at('https://fdfpv.example/board/bugs')) === 'https://fdfpv.example/sim');

  /*
   * The one case that cannot be derived, and must NOT be guessed: a board
   * on its own host. Returning a loopback address here is the defect this
   * whole file exists to close, so null is the right answer and app.js
   * leaves those links alone until /api/config says otherwise.
   */
  check('a board on its own host declines to guess',
    guessSimOrigin(...at('https://fdfpv-board.onrender.com/')) === null);
  check('a public host at the root declines to guess',
    guessSimOrigin(...at('https://fdfpv.example/')) === null);

  check('a missing location is not a crash', guessSimOrigin(null, null) === null);

  /*
   * The front door, which is asked in every case rather than declining in
   * the one that cannot be derived. A board somewhere this file has never
   * heard of still belongs to the landing page named in origins.js, so the
   * mark in the masthead has somewhere to go from anywhere.
   */
  check('a checkout on 127.0.0.1 finds the front door on 8080',
    landingOrigin(...at('http://127.0.0.1:3180/')) === 'http://127.0.0.1:8080');
  check('localhost by name, same answer',
    landingOrigin(...at('http://localhost:3180/')) === 'http://localhost:8080');
  check('the /board mount hangs off the front door',
    landingOrigin(...at('https://fdfpv.example/board/')) === 'https://fdfpv.example');
  check('the bug page under the mount answers the same',
    landingOrigin(...at('https://fdfpv.example/board/bugs')) === 'https://fdfpv.example');
  check('a board on its own host names the front door rather than declining',
    landingOrigin(...at('https://fdfpv-board.onrender.com/'))
      === 'https://fdflabs.github.io/fdfpv');
  check('a missing location still answers', landingOrigin(null, null) === 'https://fdflabs.github.io/fdfpv');

  check('loopback set covers the hosts a checkout uses',
    isLoopback('127.0.0.1') && isLoopback('localhost') && isLoopback('::1')
      && !isLoopback('fdfpv.example'));
}

/*
 * The whitelist, the password check and the session token, without a server.
 *
 * The module reads BOARD_ADMINS once, at import, so it is imported here
 * rather than at the top of the file: first with the variable unset, to
 * check that the repository ships nobody, then with the selftest's own
 * address, for the password and session checks. The second import is a
 * different URL so the module cache does not hand back the first.
 */
async function testAdmin() {
  console.log('\nadmin');

  delete process.env.BOARD_ADMINS;
  const shipped = await import('./admin.js?shipped');
  check('the board ships no admin address',
    shipped.adminEmails().length === 0, shipped.adminEmails().join(', '));
  check('so nobody signs in until BOARD_ADMINS names somebody',
    shipped.checkPassword('anyone@example.com', 'anything at all') === null);

  process.env.BOARD_ADMINS = `${ADMIN_EMAIL}:plain:${ADMIN_PASSWORD}`;
  const {
    adminEmails, checkPassword, mintSession, normaliseEmail, readSession,
  } = await import('./admin.js?selftest');
  check('BOARD_ADMINS is the whole list',
    adminEmails().length === 1 && adminEmails()[0] === ADMIN_EMAIL, adminEmails().join(', '));

  check('an address is lowercased and trimmed',
    normaliseEmail('  Someone@Example.COM ') === 'someone@example.com');
  check('and something that is not an address is nothing',
    normaliseEmail('not an address') === '' && normaliseEmail('a@b') === ''
      && normaliseEmail(null) === '' && normaliseEmail('x:y@example.com') === '');

  check('a wrong password does not open the entry',
    checkPassword(ADMIN_EMAIL, 'not it') === null);
  check('an empty password does not open it either',
    checkPassword(ADMIN_EMAIL, '') === null);
  check('an address that is not on the list is refused whatever it brings',
    checkPassword('stranger@example.com', ADMIN_PASSWORD) === null);
  check('the right address and password open it',
    checkPassword(ADMIN_EMAIL, ADMIN_PASSWORD) === ADMIN_EMAIL);

  const token = mintSession(ADMIN_EMAIL);
  const read = readSession(token);
  check('a session token reads back as the address that minted it',
    read && read.email === ADMIN_EMAIL);
  check('and carries when it runs out',
    read && typeof read.expiresUtc === 'string' && read.expiresUtc.endsWith('Z'));

  check('a token with its signature changed is nobody',
    readSession(`${token.slice(0, -2)}zz`) === null);
  check('a token with its payload changed is nobody',
    readSession(`v1.${Buffer.from(JSON.stringify({ e: ADMIN_EMAIL, x: Date.now() + 9e6 })).toString('base64url')}.${token.split('.')[2]}`) === null);
  check('an expired token is nobody',
    readSession(mintSession(ADMIN_EMAIL, { ms: -1000 })) === null);
  /* The whitelist is checked on every read, not only at sign in, so an
   * address taken out of BOARD_ADMINS is locked out at once rather than
   * when its token happens to run out. */
  check('a token for an address that is not on the list is nobody',
    readSession(mintSession('gone@example.com')) === null);
  check('junk is nobody',
    readSession('') === null && readSession('v1.a.b') === null
      && readSession(null) === null && readSession('v2.a.b') === null);
}

/*
 * The statistics wire format, the sponsor fold and the counters.
 *
 * What this suite is really checking is a PROMISE rather than a feature:
 * the page says nothing identifying is accepted or stored, and these are
 * the checks that would fail if that stopped being true. The ones about
 * closed vocabularies matter for the same reason from the other side: they
 * are what stops a stranger with curl growing a table on a public page.
 */
async function testStats() {
  console.log('\nsite statistics');

  const ok = (body) => inspectStatsEvent(body, sourceKey);

  check('a visit is accepted', !ok({
    v: 1, kind: 'visit', surface: 'sim', returning: false,
  }).error);
  check('a session is accepted', !ok({
    v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad',
  }).error);
  check('a flush is accepted', !ok({
    v: 1, kind: 'flush', tab: 'aaaa1111', craft: 'whoop65', laps: 2, flightS: 44,
  }).error);

  check('a version this board does not read is refused', Boolean(ok({ v: 2, kind: 'visit' }).error));
  check('an unknown kind is refused', Boolean(ok({ v: 1, kind: 'pageview' }).error));
  check('a visit from an unknown page is refused', Boolean(ok({
    v: 1, kind: 'visit', surface: 'somewhere', returning: false,
  }).error));
  check('a visit with no new-or-returning answer is refused', Boolean(ok({
    v: 1, kind: 'visit', surface: 'sim',
  }).error));
  check('an aircraft this board does not count is refused', Boolean(ok({
    v: 1, kind: 'session', craft: 'tinywhoop', map: 'custom', input: 'gamepad',
  }).error));
  check('a long tab handle is refused', Boolean(ok({
    v: 1, kind: 'flush', tab: 'x'.repeat(200), craft: '5inch',
  }).error));
  check('a tab handle with punctuation in it is refused', Boolean(ok({
    v: 1, kind: 'flush', tab: 'aaaa1111;DROP', craft: '5inch',
  }).error));
  check('more laps than a minute can hold is refused', Boolean(ok({
    v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 31,
  }).error));
  check('more flight seconds than a minute can hold is refused', Boolean(ok({
    v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', flightS: 91,
  }).error));
  check('a negative delta is refused', Boolean(ok({
    v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: -3,
  }).error));

  /* A map or an input from a NEWER simulator folds rather than being
   * refused, and that is the difference between the two kinds of
   * vocabulary here: refusing a new map would mean an older board silently
   * dropping every session once the simulator gained one. */
  const newMap = ok({
    v: 1, kind: 'session', craft: '5inch', map: 'bando', input: 'gamepad',
  });
  check('a map this board has not heard of folds to other', newMap.event.map === 'other');
  const newInput = ok({
    v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'eye-tracker',
  });
  check('an input this board has not heard of folds to other', newInput.event.input === 'other');

  /* Nothing identifying survives the gate, because there is nowhere for it
   * to go: the event that comes out has exactly the fields the store reads. */
  const smuggled = ok({
    v: 1,
    kind: 'visit',
    surface: 'sim',
    returning: true,
    ip: '203.0.113.7',
    ua: 'Mozilla/5.0',
    pilot: 'Ada Rook',
    referrer: 'https://example.com/',
  }).event;
  check('nothing but the counted fields comes out of a visit',
    Object.keys(smuggled).sort().join(',') === 'kind,returning,source,surface');
  const flushed = ok({
    v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 1, name: 'Ada Rook',
  }).event;
  check('nothing but the counted fields comes out of a flush',
    Object.keys(flushed).sort().join(',') === 'craft,crashes,flightS,kind,laps,map,source,tab');

  /* The sponsor fold. This process has no BOARD_SPONSORS set, so every
   * named source is unknown to it, which is the case that matters: the
   * table cannot be grown by inventing one. */
  check('no source at all is direct', sourceKey(undefined) === 'direct');
  check('an empty source is direct', sourceKey('') === 'direct');
  check('a source this board never heard of is other', sourceKey('rotorriot') === 'other');
  check('and so is a hundred of them', new Set(
    Array.from({ length: 100 }, (_, i) => sourceKey(`sponsor-${i}`)),
  ).size === 1);
  check('a source is folded before it is stored',
    ok({ v: 1, kind: 'visit', surface: 'sim', returning: false, source: 'made-up' }).event.source === 'other');

  /* The country, which is two letters from the edge or nothing at all. */
  check('a country code is taken as it comes', normaliseCountry('AU') === 'AU');
  check('and lower case is the same country', normaliseCountry('au') === 'AU');
  check('rubbish is unknown', normaliseCountry('not-a-country') === 'ZZ');
  check('an absent header is unknown', normaliseCountry(undefined) === 'ZZ');
  check("the edge's own 'no country' is unknown", normaliseCountry('XX') === 'ZZ');
  check('a Tor exit is unknown', normaliseCountry('T1') === 'ZZ');
  check('an address is never a country', normaliseCountry('203.0.113.7') === 'ZZ');

  /* The day is the SERVER's UTC day. A browser cannot name it, and a host
   * that moves region must not move the boundary. */
  check('the day is the UTC day', statsDay(new Date('2026-09-21T23:59:59Z')) === '2026-09-21');
  check('and one second later is the next one', statsDay(new Date('2026-09-22T00:00:01Z')) === '2026-09-22');

  /* The counters themselves, against the file store. */
  const dir = await mkdtemp(join(tmpdir(), 'fdfpv-stats-'));
  try {
    process.env.BOARD_FILE = join(dir, 'board.json');
    const store = await openStore();
    const now = Date.parse('2026-09-21T12:00:00Z');
    const day = '2026-09-21';
    const before = '2026-09-20';
    const put = (body, at = day, country = 'AU') => store.recordStats(ok(body).event, { day: at, country });

    await put({ v: 1, kind: 'visit', surface: 'sim', returning: false });
    await put({ v: 1, kind: 'visit', surface: 'board', returning: true });
    await put({ v: 1, kind: 'visit', surface: 'sim', returning: true }, day, 'NZ');
    await put({ v: 1, kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad' });
    await put({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 3, flightS: 58, crashes: 1 });
    await put({ v: 1, kind: 'flush', tab: 'aaaa1111', craft: '5inch', laps: 2, flightS: 41, crashes: 2 });
    await put({ v: 1, kind: 'flush', tab: 'bbbb2222', craft: 'whoop65', laps: 4, flightS: 60 }, before, 'ZZ');

    const read = await store.readStats({ days: 7, now });
    check('a new browser moves the new column only',
      read.today.newVisitors === 1 && read.today.returningVisitors === 2);
    check('and both are counted as pilots', read.today.visits === 3);
    check('two flushes add up rather than replacing',
      read.today.laps === 5 && read.today.flightS === 99 && read.today.crashes === 3);
    check('a session is counted once', read.today.sessions === 1);
    check('yesterday stays on yesterday', read.days[read.days.length - 2].laps === 4);
    check('the window is as many days as it was asked for', read.days.length === 7);
    check('and the days are consecutive and end today',
      read.days[0].day === '2026-09-15' && read.days[6].day === day);
    check('a day nobody visited is a nought rather than a gap',
      read.days[0].visits === 0 && read.days[0].laps === 0);
    check('the window sums both days', read.window.laps === 9 && read.window.visits === 3);

    const country = (key) => read.countries.find((r) => r.key === key) || {};
    check('the country a visit came from is counted', country('AU').visits === 2);
    check('and a second country is its own row', country('NZ').visits === 1);
    check('laps are counted against the country that flew them', country('AU').laps === 5);
    check('two named countries are two countries', read.window.countries === 2);
    check('unknown is not one of them',
      read.countries[read.countries.length - 1].key === 'ZZ');

    check('the aircraft is counted from the session', (read.craft.find((r) => r.key === '5inch') || {}).sessions === 1);
    check('and its laps from the flushes', (read.craft.find((r) => r.key === '5inch') || {}).laps === 5);
    check('the input is counted', (read.inputs.find((r) => r.key === 'gamepad') || {}).sessions === 1);
    check('the page a visit came from is counted',
      (read.surfaces.find((r) => r.key === 'sim') || {}).visits === 2);

    /* A heartbeat with nothing in it moves the day's flight seconds and
     * touches no dimension at all. That is what keeps the dims table
     * proportional to the flying rather than to the sitting. */
    const dimsBefore = JSON.stringify(read.craft);
    await put({ v: 1, kind: 'flush', tab: 'cccc3333', craft: '5inch', laps: 0, flightS: 30 });
    const after = await store.readStats({ days: 7, now });
    check('a heartbeat with no laps counts its seconds', after.today.flightS === 129);
    check('and adds no dimension row', JSON.stringify(after.craft) === dimsBefore);

    check('all time is every day there has ever been', after.allTime.laps === 9);
    check('and it knows when counting started', after.firstDay === before);

    /* The board's own tables, which are not counters and never were. */
    await store.publish({ inspected: inspectDocument(sampleDoc()), author: 'Ada Rook', editKey: 'k' });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'Ada Rook', lapMs: 29110 });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'ada rook', lapMs: 28110 });
    await store.addTime({ trackId: 'trk-1a2b3c4d', name: 'Bo', lapMs: 31000 });
    const facts = await store.boardFacts();
    check('the board counts its own tracks and times', facts.tracks === 1 && facts.times === 3);
    check('a pilot who capitalises differently is one pilot', facts.pilots === 2);
    check('and nobody has been back another day yet', facts.pilotsOnMoreThanOneDay === 0);
  } finally {
    delete process.env.BOARD_FILE;
    await rm(dir, { recursive: true, force: true });
  }
}

testOrigins();
await testAdmin();
await testValidate();
await testStore();
await testStats();
await testHttp();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
