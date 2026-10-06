/*
 * plans.js: a sheet of track plans for public/plan.js to draw.
 *
 * Generated documents of every class with every element type, turned into
 * plans by the server's own planFromDocument, so the drawer sees exactly
 * the shapes the API serves. Seeded, so the sheet is the same every run.
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
import { planFromDocument } from '../../src/validate.js';

const TYPES = [
  'gate', 'flaggedGate', 'doubleStack', 'flaggedDoubleStack', 'ladder', 'tower', 'diveGate', 'barrier', 'flag',
  'cone', 'waypoint', 'pole', 'horizontalPole', 'startPads', 'label', 'groundLogo', 'mystery',
];
const WORLD_TYPES = ['gate', 'wideGate5', 'pylonPair', 'pylon', 'hoop250', 'ladder'];

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planSheet() {
  const r = prng(7);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const num = (lo, hi) => Number((lo + r() * (hi - lo)).toFixed(2));
  const items = [];
  const classes = [
    { trackClass: 'full', field: [60, 40] }, { trackClass: 'micro', field: [5, 6] },
    { trackClass: 'wing', field: [400, 300] }, { trackClass: 'full', field: [90, 20] },
  ];
  for (let n = 0; n < 20; n += 1) {
    const cls = classes[n % classes.length];
    const [w, d] = cls.field;
    const elements = Array.from({ length: 3 + Math.floor(r() * 9) }, (_, i) => {
      const type = pick(TYPES);
      const dims = {};
      if (r() < 0.6) {
        dims.levels = pick([1, 2, 3, 5]);
      }
      if (r() < 0.6) {
        dims.clearW = pick([1.524, 0.711, 5, 3]);
      }
      if (type === 'barrier' || type === 'horizontalPole') {
        dims.width = pick([2, 8, 20]);
        dims.depth = pick([0.3, 1]);
      }
      if (type === 'startPads') {
        Object.assign(dims, { pads: pick([1, 4]), spacing: pick([0, 1.5]), padSize: pick([0.1, 0.6]) });
      }
      return { id: `el-${i + 1}`, type, position: { x: num(0, w), y: num(0, d), z: 0 }, yaw: num(-3, 3), dims };
    });
    const flown = elements.filter(() => r() < 0.8);
    if (flown.length && r() < 0.3) {
      flown.push(flown[0], flown[0]);
    }
    const doc = {
      schemaVersion: 3, trackClass: cls.trackClass, field: { width: w, depth: d },
      elements, sequence: flown.map((el, i) => ({ id: `sq-${i}`, elementId: el.id })),
    };
    items.push({ name: `Plan ${n + 1}`, gates: flown.length, plan: planFromDocument(doc) });
  }
  for (let n = 0; n < 4; n += 1) {
    const elements = Array.from({ length: 3 + n }, (_, i) => ({
      id: `el-${i + 1}`, type: pick(WORLD_TYPES),
      position: { x: num(-500, 500), y: num(-500, 500), z: num(0, 300) }, orientation: { w: 1, x: 0, y: 0, z: 0 },
    }));
    const doc = {
      schemaVersion: 4, map: pick(['alps', 'swiss2']), trackClass: 'full', field: { width: 60, depth: 40 },
      elements, sequence: elements.map((el, i) => ({ id: `sq-${i}`, elementId: el.id })),
    };
    items.push({ name: `World ${n + 1}`, gates: elements.length, plan: planFromDocument(doc) });
  }
  items.push({ name: 'No plan', gates: 0, plan: null });
  items.push({ name: 'Empty field', gates: 1, plan: { trackClass: 'full', width: 0, depth: 0, marks: [], path: [], numbers: [] } });
  return items;
}

/* Page script that draws the sheet with the page's own plan.js. */
export function drawSheetScript(origin, items) {
  return `(async () => {
    const plan = await import(${JSON.stringify(`${origin}/plan.js`)});
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#0d1410;color:#eee;font:12px monospace';
    const items = ${JSON.stringify(items)};
    for (const it of items) {
      const box = document.createElement('div');
      box.style.cssText = 'display:inline-block;margin:4px;vertical-align:top';
      const tile = plan.planCanvas(it.plan, plan.planLabel(it));
      tile.style.cssText = 'width:300px;height:200px;display:block';
      const sheet = plan.planCanvas(it.plan, plan.planLabel(it), { scaleBar: true, pad: 26 });
      sheet.style.cssText = 'width:600px;height:400px;display:block';
      const caption = document.createElement('p');
      caption.textContent = [it.name, tile.getAttribute('aria-label'), plan.fieldSize(it)].join(' | ');
      box.append(tile, sheet, caption);
      document.body.append(box);
    }
    plan.paintPlans(document);
    return true;
  })()`;
}
