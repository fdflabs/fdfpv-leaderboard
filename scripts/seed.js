/*
 * seed.js: publish a few tracks to a local board, so the page has cards.
 *
 *   node scripts/seed.js              (board at http://127.0.0.1:3180)
 *   BOARD_ORIGIN=http://127.0.0.1:4000 node scripts/seed.js
 *
 * Tracks only. A time on the board needs the ghost and the signature the
 * simulator records with every lap, and the board checks the lap against
 * the track before taking it, so made up times would be refused, and a
 * seed that pretended otherwise would leave a page looking emptier than
 * its output claimed. Fly them from the simulator to put times on them.
 *
 * Each track carries a logo because the card draws one, and a seed that
 * left that path cold would hide a broken logo until somebody published
 * for real.
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

const board = (process.env.BOARD_ORIGIN || 'http://127.0.0.1:3180').replace(/\/+$/, '');

/* A 1x1 mint pixel: the smallest logo the builder could have attached. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPoeXYYAAQ3AjaAIZITAAAAAElFTkSuQmCC';

const GATE_DIMS = { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 };
const PAD_DIMS = { width: 2.4, depth: 0.6 };

/*
 * A track as the builder saves it, schema 1. `stands` is the field in
 * metres, x across and y up the page; every element after the pads is
 * flown in the order given.
 */
function trackDocument({ id, name, field, stands }) {
  const elements = stands.map(([type, x, y, yaw = 0], n) => ({
    id: `el-${n + 1}`,
    type,
    name: type,
    position: { x, y, z: 0 },
    yaw,
    dims: type === 'startPads' ? PAD_DIMS : GATE_DIMS,
  }));
  const flown = elements.filter((e) => e.type !== 'startPads');
  return {
    schemaVersion: 1,
    id,
    name,
    createdUtc: '2026-10-06T00:00:00Z',
    modifiedUtc: '2026-10-06T00:00:00Z',
    field: { width: field[0], depth: field[1], gridSize: 1 },
    settings: { tangentScale: 0.4, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: { logo: PIXEL, logoName: 'seed.png' },
    elements,
    sequence: flown.map((e, n) => ({ id: `seq-${n + 1}`, elementId: e.id, apertureIndex: 0, entry: 1 })),
  };
}

const SEEDS = [
  {
    author: 'Lapacho',
    id: 'trk-5eed0a01',
    name: 'Costanera Run',
    field: [70, 30],
    stands: [
      ['startPads', 6, 15],
      ['gate', 20, 15],
      ['gate', 34, 22, 0.5],
      ['diveGate', 50, 15],
      ['gate', 62, 8, -0.6],
      ['doubleStack', 40, 6],
    ],
  },
  {
    author: 'Tatu',
    id: 'trk-5eed0a02',
    name: 'Yacare Hairpin',
    field: [40, 40],
    stands: [
      ['startPads', 20, 4, 1.57],
      ['gate', 20, 14],
      ['flaggedGate', 30, 26, 0.9],
      ['gate', 20, 34],
      ['gate', 10, 26, -0.9],
    ],
  },
  {
    author: 'Carpincho',
    id: 'trk-5eed0a03',
    name: 'Chaco Straight',
    field: [90, 20],
    stands: [
      ['startPads', 5, 10],
      ['gate', 25, 10],
      ['gate', 45, 10],
      ['doubleStack', 65, 10],
      ['gate', 85, 10],
    ],
  },
];

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.url} answered ${response.status}: ${body.error || 'no message'}`);
  }
  return body;
}

let refused = 0;
for (const seed of SEEDS) {
  try {
    const published = await json(await fetch(`${board}/api/tracks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: seed.author, document: trackDocument(seed) }),
    }));
    const stored = await json(await fetch(`${board}/api/tracks/${published.id}/document`));
    const logo = stored.document?.branding?.logo ? 'logo kept' : 'logo MISSING';
    console.log(`published ${published.name} (${published.id}), ${logo}`);
  } catch (err) {
    refused += 1;
    console.error(`${seed.name}: ${err.message}`);
  }
}
console.log('No times: fly these from the simulator to put times on them.');
process.exit(refused ? 1 : 0);
