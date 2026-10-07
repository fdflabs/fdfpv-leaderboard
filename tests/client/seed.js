/*
 * seed.js: a board with something on every surface the page draws.
 *
 * Tracks of every class (a field with a logo and tags, a field of mixed
 * furniture, a room with a designer credit, a fixed wing airfield, a
 * plane ring in a world), times on all but the room flown by three pilots with real
 * signatures and ghosts from the simulator's own lap generator, freestyle
 * runs, bug tickets and statistics events. Everything goes in through the
 * public API, so the board on disk is one the server itself wrote.
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
import { syntheticLapBytes } from '../../vendor/fdfpv/tests/lib/synthlap.js';
import { mapTrackDocument } from '../../vendor/fdfpv/tests/lib/maptrack.js';
import { createIdentity, memoryStorage } from '../../vendor/fdfpv/src/share/identity.js';

/* A 96 by 64 GIF: big enough for the board's size rule, small enough to
 * keep here. */
const ROOM_GIF = 'R0lGODdhYABAAIEAABAWEX3/tP/UXAAAACwAAAAAYABAAEAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpzIMIDFixgzatx4kaLHjwI5ihyJ0aGAkyhTqlwJ8iDJlxwTrpxJs6aAlgBg6iwp06bPmThz7twJ8afKoEiTKl3KtKnHoUSdMoWq0yNQqSGpvlxotCtSrVsRdh17EidYkgzJ1sTKtq3bt3Djyp1LN+LZkXUp3hWZd+LemH3t/tVYlGzTwYS5qr0aFHFGhYt9NnbcUWxkyS0pVz54GTNIzRYVd075FbTJy0tBB7DKMrDr17Bjy55Nu7bt27hz646revfA3r6Fag4unDJx4L6RPzQqVblow6lNpx2t1LnB0UcnD++JnbRZ6Za7oz3Ubjy8+PGZwV8/7/2z+oLs23+0TjD+ze/bzYsn7/g59tL5QUZdUvTp51V0AZ7mGXEMNujggxBGKOGEEgYEADs=';
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPoeXYYAAQ3AjaAIZITAAAAAElFTkSuQmCC';

const gate = (id, x, y, yaw = 0, dims = {}) => ({
  id, type: 'gate', name: 'Gate', position: { x, y, z: 0 }, yaw, pitch: 0, yawOverridden: false,
  dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1, ...dims },
});
const step = (n, elementId) => ({ id: `sq-${n}`, elementId, apertureIndex: 0, entry: 1 });

function fieldTrack(id, name, elements, flown, extra = {}) {
  return {
    schemaVersion: 3, id, name, trackClass: 'full',
    createdUtc: '2026-09-01T00:00:00Z', modifiedUtc: '2026-09-01T00:00:00Z',
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 1.1, minCurveRadius: 2.5, samplesPerSegment: 48 },
    branding: { logos: [] }, credit: null,
    elements, sequence: flown.map((elId, i) => step(i + 1, elId)),
    ...extra,
  };
}

const costanera = fieldTrack('trk-c11e0001', 'Costanera Sprint', [gate('el-1', 12, 10), gate('el-2', 40, 26)], ['el-1', 'el-2'], {
  branding: { logos: [{ id: 'lg-1', image: LOGO, name: 'sponsor.png' }] },
});

const furniture = fieldTrack('trk-c11e0002', 'Mburucuya Ladder', [
  { id: 'el-1', type: 'startPads', position: { x: 6, y: 20, z: 0 }, yaw: 0, dims: { pads: 4, spacing: 1.5, padSize: 0.6 } },
  gate('el-2', 18, 20),
  { id: 'el-3', type: 'ladder', position: { x: 30, y: 30, z: 0 }, yaw: 0.4, dims: { clearW: 1.524, clearH: 1.524, levels: 3 } },
  { id: 'el-4', type: 'barrier', position: { x: 44, y: 14, z: 0 }, yaw: 1.2, dims: { width: 12, depth: 0.5 } },
  { id: 'el-5', type: 'waypoint', position: { x: 50, y: 30, z: 0 }, yaw: 0, dims: {} },
  { id: 'el-6', type: 'flag', position: { x: 36, y: 8, z: 0 }, yaw: 0, dims: { clearance: 1 } },
  gate('el-7', 24, 6, -0.6),
], ['el-2', 'el-3', 'el-5', 'el-6', 'el-7', 'el-2']);

const room = {
  ...fieldTrack('trk-c11e0003', 'Living Room Loop', [
    { id: 'el-1', type: 'startPads', position: { x: 0, y: 1.5, z: 0 }, yaw: 0, dims: { pads: 1, spacing: 0.3, padSize: 0.1 } },
    { id: 'el-2', type: 'gate', position: { x: 0, y: 0.6, z: 0 }, yaw: 0, dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 } },
    { id: 'el-3', type: 'gate', position: { x: 2, y: 0.6, z: 0 }, yaw: 0, dims: { clearW: 0.7112, clearH: 0.7112, sillH: 0, levels: 1 } },
  ], ['el-2', 'el-3']),
  trackClass: 'micro',
  field: { width: 5, depth: 6, gridSize: 0.0254 },
  credit: { designer: 'Skittles', series: 'RaceGOW5' },
};

const airfield = {
  ...fieldTrack('trk-c11e0004', 'Airfield Loop', [
    gate('el-1', 100, 75, 0, { clearW: 5, clearH: 5, levelPitch: 5.0334 }),
    gate('el-2', 300, 75, 0.643501, { clearW: 5, clearH: 5, levelPitch: 5.0334 }),
    gate('el-3', 300, 225, 2.498092, { clearW: 5, clearH: 5, levelPitch: 5.0334 }),
    gate('el-4', 100, 225, 3.141593, { clearW: 5, clearH: 5, levelPitch: 5.0334 }),
  ], ['el-1', 'el-2', 'el-3', 'el-4']),
  trackClass: 'wing',
  field: { width: 400, depth: 300, gridSize: 5 },
  settings: { tangentScale: 1.1, minCurveRadius: 20, samplesPerSegment: 48 },
};

const ring = mapTrackDocument({
  id: 'trk-c11e0005', name: 'Wide ring', radius: 70, types: ['wideGate5', 'pylonPair', 'wideGate3'],
});

function lap(document, opts = {}) {
  const l = syntheticLapBytes(document, opts);
  return { ghost: Buffer.from(l.bytes).toString('base64'), lapMs: Math.round(l.lapMs) };
}

export async function seedBoard(origin) {
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`seed: ${path} answered ${r.status}: ${await r.text()}`);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
  const pilots = {
    Lapacho: createIdentity(memoryStorage()),
    Tatu: createIdentity(memoryStorage()),
    Carpincho: createIdentity(memoryStorage()),
  };
  const time = async (track, name, flown, craft, extra = {}) => {
    const auth = await pilots[name].signTime({ trackId: track.id, lapMs: flown.lapMs, ghost: flown.ghost, ...(craft ? { craft } : {}) });
    return post(`/api/tracks/${track.id}/times`, {
      name, lapMs: flown.lapMs, ghost: flown.ghost, key: auth.key, sig: auth.sig, ...(craft ? { craft } : {}), ...extra,
    });
  };

  await post('/api/tracks', { author: 'Lapacho', document: costanera, tags: ['race', 'beginner'] });
  await post('/api/tracks', { author: 'Tatu', document: furniture, tags: ['technical'] });
  /* The first publish hands back the edit key its browser would keep. */
  const { editKey } = await post('/api/tracks', { author: 'Carpincho', document: room });
  await post(`/api/tracks/${room.id}/gif`, { gif: ROOM_GIF, editKey });
  await post('/api/tracks', { author: 'Tatu', document: airfield, tags: ['big'] });
  await post('/api/tracks', { author: 'Lapacho', document: ring });

  await time(costanera, 'Lapacho', lap(costanera));
  await time(costanera, 'Tatu', lap(costanera, { speed: 15 }));
  await time(costanera, 'Carpincho', lap(costanera, { speed: 12 }));
  /* No time on the room: the simulator refuses every lap on a RaceGOW
   * room since its 65 mm whoop went, so the API can no longer take one. */
  await time(airfield, 'Tatu', lap(airfield, { speed: 20 }));
  await time(ring, 'Lapacho', lap(ring, { speed: 18 }), 'sky1800');
  await time(ring, 'Tatu', lap(ring, { speed: 24 }), 'timber1500f');

  const run = (name, score, map, style) => ({
    name, map, style, score, durationMs: 120000, tricks: 40, unique: 12, bestCombo: Math.floor(score / 3),
    bestTrick: 850, crashes: 2, signature: 'Matty flip',
  });
  await post('/api/runs', run('Lapacho', 25000, 'alps', 'expert'));
  await post('/api/runs', run('Tatu', 31200, 'swiss2', 'arcade'));

  await post('/api/bugs', {
    kind: 'visual', title: 'Gate flickers at dusk', what: 'The third gate flickers when the sun is low over the lake.',
    reporter: 'Tatu', context: { map: 'alps' }, images: [LOGO.split(',')[1]],
  });
  await post('/api/bugs', {
    kind: 'crash', title: 'Tab froze after a reset', what: 'Pressing reset twice in a row froze the whole tab for me.',
  });

  const events = [
    [{ v: 1, kind: 'visit', surface: 'sim', returning: false }, 'PY'],
    [{ v: 1, kind: 'visit', surface: 'board', returning: true }, 'AR'],
    [{ v: 1, kind: 'visit', surface: 'builder', returning: false }, 'PY'],
    [{ v: 1, kind: 'session', craft: 'sky1800', map: 'custom', input: 'gamepad' }, 'BR'],
    [{ v: 1, kind: 'session', craft: '5inch', map: 'city', input: 'keyboard' }, 'PY'],
    [{ v: 1, kind: 'flush', tab: 'aaaa1111bbbb', craft: 'sky1800', map: 'custom', laps: 3, flightS: 55, crashes: 1 }, 'PY'],
  ];
  for (const [body, country] of events) {
    await post('/api/stats/events', body, { 'x-fdfpv-country': country });
  }
  return { tracks: [costanera, furniture, room, airfield, ring].map((t) => t.id) };
}
