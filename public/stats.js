/*
 * stats.js: the site statistics tab, and this page's own half of what feeds
 * it.
 *
 * TWO JOBS IN ONE FILE, AND THEY ARE THE SAME JOB FROM BOTH ENDS.
 *
 * The top half is the CLIENT: what this browser remembers, which is a first
 * seen date, the last day it was counted, and a sponsor slug for thirty
 * days. All three live in one key in local storage and NONE of them is ever
 * sent. What is sent is the answer they produce: a boolean saying whether
 * this browser has been here before, and a word saying which poster it
 * walked past. There is no identifier in the wire format and there is
 * nowhere for one to go.
 *
 * THE TOP HALF MIRRORS src/share/stats.js IN THE SIMULATOR'S REPOSITORY,
 * the same arrangement NAME_RE has: two repositories, so it cannot be
 * imported, and the simulator's copy is the one that sends most of the
 * events. The storage key is shared deliberately. Under one domain the
 * three apps share one origin and therefore one local storage, so a pilot
 * who opts out on this page is opted out in the simulator, which is the
 * only behaviour anybody would expect from a switch labelled the way this
 * one is. Change both copies or the promise stops being kept in one of
 * them.
 *
 * The bottom half is the PAGE: one request, some counters, two bar charts
 * and three ranked lists. It holds no state the board does not, it polls
 * only while somebody is looking at it, and every chart has a table beside
 * it, because a tooltip is not a way to read a number if you cannot hover.
 *
 * WHY THE CHARTS ARE ONE SERIES EACH. Two series would want two colours,
 * and the two this page has to spare, slate and sakura, come apart by a
 * colour difference of 2.4 under the commonest form of colour blindness:
 * a reader with protanopia would see one chart in one colour. Mint and
 * amber are spoken for, by a record and by an instrument. So the split
 * between new and returning lives in the tile, the tooltip and the table,
 * where it is words, and the charts stay one series. That is a real
 * constraint of this palette rather than a preference, and it was measured
 * rather than guessed.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { str } from './strings/index.js';

/* ------------------------------------------------------------------ */
/* The client half. Mirrored in the simulator's src/share/stats.js.    */
/* ------------------------------------------------------------------ */

const KEY = 'webfpv.stats.v1';
/* How long a sponsor click is remembered. Long enough that somebody who
 * arrives from a poster and comes back at the weekend is still that
 * sponsor's arrival; short enough that it is not a standing label. */
const SOURCE_DAYS = 30;
/* MIRRORS SOURCE_RE in src/sponsors.js, which is the copy that decides. */
const SOURCE_RE = /^[a-z0-9-]{2,32}$/;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return Infinity;
  }
  return Math.round((to - from) / 86_400_000);
}

function readState() {
  try {
    const raw = localStorage.getItem(KEY);
    const held = raw ? JSON.parse(raw) : null;
    return held && typeof held === 'object' && !Array.isArray(held) ? held : {};
  } catch (e) {
    /* Private mode, or a blob that is not JSON. A browser that cannot
     * remember is counted as new every day, and that is written down on
     * the page rather than corrected for. */
    return {};
  }
}

function writeState(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch (e) {
    return false;
  }
}

/*
 * GLOBAL PRIVACY CONTROL, checked here as well as on the server.
 *
 * A browser that sets this has made a request in the only machine readable
 * way there is, and the right answer is to send nothing at all rather than
 * to send something and have the far end drop it. The server checks the
 * header too, for the browsers that send it without exposing the property.
 */
export function privacyRefused() {
  try {
    return navigator.globalPrivacyControl === true;
  } catch (e) {
    return false;
  }
}

export function optedOut() {
  return readState().optOut === true;
}

export function setOptedOut(on) {
  const next = readState();
  next.optOut = Boolean(on);
  return writeState(next);
}

export function counting() {
  return !privacyRefused() && !optedOut();
}

/*
 * Take the sponsor slug out of the address and put it away, then take every
 * utm_ parameter OUT of the address bar.
 *
 * The strip is not tidiness. A query string is copied, pasted and shared,
 * and a pilot who sends a friend the link they are looking at should not be
 * attributing their friend to a poster they never saw. It also keeps the
 * parameters out of the page's own history entries. Everything the pages
 * actually read, map, share, board and craft, is left exactly as it was.
 *
 * Last click wins: somebody who arrives from one poster and later from
 * another is the second one's arrival.
 */
export function captureSource(loc = window.location, hist = window.history) {
  let url;
  try {
    url = new URL(loc.href);
  } catch (e) {
    return null;
  }
  const raw = url.searchParams.get('utm_source');
  let slug = null;
  if (raw != null) {
    const clean = String(raw).trim().toLowerCase();
    if (SOURCE_RE.test(clean)) {
      slug = clean;
    }
  }
  /* Stored even when counting is off, and that is not a contradiction: what
   * is stored is in this browser and goes nowhere. If somebody turns
   * counting back on, the poster they walked past is still the true answer.
   * Nothing is SENT while the switch is off, which is the promise. */
  if (slug) {
    const next = readState();
    next.source = { slug, day: today() };
    writeState(next);
  }
  let stripped = false;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
      stripped = true;
    }
  }
  if (stripped && hist && typeof hist.replaceState === 'function') {
    try {
      hist.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (e) {
      /* A sandboxed frame. The parameter stays in the bar and nothing else
       * changes. */
    }
  }
  return slug;
}

/* The slug this browser is carrying, or null once it has expired. */
export function heldSource() {
  const held = readState().source;
  if (!held || !SOURCE_RE.test(String(held.slug || ''))) {
    return null;
  }
  return daysBetween(String(held.day || ''), today()) <= SOURCE_DAYS ? held.slug : null;
}

/*
 * Mark this browser as counted today, and say whether it had been here
 * before. Returns null when it has already been counted today, which is
 * what makes a visit once per browser per day across all three pages.
 */
export function markVisit() {
  const held = readState();
  const day = today();
  if (held.lastVisitDay === day) {
    return null;
  }
  const returning = Boolean(held.firstDay) && held.firstDay !== day;
  held.firstDay = held.firstDay || day;
  held.lastVisitDay = day;
  writeState(held);
  return { returning };
}

/*
 * Post one event. A beacon, so it survives the page being closed, which is
 * exactly when the last flush is sent. text/plain because a beacon cannot
 * set a header and a simple request needs no preflight; the board never
 * reads the content type.
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
  } catch (e) {
    /* Fall through to fetch. */
  }
  try {
    fetch(url, {
      method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' },
    }).catch(() => {});
    return true;
  } catch (e) {
    return false;
  }
}

/* One visit, from whichever page called. Silent about everything: a board
 * that is down must cost this page nothing at all. The argument order is
 * the simulator copy's, payload first, so a fix carried between the two
 * lands in the same place. */
export function pingVisit(surface, url) {
  captureSource();
  if (!counting()) {
    return false;
  }
  const visit = markVisit();
  if (!visit) {
    return false;
  }
  return sendEvent({ kind: 'visit', surface, returning: visit.returning }, url);
}

/* ------------------------------------------------------------------ */
/* The page half                                                       */
/* ------------------------------------------------------------------ */

const POLL_MS = 30_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const view = {
  url: '',
  data: null,
  error: '',
  shown: false,
  timer: 0,
  /* The "updated N s ago" line has its own clock, because a line that
   * only repaints on a poll says "just now" for thirty seconds. */
  fresh: 0,
  fetching: false,
  resize: 0,
  /* Whether the reader has the table open. A poll rebuilds the charts and
   * the table with them, and a table that snaps shut every thirty seconds
   * is a table nobody can read. */
  tableOpen: false,
};

function byId(id) {
  return document.getElementById(id);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function count(n) {
  return Number(n || 0).toLocaleString('en-GB');
}

/* An axis label has about four characters to say a number in. */
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) {
    return `${Math.round(v / 100_000) / 10}M`;
  }
  if (v >= 10_000) {
    return `${Math.round(v / 1000)}k`;
  }
  if (v >= 1000) {
    return `${Math.round(v / 100) / 10}k`;
  }
  return String(Math.round(v));
}

/* Flight time, in whatever unit a person would say it in. */
function flightTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) {
    return `${s} s`;
  }
  if (s < 5400) {
    return `${Math.round(s / 60)} min`;
  }
  const hours = s / 3600;
  return hours < 10 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(hours)} h`;
}

/* How long ago, for the line that says when these numbers were read. Not
 * flightTime: "flown for 45 s" and "read 45 s ago" are different sentences
 * and only one of them rounds to minutes early. */
function agoText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 5) {
    return 'just now';
  }
  if (s < 120) {
    return `${s} s ago`;
  }
  if (s < 5400) {
    return `${Math.round(s / 60)} min ago`;
  }
  return `${Math.round(s / 3600)} h ago`;
}

function shortDay(day) {
  const parts = String(day || '').split('-');
  if (parts.length !== 3) {
    return String(day || '');
  }
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1].slice(0, 3)}`;
}

function longDay(day) {
  const parts = String(day || '').split('-');
  if (parts.length !== 3) {
    return String(day || '');
  }
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

function plural(n, one, many) {
  return `${count(n)} ${Number(n) === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* One bar chart                                                       */
/* ------------------------------------------------------------------ */

const CHART_PAD_T = 10;
const CHART_PLOT_H = 104;
const CHART_AXIS_H = 22;
const CHART_LEFT = 36;
const CHART_RIGHT = 6;

/*
 * A column chart of one series over the window.
 *
 * Thin marks, a hairline grid, rounded tops anchored to the baseline and a
 * two pixel gap between bars rather than a border around each. The last bar
 * is today and wears cream; the best day in the window carries a mint tick
 * above it, which is the one thing on this chart that says "a record" and
 * is the colour this product paints one in.
 *
 * Drawn at the container's real pixel width rather than scaled from a fixed
 * viewBox, because scaling would take a ten pixel axis label down to five
 * on a phone.
 */
function barChart({
  width, rows, pick, label, tip,
}) {
  const w = Math.max(280, Math.round(width));
  const h = CHART_PAD_T + CHART_PLOT_H + CHART_AXIS_H;
  const plotW = w - CHART_LEFT - CHART_RIGHT;
  const values = rows.map(pick);
  const max = Math.max(1, ...values);
  const best = Math.max(...values);
  const slot = plotW / Math.max(1, rows.length);
  const barW = Math.max(2, slot - 2);
  const base = CHART_PAD_T + CHART_PLOT_H;

  /*
   * role="group", NOT role="img". An image's descendants are presentational
   * to assistive technology, which would leave thirty focusable columns
   * that Tab reaches and a screen reader cannot name. A group exposes them.
   */
  const node = svg('svg', {
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    role: 'group',
    'aria-label': label,
  });

  /* The grid: nought, half and the top, solid hairlines a shade off the
     surface. Never dashed, which reads as a threshold. */
  for (const step of [0, 0.5, 1]) {
    const y = base - CHART_PLOT_H * step;
    node.append(svg('line', {
      x1: CHART_LEFT, y1: y, x2: w - CHART_RIGHT, y2: y,
      stroke: step === 0 ? 'rgba(244,236,214,0.22)' : 'rgba(244,236,214,0.08)',
      'stroke-width': 1,
    }));
    const text = svg('text', {
      x: CHART_LEFT - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8a9a86', 'font-size': 10, 'font-family': 'inherit',
    });
    text.textContent = compact(max * step);
    node.append(text);
  }

  rows.forEach((row, i) => {
    const value = values[i];
    const x = CHART_LEFT + i * slot + (slot - barW) / 2;
    const isToday = i === rows.length - 1;
    const height = max > 0 ? (value / max) * CHART_PLOT_H : 0;

    if (value > 0) {
      const r = Math.min(4, barW / 2, height);
      const y = base - height;
      node.append(svg('path', {
        d: `M${x} ${base} L${x} ${y + r} Q${x} ${y} ${x + r} ${y}`
          + ` L${x + barW - r} ${y} Q${x + barW} ${y} ${x + barW} ${y + r}`
          + ` L${x + barW} ${base} Z`,
        fill: isToday ? '#f3ead4' : '#9db3c8',
      }));
      if (value === best && best > 0) {
        node.append(svg('rect', {
          x, y: y - 6, width: barW, height: 2, rx: 1, fill: '#7dffb4',
        }));
      }
    }

    /*
     * The hit area, which is the whole column and not the bar: a two pixel
     * bar on a quiet day is not something anybody can point at. Focusable,
     * so a keyboard reaches the same numbers a pointer does, and carrying a
     * <title> so a browser and a screen reader both have it without this
     * page's own tooltip.
     */
    const hit = svg('rect', {
      class: 'bar-hit',
      x: CHART_LEFT + i * slot,
      y: CHART_PAD_T,
      width: slot,
      height: CHART_PLOT_H,
      tabindex: 0,
      /* A labelled image, not a button: pressing it does nothing, and a
       * role that promises otherwise is a promise to a screen reader. */
      role: 'img',
      'aria-label': tip(row).flat,
    });
    const title = svg('title', {});
    title.textContent = tip(row).flat;
    hit.append(title);
    hit.dataset.at = String(i);
    node.append(hit);

    /* A label about once a week, and always on today. More than that and
       thirty dates collide into a grey band. */
    const showLabel = isToday || (rows.length - 1 - i) % 7 === 0;
    if (showLabel) {
      const text = svg('text', {
        x: CHART_LEFT + i * slot + slot / 2,
        y: base + 15,
        'text-anchor': 'middle',
        fill: isToday ? '#9db3c8' : '#8a9a86',
        'font-size': 10,
        'font-family': 'inherit',
      });
      text.textContent = isToday ? 'Today' : shortDay(row.day);
      node.append(text);
    }
  });

  return node;
}

/* What a bar says when it is pointed at or focused. One builder for both
 * charts: a reader hovering the laps chart still wants to know how many
 * pilots that was. */
function dayTip(row) {
  const lines = [
    ['Pilots', count(row.visits)],
    [str('stats.new_returning'), `${count(row.newVisitors)} / ${count(row.returningVisitors)}`],
    ['Sessions', count(row.sessions)],
    ['Laps', count(row.laps)],
    ['Flown', flightTime(row.flightS)],
  ];
  return {
    day: longDay(row.day),
    lines,
    flat: `${longDay(row.day)}: ${lines.map(([k, v]) => `${k} ${v}`).join(', ')}`,
  };
}

function chartBlock({
  title, rows, pick, label, width,
}) {
  const wrap = el('div', 'chart-wrap');
  wrap.append(el('p', 'chart-title', title));
  const tip = el('div', 'chart-tip');
  const chart = barChart({
    width: width || 640, rows, pick, label, tip: dayTip,
  });
  wrap.append(chart);
  wrap.append(tip);

  const show = (hit) => {
    const row = rows[Number(hit.dataset.at)];
    if (!row) {
      return;
    }
    const info = dayTip(row);
    tip.textContent = '';
    tip.append(el('b', null, info.day));
    for (const [k, v] of info.lines) {
      const line = el('div');
      line.append(el('span', null, k));
      line.append(el('i', null, v));
      tip.append(line);
    }
    tip.classList.add('on');
    /* Placed against the column, then pulled back inside the plate: a
       tooltip half off the right edge is a tooltip nobody can read. */
    const box = chart.getBoundingClientRect();
    const cell = hit.getBoundingClientRect();
    const scale = box.width / (chart.viewBox.baseVal.width || box.width || 1);
    const left = (cell.left - box.left) + (cell.width / 2);
    tip.style.left = `${Math.max(0, Math.min(left - tip.offsetWidth / 2, box.width - tip.offsetWidth))}px`;
    tip.style.top = `${CHART_PAD_T * scale}px`;
  };
  const hide = () => tip.classList.remove('on');

  chart.addEventListener('pointerover', (e) => {
    const hit = e.target.closest('.bar-hit');
    if (hit) {
      show(hit);
    }
  });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('focusin', (e) => {
    const hit = e.target.closest('.bar-hit');
    if (hit) {
      show(hit);
    }
  });
  chart.addEventListener('focusout', hide);
  return wrap;
}

/*
 * The table every chart has beside it.
 *
 * A tooltip is an enhancement and never the only way to read a value: this
 * is where the numbers are when there is no pointer, no JavaScript tooltip,
 * a screen reader, or a printer. Collapsed, because on a page of charts it
 * is the second reading rather than the first.
 */
function chartTable(rows) {
  const box = el('details', 'chart-table');
  box.open = view.tableOpen;
  box.addEventListener('toggle', () => {
    view.tableOpen = box.open;
  });
  box.append(el('summary', null, str('stats.as_a_table')));
  const scroll = el('div', 'scroll');
  const table = el('table');
  const head = el('tr');
  for (const name of ['Day', 'Pilots', 'New', 'Returning', 'Sessions', 'Laps', 'Flown']) {
    head.append(el('th', null, name));
  }
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  for (const row of [...rows].reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, longDay(row.day)));
    tr.append(el('td', null, count(row.visits)));
    tr.append(el('td', null, count(row.newVisitors)));
    tr.append(el('td', null, count(row.returningVisitors)));
    tr.append(el('td', null, count(row.sessions)));
    tr.append(el('td', null, count(row.laps)));
    tr.append(el('td', null, flightTime(row.flightS)));
    body.append(tr);
  }
  table.append(body);
  scroll.append(table);
  box.append(scroll);
  return box;
}

/* ------------------------------------------------------------------ */
/* A ranked list                                                       */
/* ------------------------------------------------------------------ */

function rankList({
  rows, name, value, note, limit = 12, unknownKey = '', moreWord = '', moreWords = '',
}) {
  const known = rows.filter((r) => r.key !== unknownKey);
  const unknown = unknownKey ? rows.find((r) => r.key === unknownKey) : null;
  const shown = known.slice(0, limit);
  const max = Math.max(1, ...rows.map(value));
  const list = el('ul', 'rank');
  const row = (r, isUnknown) => {
    const li = el('li', isUnknown ? 'unknown' : null);
    const top = el('div', 'rank-top');
    top.append(el('span', 'rank-name', name(r)));
    top.append(el('span', 'rank-value', note(r)));
    li.append(top);
    const track = el('div', 'rank-track');
    const fill = el('div', 'rank-fill');
    fill.style.width = `${Math.max(1, Math.round((value(r) / max) * 100))}%`;
    track.append(fill);
    li.append(track);
    return li;
  };
  for (const r of shown) {
    list.append(row(r, false));
  }
  /* In reading order: what was ranked, then what was left off the ranking,
   * then Unknown, which was never in it. The count used to come last, which
   * read as though Unknown were the twelfth country and the others came
   * after it. */
  if (known.length > shown.length) {
    const rest = known.length - shown.length;
    const word = rest === 1 ? (moreWord || '') : (moreWords || moreWord || '');
    list.append(el('li', 'rank-rest', str('stats.and_more', { count: count(rest), v2: word ? ` ${word}` : '' })));
  }
  if (unknown && (unknown.visits || unknown.sessions || unknown.laps)) {
    list.append(row(unknown, true));
  }
  const box = el('div');
  box.append(list);
  if (!shown.length && !unknown) {
    box.append(el('p', 'rank-more', str('stats.nothing_counted_yet')));
  }
  return box;
}

/* The browser already holds every country's name in every language, so
 * this page does not ship a table of two hundred strings to print twelve of
 * them. Built once, and guarded, because it is the one modern API here that
 * an older browser can be missing entirely. */
let COUNTRY_NAMES = null;
try {
  COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
} catch (e) {
  COUNTRY_NAMES = null;
}

function countryName(code) {
  if (code === 'ZZ') {
    return 'Unknown';
  }
  try {
    return (COUNTRY_NAMES && COUNTRY_NAMES.of(code)) || code;
  } catch (e) {
    return code;
  }
}

const CRAFT_NAMES = { '5inch': str('app.five_inch'), whoop65: '65 mm whoop' };
const MAP_NAMES = { custom: 'Track', city: str('stats.freestyle_city'), other: 'Other' };
const INPUT_NAMES = {
  gamepad: str('stats.radio_or_controller'), keyboard: 'Keyboard', touch: 'Touch', other: 'Other',
};

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

function paintFresh() {
  const node = byId('stats-fresh');
  if (!node) {
    return;
  }
  const section = byId('view-stats');
  const age = view.data
    ? (Date.now() - Date.parse(view.data.generatedUtc)) / 1000
    : 0;
  if (view.error) {
    node.classList.add('stale');
    if (section) {
      section.classList.add('stale');
    }
    node.textContent = view.data
      ? str('stats.could_not_reach_the_board_showing', { agoText: agoText(age) })
      : str('stats.could_not_reach_the_board');
    return;
  }
  node.classList.remove('stale');
  if (section) {
    section.classList.remove('stale');
  }
  if (!view.data) {
    node.textContent = '';
    return;
  }
  node.textContent = str('stats.updated_days_are_utc', { agoText: agoText(age) });
}

function tile({
  label, value, note, live,
}) {
  const box = el('div', `tile-stat${live ? ' live' : ''}`);
  box.append(el('span', 'tile-label', label));
  box.append(el('span', 'tile-value', value));
  box.append(el('span', 'tile-note', note || ''));
  return box;
}

function paintTiles() {
  const box = byId('stats-tiles');
  if (!box || !view.data) {
    return;
  }
  const d = view.data;
  const t = d.today;
  box.textContent = '';
  box.append(tile({
    label: str('stats.flying_now'),
    value: count(d.live ? d.live.flying : 0),
    note: str('stats.tabs_that_reported_a_lap_or'),
    live: true,
  }));
  box.append(tile({
    label: str('stats.pilots_today'),
    value: count(t.visits),
    note: str('stats.new_returning_2', { count: count(t.newVisitors), count2: count(t.returningVisitors) }),
  }));
  box.append(tile({
    label: str('stats.sessions_today'),
    value: count(t.sessions),
    note: str('stats.a_session_is_a_page_load'),
  }));
  box.append(tile({
    label: str('stats.laps_today'),
    value: count(t.laps),
    note: str('stats.flown', { flightTime: flightTime(t.flightS) }),
  }));
}

function paintTrend() {
  const plate = byId('stats-trend');
  if (!plate || !view.data) {
    return;
  }
  const d = view.data;
  const rows = d.days;
  /*
   * A poll or a resize rebuilds both charts. A reader who had a column
   * focused, or the table open, had both taken off them every thirty
   * seconds, which is exactly the interval at which they were reading. So
   * what they were on is noted before the rebuild and handed back after.
   */
  const active = document.activeElement;
  const held = active && active.classList && active.classList.contains('bar-hit')
    ? {
      chart: [...plate.querySelectorAll('svg')].findIndex((s) => s.contains(active)),
      at: active.dataset.at,
    }
    : null;
  plate.hidden = false;
  plate.textContent = '';
  plate.append(el('div', 'kicker', str('stats.the_last_days', { days: d.window.days })));
  plate.append(el('h3', null, str('stats.pilots_and_laps_by_day')));
  plate.append(el('p', 'plate-note',
    `${plural(d.window.visits, 'pilot', 'pilots')}, ${plural(d.window.sessions, 'session', 'sessions')}, `
    + str('stats.and_flown', { plural: plural(d.window.laps, 'lap', 'laps'), flightTime: flightTime(d.window.flightS) })
    + str('stats.today_is_the_pale_bar_the')));
  /* The drawing width, measured off the plate that is already on screen
   * rather than off the wrap that is not in the document yet. clientWidth
   * includes the padding, so the padding comes back off. */
  const style = window.getComputedStyle(plate);
  const width = Math.max(
    280,
    plate.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0),
  );
  plate.append(chartBlock({
    title: str('stats.pilots_per_day'),
    rows,
    width,
    pick: (r) => r.visits,
    label: str('stats.pilots_per_day_over_the_last', { length: rows.length }),
  }));
  plate.append(chartBlock({
    title: str('stats.laps_per_day'),
    rows,
    width,
    pick: (r) => r.laps,
    label: str('stats.laps_flown_per_day_over_the', { length: rows.length }),
  }));
  plate.append(chartTable(rows));
  if (held && held.chart >= 0) {
    const chart = plate.querySelectorAll('svg')[held.chart];
    const again = chart && chart.querySelector(`.bar-hit[data-at="${held.at}"]`);
    if (again) {
      again.focus();
    }
  }
}

function paintRanks() {
  const row = byId('stats-row');
  if (!row || !view.data) {
    return;
  }
  const d = view.data;
  row.hidden = false;

  const countries = byId('stats-countries');
  countries.textContent = '';
  countries.append(el('div', 'kicker', str('stats.where_from')));
  countries.append(el('h3', null, str('stats.countries')));
  countries.append(el('p', 'plate-note',
    str('stats.named_by_the_edge_in_front')));
  /* The bar is sessions, the same number the rows are ranked by. It used to
   * fall back to pilots on a row with no sessions, which put a country of
   * five hundred visitors above one of three flights on a list whose
   * heading said sessions. */
  countries.append(rankList({
    rows: d.countries,
    unknownKey: 'ZZ',
    name: (r) => countryName(r.key),
    value: (r) => r.sessions,
    note: (r) => `${count(r.sessions)} / ${count(r.visits)}`,
    moreWord: 'country',
    moreWords: 'countries',
  }));
  countries.append(el('p', 'rank-more', str('stats.sessions_pilots')));

  const sources = byId('stats-sources');
  sources.textContent = '';
  sources.append(el('div', 'kicker', str('stats.how_they_arrived')));
  sources.append(el('h3', null, str('stats.direct_and_sponsors')));
  sources.append(el('p', 'plate-note',
    str('stats.a_sponsor_link_carries_one_word')));
  /* Ranked, barred and printed by PILOTS, which is the number a sponsor
   * is owed: how many people their poster brought. The board ranks every
   * dimension by sessions, so the order is redone here to match the bar. */
  const bySponsorPilots = [...d.sources].sort((a, b) => (b.visits - a.visits)
    || (b.sessions - a.sessions)
    || String(a.key).localeCompare(String(b.key)));
  sources.append(rankList({
    rows: bySponsorPilots,
    name: (r) => r.name || r.key,
    value: (r) => r.visits,
    note: (r) => `${count(r.visits)} / ${count(r.laps)}`,
  }));
  sources.append(el('p', 'rank-more', str('stats.pilots_laps')));

  const how = byId('stats-how');
  how.textContent = '';
  how.append(el('div', 'kicker', str('stats.on_what')));
  how.append(el('h3', null, str('stats.how_they_fly')));
  how.append(el('p', 'plate-note', str('stats.of_the_sessions_counted_in_the')));
  const groups = [
    ['Aircraft', d.craft, (k) => CRAFT_NAMES[k] || k],
    ['Input', d.inputs, (k) => INPUT_NAMES[k] || k],
    ['Map', d.maps, (k) => MAP_NAMES[k] || k],
  ];
  for (const [title, rows, naming] of groups) {
    const group = el('div', 'rank-group');
    group.append(el('h4', null, title));
    const total = rows.reduce((sum, r) => sum + r.sessions, 0);
    group.append(rankList({
      rows,
      name: (r) => naming(r.key),
      value: (r) => r.sessions,
      note: (r) => (total ? `${Math.round((r.sessions / total) * 100)}%` : '0%'),
      limit: 6,
    }));
    how.append(group);
  }
}

function paintAllTime() {
  const plate = byId('stats-alltime');
  if (!plate || !view.data) {
    return;
  }
  const d = view.data;
  plate.hidden = false;
  plate.textContent = '';
  plate.append(el('div', 'kicker', str('stats.all_time')));
  plate.append(el('h3', null, str('stats.since_this_page_started_counting')));
  plate.append(el('p', 'plate-note',
    d.firstDay
      ? str('stats.counting_began_on_the_four_on', { longDay: longDay(d.firstDay) })
      : str('stats.the_four_on_the_right_are')));
  const strip = el('div', 'alltime');
  const heroBox = el('div', 'hero-box');
  const hero = el('div', 'hero', count(d.allTime.laps));
  heroBox.append(hero);
  heroBox.append(el('span', 'hero-label', str('stats.laps_flown')));
  strip.append(heroBox);
  const facts = el('div', 'facts');
  const rows = [
    [count(d.allTime.sessions), 'Sessions'],
    [count(d.allTime.visits), str('stats.pilot_days')],
    [flightTime(d.allTime.flightS), str('stats.flight_time')],
    [count(d.allTime.countries), 'Countries'],
    [count(d.board.tracks), 'Tracks'],
    [count(d.board.times), str('app.times_posted')],
    [count(d.board.pilots), str('stats.named_pilots')],
    [count(d.board.pilotsOnMoreThanOneDay), str('stats.back_another_day')],
  ];
  for (const [value, label] of rows) {
    const fact = el('div', 'fact');
    fact.append(el('span', 'fact-value', value));
    fact.append(el('span', 'fact-label', label));
    facts.append(fact);
  }
  strip.append(facts);
  plate.append(strip);
}

function paintOptOut() {
  const box = byId('stats-optout');
  if (!box) {
    return;
  }
  box.textContent = '';
  if (privacyRefused()) {
    box.append(el('p', 'optout-said',
      str('stats.your_browser_asked_not_to_be')));
    return;
  }
  const row = el('div', 'optout-row');
  const input = el('input');
  input.type = 'checkbox';
  input.id = 'stats-count-me';
  input.checked = !optedOut();
  const label = el('label', null, str('stats.count_this_browser'));
  label.setAttribute('for', 'stats-count-me');
  row.append(input);
  row.append(label);
  box.append(row);
  const note = el('p', 'optout-note',
    str('stats.off_means_this_browser_sends_nothing'));
  box.append(note);
  input.addEventListener('change', () => {
    setOptedOut(!input.checked);
    note.textContent = input.checked
      ? str('stats.counted_nothing_that_identifies_you_is')
      : str('stats.not_counted_this_browser_sends_nothing');
  });
}

function paintEmpty() {
  const notice = byId('stats-notice');
  if (!notice || !view.data) {
    return;
  }
  notice.textContent = '';
  const d = view.data;
  if (d.allTime.visits || d.allTime.sessions || d.allTime.laps) {
    return;
  }
  const box = el('div', 'empty panel');
  box.append(el('h2', null, str('stats.nothing_counted_yet_2')));
  box.append(el('p', null, d.firstDay
    ? str('stats.counting_started_on_the_first_flight', { longDay: longDay(d.firstDay) })
    : str('stats.counting_starts_with_the_first_visit')));
  notice.append(box);
}

function paint() {
  paintFresh();
  if (!view.data) {
    return;
  }
  paintEmpty();
  paintTiles();
  paintTrend();
  paintRanks();
  paintAllTime();
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function refresh() {
  if (view.fetching || !view.url) {
    return;
  }
  view.fetching = true;
  try {
    const res = await fetch(view.url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || str('app.the_board_answered', { status: res.status }));
    }
    view.data = body;
    view.error = '';
  } catch (e) {
    /* The previous numbers stay on screen. A skeleton here would throw away
     * a good answer and jump the layout for a failure that is usually one
     * missed poll. */
    view.error = e.message || str('stats.the_board_could_not_be_reached');
  } finally {
    view.fetching = false;
  }
  paint();
}

function tick() {
  clearTimeout(view.timer);
  if (!view.shown || document.hidden) {
    return;
  }
  view.timer = setTimeout(async () => {
    await refresh();
    tick();
  }, POLL_MS);
}

/*
 * Show or hide the tab. Polling runs only while this tab is the one on
 * screen AND the document is visible: a board left open in a background tab
 * overnight should cost the service nothing.
 */
export function showStats(on) {
  const wasShown = view.shown;
  view.shown = Boolean(on);
  clearTimeout(view.timer);
  clearInterval(view.fresh);
  if (!view.shown) {
    return;
  }
  paintOptOut();
  if (!wasShown || !view.data) {
    refresh();
  } else {
    paintFresh();
  }
  view.fresh = setInterval(paintFresh, 5000);
  tick();
}

export function mountStats(url) {
  view.url = url;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(view.timer);
      clearInterval(view.fresh);
      return;
    }
    if (view.shown) {
      refresh();
      view.fresh = setInterval(paintFresh, 5000);
      tick();
    }
  });
  /* The charts are drawn at real pixels, so a resize is a redraw. Debounced
   * the same way the track plans are. */
  window.addEventListener('resize', () => {
    clearTimeout(view.resize);
    view.resize = setTimeout(() => {
      if (view.shown && view.data) {
        paintTrend();
      }
    }, 160);
  });
}
