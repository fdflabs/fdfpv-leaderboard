/*
 * plan.js: a published track drawn from above, from the plan the list
 * payload already carries.
 *
 * Every track on the board arrives with its field size, the things that
 * stand on it and its flown line in flying order, which is enough to draw
 * it for free; the alternative is a simulator per card. The drawing uses
 * the track builder's language so a track looks the same here as in the
 * editor: a blueprint plate on a darker mount, a slate grid, the flown
 * line, pale bars for openings, cream and amber markers, a mint start.
 *
 * Inside a mark, after translating to it and rotating by -yaw, local x is
 * the direction of travel and local y the width, so an opening is a bar
 * along local y.
 *
 * Sizes come from the mark when the plan carries them (opening width,
 * level count, barrier size, start row), as both producers of plans do:
 * the board's src/validate.js and the simulator's src/share/plan.js. The
 * metre constants below are only what a mark without dimensions falls back
 * to, per track class. Drawing sizes have pixel floors so a 1.5 m gate on
 * a 120 m field is still visible.
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
import { str } from './strings/index.js';

const INK = {
  mount: '#080d12',
  plateHigh: '#17232f',
  plateLow: '#0d161e',
  fineGrid: 'rgba(157, 179, 200, 0.09)',
  boldGrid: 'rgba(157, 179, 200, 0.19)',
  frame: 'rgba(247, 232, 205, 0.5)',
  opening: '#dbe8f3',
  dive: '#7dffb4',
  diveWash: 'rgba(125, 255, 180, 0.14)',
  flag: 'rgba(247, 232, 205, 0.62)',
  cone: '#ffd45c',
  wall: 'rgba(255, 125, 125, 0.45)',
  wallEdge: 'rgba(255, 154, 154, 0.85)',
  start: '#7dffb4',
  lineGlow: 'rgba(255, 212, 92, 0.28)',
  line: 'rgba(255, 212, 92, 0.88)',
  badgeText: '#101a26',
  badge: '#f7e8cd',
  rule: 'rgba(157, 179, 200, 0.55)',
};

/*
 * Fallback sizes in metres, for a mark that carries none, by class. A full
 * field is MultiGP: a 5 ft gate, a 7 ft dive gate, a crowd barrier, four
 * start stands 1.5 m apart, a road cone. A micro room is RaceGOW: a 28 in
 * gate, furniture, one 100 mm stand, a 60 mm indoor cone. With no field at
 * all a room falls back to 10 by 12 and a field to 60 by 40.
 */
const SIZES = {
  full: { gate: 1.524, dive: 2.13, wallW: 4, wallD: 1, startRow: 4.5, marker: 0.18, fieldW: 60, fieldD: 40 },
  micro: { gate: 0.711, dive: 0.711, wallW: 1.8, wallD: 0.85, startRow: 0.10, marker: 0.030, fieldW: 10, fieldD: 12 },
};

/* The drawing thickness of an opening's bar, as a share of a 5 ft opening:
 * 0.36 m reads as a bar at that width, and scaling it with the opening
 * keeps a 28 in room gate from drawing as a block. */
const BAR_DEPTH = 0.36;
const STANDARD_GATE = 1.524;
/* The MultiGP start row the chevron's proportions are drawn for. */
const STANDARD_ROW = 4.5;

/*
 * A room's track sits in the middle of its floor with run-off nobody flies,
 * so a micro plan frames the marks plus a gate's width of floor, never
 * smaller than RaceGOW's 1.42 by 2.13 m envelope nor larger than the room.
 */
const ROOM_MARGIN = 0.45;
const ROOM_MIN = { w: 1.42, d: 2.13 };

/* Openings and how many levels a stack of each type has. */
const STACK_LEVELS = {
  gate: 1, flaggedGate: 1, doubleStack: 2, flaggedDoubleStack: 2, ladder: 3, tower: 2,
};

/*
 * Grid and scale bar steps in metres. The first step at least so many
 * pixels apart is taken, so a room gets a fine grid and a short bar while
 * a 60 m field, never drawn above about 8 px a metre here, keeps 1 m and
 * 5 m.
 */
const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const RULE_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];

function firstStepAtLeast(steps, px, perMetre) {
  return steps.find((m) => m * perMetre >= px) ?? steps[steps.length - 1];
}

function classSizes(plan) {
  return plan?.trackClass === 'micro' ? SIZES.micro : SIZES.full;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* The box around every finite mark and path point, or null. */
function spread(plan) {
  const xs = [];
  const ys = [];
  for (const p of [...(plan?.marks || []), ...(plan?.path || [])]) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  return xs.length ? { left: Math.min(...xs), right: Math.max(...xs), near: Math.min(...ys), far: Math.max(...ys) } : null;
}

/* A span widened about its middle to `least`, then kept inside [0, room]
 * at its length; or the whole room when it will not fit. */
function spanInRoom(from, to, least, room) {
  let lo = from;
  let hi = to;
  if (hi - lo < least) {
    const mid = (lo + hi) / 2;
    lo = mid - least / 2;
    hi = mid + least / 2;
  }
  if (hi - lo >= room) {
    return { start: 0, size: room };
  }
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > room) {
    lo -= hi - room;
    hi = room;
  }
  return { start: Math.max(0, lo), size: hi - lo };
}

/*
 * The window of the world being drawn and where it lands on the canvas:
 * scale in px per metre, the plate's size in metres, the world coordinate
 * at the plate's left and bottom edges, and the plate's top left in px.
 * The field keeps its proportions, centred.
 */
function viewOf(plan, w, h, pad) {
  const sizes = classSizes(plan);
  const roomW = Math.max(1, Number(plan?.width) || sizes.fieldW);
  const roomD = Math.max(1, Number(plan?.depth) || sizes.fieldD);
  let across = { start: 0, size: roomW };
  let along = { start: 0, size: roomD };
  const marks = plan?.trackClass === 'micro' ? spread(plan) : null;
  if (marks) {
    across = spanInRoom(marks.left - ROOM_MARGIN, marks.right + ROOM_MARGIN, ROOM_MIN.w, roomW);
    along = spanInRoom(marks.near - ROOM_MARGIN, marks.far + ROOM_MARGIN, ROOM_MIN.d, roomD);
  }
  const scale = Math.min((w - pad * 2) / across.size, (h - pad * 2) / along.size);
  const view = {
    scale,
    width: across.size,
    depth: along.size,
    worldX: across.start,
    worldY: along.start,
    left: (w - across.size * scale) / 2,
    top: (h - along.size * scale) / 2,
  };
  view.pxWidth = view.width * scale;
  view.pxDepth = view.depth * scale;
  return view;
}

/* World metres to canvas px; world +y runs up the page. */
function project(view, x, y) {
  return {
    x: view.left + ((Number(x) || 0) - view.worldX) * view.scale,
    y: view.top + (view.depth - ((Number(y) || 0) - view.worldY)) * view.scale,
  };
}

function clipToPlate(ctx, view) {
  ctx.beginPath();
  ctx.rect(view.left, view.top, view.pxWidth, view.pxDepth);
  ctx.clip();
}

function paintPlate(ctx, w, h, view) {
  ctx.fillStyle = INK.mount;
  ctx.fillRect(0, 0, w, h);
  const shade = ctx.createLinearGradient(0, view.top, 0, view.top + view.pxDepth);
  shade.addColorStop(0, INK.plateHigh);
  shade.addColorStop(1, INK.plateLow);
  ctx.fillStyle = shade;
  ctx.fillRect(view.left, view.top, view.pxWidth, view.pxDepth);
}

/* Grid lines snapped to the pixel centre so a 1 px line is one crisp row. */
function paintGrid(ctx, view) {
  const fine = firstStepAtLeast(GRID_STEPS, 9, view.scale);
  const right = view.left + view.pxWidth;
  const bottom = view.top + view.pxDepth;
  ctx.save();
  clipToPlate(ctx, view);
  for (const [step, ink] of [[fine, INK.fineGrid], [fine * 5, INK.boldGrid]]) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let m = 0; m <= view.width + 0.001; m += step) {
      const x = Math.round(view.left + m * view.scale) + 0.5;
      ctx.moveTo(x, view.top);
      ctx.lineTo(x, bottom);
    }
    for (let m = 0; m <= view.depth + 0.001; m += step) {
      const y = Math.round(bottom - m * view.scale) + 0.5;
      ctx.moveTo(view.left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = INK.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(view.left) + 0.5, Math.round(view.top) + 0.5,
    Math.round(view.pxWidth) - 1, Math.round(view.pxDepth) - 1);
}

/*
 * The flown line through the knots of the flying order, closed back to the
 * first knot when the lap does not already end there. A soft wide stroke
 * under a narrow bright one.
 */
function paintLine(ctx, view, path) {
  if (!path || path.length < 2) {
    return;
  }
  const knots = path.map((p) => project(view, p.x, p.y));
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) > Math.max(8, view.scale * 2)) {
    knots.push(first);
  }
  ctx.save();
  clipToPlate(ctx, view);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const width = Math.max(1.4, Math.min(2.8, view.scale * 0.38));
  for (const [ink, lineWidth] of [[INK.lineGlow, width + 2.4], [INK.line, width]]) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    knots.forEach((k, i) => (i ? ctx.lineTo(k.x, k.y) : ctx.moveTo(k.x, k.y)));
    ctx.stroke();
  }
  ctx.restore();
}

/* An opening: a bar across the line of travel, deeper for a stack, with an
 * arc per extra level where the bar is long enough to hold them. */
function drawOpening(ctx, px, mark, sizes, levels) {
  const opening = positive(mark.clearW) ?? sizes.gate;
  const ratio = opening / STANDARD_GATE;
  const half = Math.max(3.2, opening * 0.5 * px);
  const depth = Math.max(1.8, BAR_DEPTH * ratio * px) * (levels > 1 ? 1.8 : 1);
  ctx.beginPath();
  ctx.rect(-depth / 2, -half, depth, half * 2);
  ctx.fillStyle = INK.opening;
  ctx.fill();
  if (levels <= 1 || half <= 8) {
    return;
  }
  ctx.strokeStyle = INK.opening;
  ctx.lineWidth = 1;
  const gap = Math.max(2.5, px * 0.22 * ratio);
  for (let level = 1; level < levels; level += 1) {
    ctx.beginPath();
    ctx.arc(0, 0, depth / 2 + level * gap, -0.9, 0.9);
    ctx.stroke();
  }
}

/* A dive gate, flown from above: an outlined square with a dot. */
function drawDive(ctx, px, mark, sizes) {
  const half = Math.max(3.5, (positive(mark.clearW) ?? sizes.dive) * 0.5 * px);
  ctx.beginPath();
  ctx.rect(-half, -half, half * 2, half * 2);
  ctx.fillStyle = INK.diveWash;
  ctx.fill();
  ctx.strokeStyle = INK.dive;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, half * 0.28), 0, Math.PI * 2);
  ctx.fillStyle = INK.dive;
  ctx.fill();
}

/* A barrier, its long side along its heading as the builder lays it. */
function drawWall(ctx, px, mark, sizes) {
  const long = Math.max(4, (mark.w > 0 ? mark.w : sizes.wallW) * px);
  const short = Math.max(2, (mark.d > 0 ? mark.d : sizes.wallD) * px);
  ctx.beginPath();
  ctx.rect(-long / 2, -short / 2, long, short);
  ctx.fillStyle = INK.wall;
  ctx.fill();
  ctx.strokeStyle = INK.wallEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/* A turn marker at a cone's footprint: a dot for a flag, a triangle for a
 * cone. One that is not in the flying order is drawn faint. */
function drawMarker(ctx, px, mark, sizes) {
  const r = Math.max(1.6, px * sizes.marker);
  const cone = mark.type === 'cone';
  if (mark.seq === false) {
    ctx.globalAlpha = 0.38;
  }
  ctx.beginPath();
  if (cone) {
    ctx.moveTo(0, -r * 1.3);
    ctx.lineTo(r * 1.15, r * 0.9);
    ctx.lineTo(-r * 1.15, r * 0.9);
    ctx.closePath();
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = cone ? INK.cone : INK.flag;
  ctx.fill();
}

/* The start row's length: first stand to last, never less than a stand. */
function startRow(mark, sizes) {
  const pads = Number(mark.pads);
  const spacing = Number(mark.spacing);
  if (!(Number.isFinite(pads) && pads > 0 && Number.isFinite(spacing) && spacing >= 0)) {
    return sizes.startRow;
  }
  return Math.max((pads - 1) * spacing, positive(mark.padSize) ?? 0);
}

/* The start: a line as long as the row of stands, and a chevron down the
 * launch heading in proportion to it. */
function drawStart(ctx, px, mark, sizes) {
  const row = startRow(mark, sizes);
  const half = Math.max(5, row * 0.5 * px);
  ctx.strokeStyle = INK.start;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -half);
  ctx.lineTo(0, half);
  ctx.stroke();
  const k = row / STANDARD_ROW;
  const tip = Math.max(6, px * 1.9 * k);
  const wing = Math.max(4, px * 1.2 * k);
  ctx.beginPath();
  ctx.moveTo(tip, 0);
  ctx.lineTo(tip - wing, -wing * 0.78);
  ctx.lineTo(tip - wing, wing * 0.78);
  ctx.closePath();
  ctx.fillStyle = INK.start;
  ctx.fill();
}

/*
 * What each drawable type looks like, and its layer: walls under markers
 * under openings under the start, so nothing flown through is ever hidden
 * under a flag. A type missing here (waypoints, labels, poles, unknown
 * types) is not drawn: an invented symbol would claim a thing is there.
 */
const DRAWERS = {
  barrier: { layer: 0, draw: drawWall },
  flag: { layer: 1, draw: drawMarker },
  cone: { layer: 1, draw: drawMarker },
  diveGate: { layer: 2, draw: drawDive },
  startPads: { layer: 3, draw: drawStart },
};
for (const [type, levels] of Object.entries(STACK_LEVELS)) {
  DRAWERS[type] = {
    layer: 2,
    draw: (ctx, px, mark, sizes) => drawOpening(ctx, px, mark, sizes, mark.levels > 0 ? mark.levels : levels),
  };
}

function paintMarks(ctx, view, plan) {
  const sizes = classSizes(plan);
  const drawable = (plan.marks || [])
    .map((mark) => ({ mark, how: Object.hasOwn(DRAWERS, String(mark.type || '')) ? DRAWERS[mark.type] : null }))
    .filter((d) => d.how);
  drawable.sort((a, b) => a.how.layer - b.how.layer);
  for (const { mark, how } of drawable) {
    const at = project(view, mark.x, mark.y);
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(-(Number(mark.yaw) || 0));
    how.draw(ctx, view.scale, mark, sizes);
    ctx.restore();
  }
}

/* A numbered badge per step of the flying order, stacked upward where one
 * structure is flown more than once, as the builder does. */
function paintBadges(ctx, view, numbers) {
  if (!numbers?.length) {
    return;
  }
  const r = Math.max(6, Math.min(9, view.scale * 0.55));
  ctx.font = `600 ${Math.round(r * 1.15)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const badge of numbers) {
    const at = project(view, badge.x, badge.y);
    const y = at.y - (Number(badge.stack) || 0) * r * 2.1;
    ctx.beginPath();
    ctx.arc(at.x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = INK.badge;
    ctx.fill();
    ctx.fillStyle = INK.badgeText;
    ctx.fillText(String(badge.n), at.x, y + 0.5);
  }
}

/* A scale bar in the bottom right corner, left out when the shortest
 * readable step would take more than 42% of the width. */
function paintRule(ctx, view, w, h) {
  const metres = firstStepAtLeast(RULE_STEPS, 44, view.scale);
  const len = metres * view.scale;
  if (len > w * 0.42) {
    return;
  }
  const x = w - 14 - len;
  const y = h - 16;
  ctx.strokeStyle = INK.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y - 3.5);
  ctx.lineTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + len + 0.5, y + 0.5);
  ctx.lineTo(x + len + 0.5, y - 3.5);
  ctx.stroke();
  ctx.fillStyle = INK.rule;
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${metres} m`, x + len, y - 6);
}

/*
 * Draw `plan` onto `canvas` at the size the canvas is laid out at, sharp on
 * a high density screen. Options: `pad` around the plate in px, and
 * `scaleBar` for the sheet's badges and rule. False when the canvas has
 * no size yet (hidden) or no 2D context.
 */
export function drawPlan(canvas, plan, options = {}) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width || canvas.clientWidth || 0);
  const h = Math.round(rect.height || canvas.clientHeight || 0);
  if (w < 8 || h < 8) {
    return false;
  }
  const bufferW = Math.round(w * ratio);
  const bufferH = Math.round(h * ratio);
  if (canvas.width !== bufferW || canvas.height !== bufferH) {
    canvas.width = bufferW;
    canvas.height = bufferH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return false;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const view = viewOf(plan, w, h, options.pad ?? Math.max(6, w * 0.022));
  paintPlate(ctx, w, h, view);
  paintGrid(ctx, view);
  if (!plan) {
    return true;
  }
  paintLine(ctx, view, plan.path);
  paintMarks(ctx, view, plan);
  if (options.scaleBar) {
    paintBadges(ctx, view, plan.numbers);
    paintRule(ctx, view, w, h);
  }
  return true;
}

/* Every plan canvas under `root` that has a plan; one still hidden reports
 * no size and waits for the next pass. */
export function paintPlans(root = document) {
  for (const canvas of root.querySelectorAll('canvas.plan')) {
    if (canvas.planData) {
      drawPlan(canvas, canvas.planData, canvas.planOptions || {});
    }
  }
}

/* A canvas carrying its plan, ready for paintPlans once it is laid out. */
export function planCanvas(plan, label, options) {
  const canvas = document.createElement('canvas');
  canvas.className = 'plan';
  canvas.planData = plan || null;
  canvas.planOptions = options || {};
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label || str('plan.track_plan'));
  return canvas;
}

function roundedSize(track) {
  const plan = track.plan || {};
  return { w: Math.round(Number(plan.width) || 0), d: Math.round(Number(plan.depth) || 0), plan };
}

/* What a screen reader is told the picture is: a room is a room, and a
 * track built in a world is drawn on a stretch of valley. */
export function planLabel(track) {
  const { w, d, plan } = roundedSize(track);
  const gates = track.gates === 1 ? '1 gate' : `${track.gates} gates`;
  let where = 'field';
  if (plan.trackClass === 'micro') {
    where = 'room';
  } else if (plan.map) {
    where = 'valley';
  }
  return str('plan.plan_of_in_a_by_metre', { name: track.name, gates, w, d, where });
}

export function fieldSize(track) {
  const { w, d } = roundedSize(track);
  return w && d ? str('plan.by_m', { w, d }) : '';
}
