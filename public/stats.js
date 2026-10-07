/*
 * stats.js: the statistics tab, and this browser's side of the counting
 * that feeds it.
 *
 * THE BROWSER SIDE keeps three things in one localStorage entry: the day
 * it was first seen, the last day it was counted, and a sponsor slug for
 * thirty days. None of them is sent. What is sent is what they decide: a
 * boolean for "been here before" and one word for which poster it came
 * from. There is no identifier anywhere in the wire format.
 *
 * It mirrors the simulator's src/share/stats.js, which sends most of the
 * events. The storage key is the same on purpose: on the VM the simulator
 * and this board are one origin, so they share localStorage, and opting
 * out here opts out there. Change both copies together.
 *
 * THE TAB is one request drawn as counters, two bar charts and ranked
 * lists. It polls only while someone is looking, and each chart has a
 * table, because a tooltip is not a way to read a number without a
 * pointer. The charts are one series each: the two spare colours of this
 * palette, slate and sakura, are barely apart under protanopia, and mint
 * and amber already mean a record and an instrument, so the new and
 * returning split is said in words instead.
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
/* The memory is shared with the simulator on the same origin; see the
 * header and keys.js. */
import { STATS_KEY, readSharedKey, writeSharedKey } from './keys.js';

/* ================================================================== */
/* What this browser remembers and sends                               */
/* ================================================================== */

/* A poster arrival still counts when the visitor comes back at the
 * weekend, and stops being a label after a month. */
const SPONSOR_MEMORY_DAYS = 30;
/* The shape src/sponsors.js accepts, which is the copy that decides. */
const SLUG = /^[a-z0-9-]{2,32}$/;
const DAY_MS = 86_400_000;

const utcDay = () => new Date().toISOString().slice(0, 10);

function dayGap(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY_MS) : Infinity;
}

/* The entry, or {} when there is none, it is not an object, or storage is
 * refused. A browser that cannot remember is counted as new every day, and
 * the page says so rather than correcting for it. */
function recall() {
  try {
    const raw = readSharedKey(STATS_KEY);
    const held = raw ? JSON.parse(raw) : null;
    return held !== null && typeof held === 'object' && !Array.isArray(held) ? held : {};
  } catch {
    return {};
  }
}

function remember(memory) {
  try {
    writeSharedKey(STATS_KEY, JSON.stringify(memory));
    return true;
  } catch {
    return false;
  }
}

/* Global Privacy Control: a browser that asks gets nothing sent at all,
 * rather than sent and dropped. The server honours the header too. */
export function privacyRefused() {
  try {
    return navigator.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

export function optedOut() {
  return recall().optOut === true;
}

export function setOptedOut(on) {
  return remember({ ...recall(), optOut: Boolean(on) });
}

export function counting() {
  return !privacyRefused() && !optedOut();
}

/*
 * Keep the sponsor slug from the address, last arrival winning, then take
 * every utm_ parameter out of the address bar, so a link a pilot copies to
 * a friend does not credit the friend to a poster they never saw. Other
 * parameters stay. The slug is kept even with counting off: it stays in
 * this browser, and nothing is sent while the switch is off.
 */
export function captureSource(loc = window.location, hist = window.history) {
  let url;
  try {
    url = new URL(loc.href);
  } catch {
    return null;
  }
  const offered = url.searchParams.get('utm_source');
  const slug = offered !== null && SLUG.test(offered.trim().toLowerCase()) ? offered.trim().toLowerCase() : null;
  if (slug) {
    remember({ ...recall(), source: { slug, day: utcDay() } });
  }
  const tracking = [...url.searchParams.keys()].filter((k) => k.toLowerCase().startsWith('utm_'));
  tracking.forEach((k) => url.searchParams.delete(k));
  if (tracking.length && typeof hist?.replaceState === 'function') {
    try {
      hist.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* A sandboxed frame keeps the parameter in its bar; nothing else changes. */
    }
  }
  return slug;
}

/* The slug still being carried, or null once it is too old. */
export function heldSource() {
  const held = recall().source;
  if (!held || !SLUG.test(String(held.slug || ''))) {
    return null;
  }
  return dayGap(String(held.day || ''), utcDay()) <= SPONSOR_MEMORY_DAYS ? held.slug : null;
}

/* Count this browser for today: { returning } the first time today, null
 * after that, which makes a visit once per browser per day across pages. */
export function markVisit() {
  const memory = recall();
  const day = utcDay();
  if (memory.lastVisitDay === day) {
    return null;
  }
  const returning = Boolean(memory.firstDay) && memory.firstDay !== day;
  remember({ ...memory, firstDay: memory.firstDay || day, lastVisitDay: day });
  return { returning };
}

/*
 * One event, as a beacon so it survives the page closing (when the last
 * flush goes). text/plain because a beacon cannot set a header and a
 * simple request needs no preflight.
 */
export function sendEvent(payload, url) {
  if (!counting()) {
    return false;
  }
  const body = JSON.stringify({ v: 1, ...payload, source: heldSource() });
  try {
    if (navigator.sendBeacon) {
      return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    }
  } catch {
    /* No beacon after all: fetch below. */
  }
  try {
    fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/* This page's arrival. A board that is down costs the page nothing.
 * Surface first, url second, the simulator copy's order. */
export function pingVisit(surface, url) {
  captureSource();
  const visit = counting() ? markVisit() : null;
  return visit ? sendEvent({ kind: 'visit', surface, returning: visit.returning }, url) : false;
}

/* ================================================================== */
/* The tab                                                             */
/* ================================================================== */

const POLL_MS = 30_000;
const FRESH_MS = 5000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/* What the tab holds between polls. `freshTimer` repaints "updated N ago"
 * on its own, or it would say "just now" for thirty seconds; `tableOpen`
 * survives a redraw, or the table would snap shut every poll. */
const tab = {
  url: '', data: null, error: '', shown: false, busy: false, tableOpen: false,
  pollTimer: 0, freshTimer: 0, resizeTimer: 0,
};

const $ = (id) => document.getElementById(id);

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text != null) {
    n.textContent = text;
  }
  return n;
}

function shape(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
  return n;
}

const count = (n) => Number(n || 0).toLocaleString('en-GB');

function counted(n, one, many) {
  return `${count(n)} ${Number(n) === 1 ? one : many}`;
}

/* An axis label has about four characters. */
function axisNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) {
    return `${Math.round(v / 100_000) / 10}M`;
  }
  if (v >= 10_000) {
    return `${Math.round(v / 1000)}k`;
  }
  return v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
}

/* Flight time in the unit a person would use. */
function flown(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) {
    return `${s} s`;
  }
  if (s < 5400) {
    return `${Math.round(s / 60)} min`;
  }
  const h = s / 3600;
  return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`;
}

/* How long ago the numbers were read; a different sentence from a flight
 * time, rounding to minutes later. */
function readAgo(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 5) {
    return 'just now';
  }
  if (s < 120) {
    return `${s} s ago`;
  }
  return s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/* '2026-10-06' as "6 Oct" or "6 October 2026"; anything else as itself. */
function dayName(day, long) {
  const parts = String(day || '').split('-');
  if (parts.length !== 3) {
    return String(day || '');
  }
  const month = MONTH_NAMES[Number(parts[1]) - 1];
  return long ? `${Number(parts[2])} ${month} ${parts[0]}` : `${Number(parts[2])} ${month.slice(0, 3)}`;
}

/* ---------------------------------------------------------------- */
/* Bar charts                                                        */
/* ---------------------------------------------------------------- */

const PLOT = { top: 10, height: 104, axis: 22, left: 36, right: 6 };
const INKS = {
  baseline: 'rgba(244,236,214,0.22)', grid: 'rgba(244,236,214,0.08)', label: '#8a9a86',
  bar: '#9db3c8', today: '#f3ead4', todayLabel: '#9db3c8', best: '#7dffb4',
};

/* What a column says when pointed at or focused, the same for both charts:
 * someone reading laps still wants to know how many pilots that was. */
function columnStory(row) {
  const lines = [
    ['Pilots', count(row.visits)],
    [str('stats.new_returning'), `${count(row.newVisitors)} / ${count(row.returningVisitors)}`],
    ['Sessions', count(row.sessions)],
    ['Laps', count(row.laps)],
    ['Flown', flown(row.flightS)],
  ];
  const day = dayName(row.day, true);
  return { day, lines, flat: `${day}: ${lines.map(([k, v]) => `${k} ${v}`).join(', ')}` };
}

/* A bar's outline: rounded top corners, square on the baseline. */
function barPath(x, top, width, base, r) {
  return `M${x} ${base} L${x} ${top + r} Q${x} ${top} ${x + r} ${top}`
    + ` L${x + width - r} ${top} Q${x + width} ${top} ${x + width} ${top + r}`
    + ` L${x + width} ${base} Z`;
}

/*
 * One series over the window at the container's real width (scaling a
 * viewBox would shrink the axis labels on a phone). Hairline grid at
 * nought, half and the top, never dashed; today is the cream bar; the best
 * day carries a mint tick; a date about once a week and always on today.
 * Every column is a focusable labelled hit area the full height of the
 * plot, because a quiet day's bar is too small to point at. The svg is a
 * group, not an image, so those columns stay reachable by a screen reader.
 */
function columnChart({ width, rows, value, label }) {
  const w = Math.max(280, Math.round(width));
  const h = PLOT.top + PLOT.height + PLOT.axis;
  const values = rows.map(value);
  const top = Math.max(1, ...values);
  const best = Math.max(...values);
  const slot = (w - PLOT.left - PLOT.right) / Math.max(1, rows.length);
  const barW = Math.max(2, slot - 2);
  const base = PLOT.top + PLOT.height;
  const chart = shape('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'group', 'aria-label': label });
  const text = (attrs, content) => {
    const t = shape('text', { 'font-size': 10, 'font-family': 'inherit', ...attrs });
    t.textContent = content;
    return t;
  };

  for (const share of [0, 0.5, 1]) {
    const y = base - PLOT.height * share;
    chart.append(
      shape('line', { x1: PLOT.left, y1: y, x2: w - PLOT.right, y2: y, stroke: share === 0 ? INKS.baseline : INKS.grid, 'stroke-width': 1 }),
      text({ x: PLOT.left - 8, y: y + 3.5, 'text-anchor': 'end', fill: INKS.label }, axisNumber(top * share)),
    );
  }

  rows.forEach((row, i) => {
    const v = values[i];
    const isToday = i === rows.length - 1;
    const x = PLOT.left + i * slot + (slot - barW) / 2;
    const height = top > 0 ? (v / top) * PLOT.height : 0;
    if (v > 0) {
      const y = base - height;
      chart.append(shape('path', { d: barPath(x, y, barW, base, Math.min(4, barW / 2, height)), fill: isToday ? INKS.today : INKS.bar }));
      if (v === best && best > 0) {
        chart.append(shape('rect', { x, y: y - 6, width: barW, height: 2, rx: 1, fill: INKS.best }));
      }
    }
    const story = columnStory(row).flat;
    const hit = shape('rect', {
      class: 'bar-hit', x: PLOT.left + i * slot, y: PLOT.top, width: slot, height: PLOT.height,
      tabindex: 0, role: 'img', 'aria-label': story,
    });
    const title = shape('title');
    title.textContent = story;
    hit.append(title);
    hit.dataset.at = String(i);
    chart.append(hit);
    if (isToday || (rows.length - 1 - i) % 7 === 0) {
      chart.append(text({
        x: PLOT.left + i * slot + slot / 2, y: base + 15, 'text-anchor': 'middle', fill: isToday ? INKS.todayLabel : INKS.label,
      }, isToday ? 'Today' : dayName(row.day, false)));
    }
  });
  return chart;
}

/* A chart with its title and a tooltip that follows the pointer or focus,
 * kept inside the plate. */
function chartPanel({ title, rows, value, label, width }) {
  const chart = columnChart({ width: width || 640, rows, value, label });
  const tip = make('div', 'chart-tip');
  const wrap = make('div', 'chart-wrap');
  wrap.append(make('p', 'chart-title', title), chart, tip);

  const show = (event) => {
    const hit = event.target.closest('.bar-hit');
    const row = hit && rows[Number(hit.dataset.at)];
    if (!row) {
      return;
    }
    const story = columnStory(row);
    tip.textContent = '';
    tip.append(make('b', null, story.day));
    for (const [k, v] of story.lines) {
      const line = make('div');
      line.append(make('span', null, k), make('i', null, v));
      tip.append(line);
    }
    tip.classList.add('on');
    const box = chart.getBoundingClientRect();
    const cell = hit.getBoundingClientRect();
    const scale = box.width / (chart.viewBox.baseVal.width || box.width || 1);
    const centre = (cell.left - box.left) + (cell.width / 2);
    tip.style.left = `${Math.max(0, Math.min(centre - tip.offsetWidth / 2, box.width - tip.offsetWidth))}px`;
    tip.style.top = `${PLOT.top * scale}px`;
  };
  const hide = () => tip.classList.remove('on');
  chart.addEventListener('pointerover', show);
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('focusin', show);
  chart.addEventListener('focusout', hide);
  return wrap;
}

/* The same numbers as a table, newest first, collapsed by default: the
 * way to read them without a pointer, with a screen reader or on paper. */
const TABLE_COLUMNS = [
  ['Day', (r) => dayName(r.day, true)],
  ['Pilots', (r) => count(r.visits)],
  ['New', (r) => count(r.newVisitors)],
  ['Returning', (r) => count(r.returningVisitors)],
  ['Sessions', (r) => count(r.sessions)],
  ['Laps', (r) => count(r.laps)],
  ['Flown', (r) => flown(r.flightS)],
];

function numbersTable(rows) {
  const details = make('details', 'chart-table');
  details.open = tab.tableOpen;
  details.addEventListener('toggle', () => {
    tab.tableOpen = details.open;
  });
  const headRow = make('tr');
  headRow.append(...TABLE_COLUMNS.map(([name]) => make('th', null, name)));
  const head = make('thead');
  head.append(headRow);
  const body = make('tbody');
  for (const row of [...rows].reverse()) {
    const tr = make('tr');
    tr.append(...TABLE_COLUMNS.map(([, cell]) => make('td', null, cell(row))));
    body.append(tr);
  }
  const table = make('table');
  table.append(head, body);
  const scroll = make('div', 'scroll');
  scroll.append(table);
  details.append(make('summary', null, str('stats.as_a_table')), scroll);
  return details;
}

/* ---------------------------------------------------------------- */
/* Ranked lists                                                      */
/* ---------------------------------------------------------------- */

/*
 * A ranked list with a bar per row against the largest. In reading order:
 * the top `limit`, then how many were left off, then the unknown row,
 * which was never ranked.
 */
function ranking({ rows, name, value, note, limit = 12, unknownKey = '', oneWord = '', manyWord = '' }) {
  const ranked = rows.filter((r) => r.key !== unknownKey);
  const unknown = unknownKey ? rows.find((r) => r.key === unknownKey) : null;
  const shown = ranked.slice(0, limit);
  const largest = Math.max(1, ...rows.map(value));
  const entry = (r, isUnknown) => {
    const li = make('li', isUnknown ? 'unknown' : null);
    const head = make('div', 'rank-top');
    head.append(make('span', 'rank-name', name(r)), make('span', 'rank-value', note(r)));
    const bar = make('div', 'rank-fill');
    bar.style.width = `${Math.max(1, Math.round((value(r) / largest) * 100))}%`;
    const track = make('div', 'rank-track');
    track.append(bar);
    li.append(head, track);
    return li;
  };
  const list = make('ul', 'rank');
  list.append(...shown.map((r) => entry(r, false)));
  const leftOff = ranked.length - shown.length;
  if (leftOff > 0) {
    const word = leftOff === 1 ? oneWord : (manyWord || oneWord);
    list.append(make('li', 'rank-rest', str('stats.and_more', { count: count(leftOff), v2: word ? ` ${word}` : '' })));
  }
  if (unknown && (unknown.visits || unknown.sessions || unknown.laps)) {
    list.append(entry(unknown, true));
  }
  const box = make('div');
  box.append(list);
  if (shown.length === 0 && !unknown) {
    box.append(make('p', 'rank-more', str('stats.nothing_counted_yet')));
  }
  return box;
}

/* Country names from the browser, which already has them in every
 * language, guarded because an older browser may lack the API. */
let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  regionNames = null;
}

function countryName(code) {
  if (code === 'ZZ') {
    return 'Unknown';
  }
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code;
  }
}

/* Airframe names as the simulator's configs/airframes.js prints them; an
 * id added after this page shipped prints as itself. */
const AIRFRAME_NAMES = {
  '5inch': str('app.five_inch'),
  whoop65: '65 mm whoop',
  wing1000: str('app.fixed_wing'),
  other: str('stats.craft_other'),
};
for (const id of ['7inch', '10inch', 'interceptor', 'sky1800', 'cub1400', 'radian2000', 'bramor2300', 'slowstick1180',
  'timber1500', 'timber1500f', 'cub1400f', 'bombshell1118', 'kadet1981', 'uglystik1567', 'tigermoth1803', 'p51d1450',
  'f16878', 'zagi1219', 'nrj1490', 'striker2500']) {
  AIRFRAME_NAMES[id] = str(`stats.craft_${id}`);
}
const MAP_NAMES = { custom: 'Track', city: str('stats.freestyle_city'), other: 'Other' };
const INPUT_NAMES = { gamepad: str('stats.radio_or_controller'), keyboard: 'Keyboard', touch: 'Touch', other: 'Other' };

/* ---------------------------------------------------------------- */
/* Painting                                                          */
/* ---------------------------------------------------------------- */

function plate(id) {
  const box = $(id);
  box.textContent = '';
  return box;
}

function heading(box, kicker, title, note) {
  box.append(make('div', 'kicker', kicker), make('h3', null, title));
  if (note != null) {
    box.append(make('p', 'plate-note', note));
  }
}

/* "Updated N ago", or that the board could not be reached. */
function paintFreshness() {
  const line = $('stats-fresh');
  if (!line) {
    return;
  }
  const section = $('view-stats');
  const age = tab.data ? (Date.now() - Date.parse(tab.data.generatedUtc)) / 1000 : 0;
  const stale = Boolean(tab.error);
  line.classList.toggle('stale', stale);
  section?.classList.toggle('stale', stale);
  if (stale) {
    line.textContent = tab.data
      ? str('stats.could_not_reach_the_board_showing', { agoText: readAgo(age) })
      : str('stats.could_not_reach_the_board');
  } else {
    line.textContent = tab.data ? str('stats.updated_days_are_utc', { agoText: readAgo(age) }) : '';
  }
}

function paintTiles(d) {
  const box = $('stats-tiles');
  if (!box) {
    return;
  }
  const t = d.today;
  const tiles = [
    [str('stats.flying_now'), count(d.live ? d.live.flying : 0), str('stats.tabs_that_reported_a_lap_or'), true],
    [str('stats.pilots_today'), count(t.visits),
      str('stats.new_returning_2', { count: count(t.newVisitors), count2: count(t.returningVisitors) })],
    [str('stats.sessions_today'), count(t.sessions), str('stats.a_session_is_a_page_load')],
    [str('stats.laps_today'), count(t.laps), str('stats.flown', { flightTime: flown(t.flightS) })],
  ];
  box.textContent = '';
  for (const [label, value, note, live] of tiles) {
    const tile = make('div', live ? 'tile-stat live' : 'tile-stat');
    tile.append(make('span', 'tile-label', label), make('span', 'tile-value', value), make('span', 'tile-note', note || ''));
    box.append(tile);
  }
}

/*
 * Both charts and the table. A redraw (poll or resize) would take a
 * reader's focus off the column they were on, so which chart and column
 * had focus is noted first and given back after.
 */
function paintTrend(d) {
  const box = $('stats-trend');
  if (!box) {
    return;
  }
  const focused = document.activeElement;
  const was = focused?.classList?.contains('bar-hit')
    ? { chart: [...box.querySelectorAll('svg')].findIndex((s) => s.contains(focused)), at: focused.dataset.at }
    : null;
  box.hidden = false;
  box.textContent = '';
  const w = d.window;
  heading(box, str('stats.the_last_days', { days: w.days }), str('stats.pilots_and_laps_by_day'),
    `${counted(w.visits, 'pilot', 'pilots')}, ${counted(w.sessions, 'session', 'sessions')}, `
    + str('stats.and_flown', { plural: counted(w.laps, 'lap', 'laps'), flightTime: flown(w.flightS) })
    + str('stats.today_is_the_pale_bar_the'));
  /* Measured off the plate already on screen, less its padding. */
  const style = window.getComputedStyle(box);
  const width = Math.max(280, box.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0));
  const rows = d.days;
  box.append(
    chartPanel({ title: str('stats.pilots_per_day'), rows, width, value: (r) => r.visits,
      label: str('stats.pilots_per_day_over_the_last', { length: rows.length }) }),
    chartPanel({ title: str('stats.laps_per_day'), rows, width, value: (r) => r.laps,
      label: str('stats.laps_flown_per_day_over_the', { length: rows.length }) }),
    numbersTable(rows),
  );
  if (was && was.chart >= 0) {
    box.querySelectorAll('svg')[was.chart]?.querySelector(`.bar-hit[data-at="${was.at}"]`)?.focus();
  }
}

function paintRankings(d) {
  const row = $('stats-row');
  if (!row) {
    return;
  }
  row.hidden = false;

  /* Ranked and barred by sessions, the number the heading names. */
  const countries = plate('stats-countries');
  heading(countries, str('stats.where_from'), str('stats.countries'), str('stats.named_by_the_edge_in_front'));
  countries.append(
    ranking({
      rows: d.countries, unknownKey: 'ZZ', name: (r) => countryName(r.key), value: (r) => r.sessions,
      note: (r) => `${count(r.sessions)} / ${count(r.visits)}`, oneWord: 'country', manyWord: 'countries',
    }),
    make('p', 'rank-more', str('stats.sessions_pilots')),
  );

  /* By pilots, the number a sponsor is owed: how many people its poster
   * brought. The board ranks by sessions, so the order is redone here. */
  const byPilots = [...d.sources].sort((a, b) => (b.visits - a.visits) || (b.sessions - a.sessions)
    || String(a.key).localeCompare(String(b.key)));
  const sources = plate('stats-sources');
  heading(sources, str('stats.how_they_arrived'), str('stats.direct_and_sponsors'), str('stats.a_sponsor_link_carries_one_word'));
  sources.append(
    ranking({ rows: byPilots, name: (r) => r.name || r.key, value: (r) => r.visits, note: (r) => `${count(r.visits)} / ${count(r.laps)}` }),
    make('p', 'rank-more', str('stats.pilots_laps')),
  );

  const how = plate('stats-how');
  heading(how, str('stats.on_what'), str('stats.how_they_fly'), str('stats.of_the_sessions_counted_in_the'));
  for (const [title, rows, names] of [['Aircraft', d.craft, AIRFRAME_NAMES], ['Input', d.inputs, INPUT_NAMES], ['Map', d.maps, MAP_NAMES]]) {
    const total = rows.reduce((sum, r) => sum + r.sessions, 0);
    const group = make('div', 'rank-group');
    group.append(make('h4', null, title), ranking({
      rows, limit: 6, name: (r) => names[r.key] || r.key, value: (r) => r.sessions,
      note: (r) => (total ? `${Math.round((r.sessions / total) * 100)}%` : '0%'),
    }));
    how.append(group);
  }
}

function paintAllTime(d) {
  const box = $('stats-alltime');
  if (!box) {
    return;
  }
  box.hidden = false;
  box.textContent = '';
  heading(box, str('stats.all_time'), str('stats.since_this_page_started_counting'), d.firstDay
    ? str('stats.counting_began_on_the_four_on', { longDay: dayName(d.firstDay, true) })
    : str('stats.the_four_on_the_right_are'));
  const hero = make('div', 'hero-box');
  hero.append(make('div', 'hero', count(d.allTime.laps)), make('span', 'hero-label', str('stats.laps_flown')));
  const facts = make('div', 'facts');
  for (const [value, label] of [
    [count(d.allTime.sessions), 'Sessions'],
    [count(d.allTime.visits), str('stats.pilot_days')],
    [flown(d.allTime.flightS), str('stats.flight_time')],
    [count(d.allTime.countries), 'Countries'],
    [count(d.board.tracks), 'Tracks'],
    [count(d.board.times), str('app.times_posted')],
    [count(d.board.pilots), str('stats.named_pilots')],
    [count(d.board.pilotsOnMoreThanOneDay), str('stats.back_another_day')],
  ]) {
    const fact = make('div', 'fact');
    fact.append(make('span', 'fact-value', value), make('span', 'fact-label', label));
    facts.append(fact);
  }
  const strip = make('div', 'alltime');
  strip.append(hero, facts);
  box.append(strip);
}

/* The counting switch, or, when the browser asked not to be counted, the
 * sentence saying it is not. */
function paintOptOut() {
  const box = $('stats-optout');
  if (!box) {
    return;
  }
  box.textContent = '';
  if (privacyRefused()) {
    box.append(make('p', 'optout-said', str('stats.your_browser_asked_not_to_be')));
    return;
  }
  const toggle = make('input');
  toggle.type = 'checkbox';
  toggle.id = 'stats-count-me';
  toggle.checked = !optedOut();
  const label = make('label', null, str('stats.count_this_browser'));
  label.setAttribute('for', 'stats-count-me');
  const row = make('div', 'optout-row');
  row.append(toggle, label);
  const note = make('p', 'optout-note', str('stats.off_means_this_browser_sends_nothing'));
  box.append(row, note);
  toggle.addEventListener('change', () => {
    setOptedOut(!toggle.checked);
    note.textContent = toggle.checked
      ? str('stats.counted_nothing_that_identifies_you_is')
      : str('stats.not_counted_this_browser_sends_nothing');
  });
}

function paintNothingYet(d) {
  const notice = $('stats-notice');
  if (!notice) {
    return;
  }
  notice.textContent = '';
  if (d.allTime.visits || d.allTime.sessions || d.allTime.laps) {
    return;
  }
  const box = make('div', 'empty panel');
  box.append(make('h2', null, str('stats.nothing_counted_yet_2')), make('p', null, d.firstDay
    ? str('stats.counting_started_on_the_first_flight', { longDay: dayName(d.firstDay, true) })
    : str('stats.counting_starts_with_the_first_visit')));
  notice.append(box);
}

function paintAll() {
  paintFreshness();
  const d = tab.data;
  if (!d) {
    return;
  }
  paintNothingYet(d);
  paintTiles(d);
  paintTrend(d);
  paintRankings(d);
  paintAllTime(d);
}

/* ---------------------------------------------------------------- */
/* Fetching and showing                                              */
/* ---------------------------------------------------------------- */

/* A failed poll keeps the last good numbers on screen: a skeleton would
 * throw away a good answer for what is usually one missed poll. */
async function reload() {
  if (tab.busy || !tab.url) {
    return;
  }
  tab.busy = true;
  try {
    const res = await fetch(tab.url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || str('app.the_board_answered', { status: res.status }));
    }
    tab.data = body;
    tab.error = '';
  } catch (err) {
    tab.error = err.message || str('stats.the_board_could_not_be_reached');
  } finally {
    tab.busy = false;
  }
  paintAll();
}

function schedulePoll() {
  clearTimeout(tab.pollTimer);
  if (tab.shown && !document.hidden) {
    tab.pollTimer = setTimeout(async () => {
      await reload();
      schedulePoll();
    }, POLL_MS);
  }
}

function stopClocks() {
  clearTimeout(tab.pollTimer);
  clearInterval(tab.freshTimer);
}

/* Show or hide the tab. It polls only while shown and the document is
 * visible, so a board left in a background tab costs the service nothing. */
export function showStats(on) {
  const before = tab.shown;
  tab.shown = Boolean(on);
  stopClocks();
  if (!tab.shown) {
    return;
  }
  paintOptOut();
  if (!before || !tab.data) {
    reload();
  } else {
    paintFreshness();
  }
  tab.freshTimer = setInterval(paintFreshness, FRESH_MS);
  schedulePoll();
}

export function mountStats(url) {
  tab.url = url;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopClocks();
    } else if (tab.shown) {
      reload();
      tab.freshTimer = setInterval(paintFreshness, FRESH_MS);
      schedulePoll();
    }
  });
  /* The charts are drawn at real pixels, so a resize redraws them,
   * debounced like the plans. */
  window.addEventListener('resize', () => {
    clearTimeout(tab.resizeTimer);
    tab.resizeTimer = setTimeout(() => {
      if (tab.shown && tab.data) {
        paintTrend(tab.data);
      }
    }, 160);
  });
}
