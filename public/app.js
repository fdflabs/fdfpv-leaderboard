/*
 * app.js: the board page.
 *
 * One card per published track, under an aircraft switch, a search, an
 * author list, a sort and a tag bar. A card's art is the track's plan
 * drawn by plan.js from the list payload (a room with an animation on
 * file shows that instead), so the whole grid costs two requests and no
 * WebGL. Times are fetched only for tracks that have any, and those same
 * times feed the podium on each card, the standings rail and the counts
 * in the masthead. A track is an address, #track=<id>, which opens its
 * sheet: the plan at full size, the simulator's own orbit camera in a
 * frame, every time posted, and the links to fly or remix it.
 *
 * Links to the simulator all open one named tab, so flying three tracks
 * does not leave three simulators running.
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
import { guessSimOrigin as simFromAddress, landingOrigin as frontDoorOf } from './origins.js';
import { mountStats, pingVisit, showStats } from './stats.js';
import { fillCredits } from './credits.js';
import { ADMIN_TOKEN_KEY, CRAFT_KEY, moveRenamedKeys } from './keys.js';
import { str, LOCALES, LOCALE_NAMES, currentLocale, rememberLocale } from './strings/index.js';
import { fieldSize, paintPlans, planCanvas, planLabel } from './plan.js';

moveRenamedKeys(() => sessionStorage, 'session');
moveRenamedKeys(() => localStorage, 'local');

/* The markup's fixed sentences carry data-str keys. */
for (const holder of document.querySelectorAll('[data-str]')) {
  holder.textContent = str(holder.dataset.str);
}

/* ================================================================== */
/* Addresses                                                           */
/* ================================================================== */

/*
 * The board is served at its own root and under /board/ on the VM, so
 * everything this page asks for is resolved against its own directory; a
 * request for '/api/...' from /board/ would leave the board entirely.
 */
const PAGE_DIR = new URL('./', document.baseURI);
const here = (path) => new URL(path, PAGE_DIR).href;

/*
 * This page's own address with its mount, which the simulator needs in
 * ?board= to find its way back. It outranks /api/config's boardOrigin:
 * the server sees only a host, and behind the mount that host is the
 * landing page.
 */
const BOARD_HOME = PAGE_DIR.href.replace(/\/+$/, '');

/* Where the simulator is, from this page's address alone (origins.js).
 * /api/config corrects it when it answers. */
function simulatorGuess() {
  try {
    return simFromAddress(window.location, PAGE_DIR);
  } catch {
    return null;
  }
}

/* The front door, which always has an answer (origins.js). */
function frontDoor() {
  try {
    return `${frontDoorOf(window.location, PAGE_DIR)}/`;
  } catch {
    return null;
  }
}

/*
 * One simulator tab and one board tab. These links carry no rel=noopener:
 * a named target asked for noopener is treated as _blank, which would open
 * a fresh simulator on every click. The names match the simulator's
 * src/share/windows.js. A modifier click still opens a new tab.
 */
const SIM_WINDOW = 'fdfpv-sim';
const BOARD_WINDOW = 'fdfpv-board';

/* The simulator reads ?lang= too. */
function inLanguage(url) {
  const lang = currentLocale();
  return lang === 'en' ? url : `${url}${url.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`;
}

const trackHash = (id) => `#track=${encodeURIComponent(id)}`;

/* ================================================================== */
/* Small helpers                                                       */
/* ================================================================== */

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

const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* Facts on one line, separated by a middot: a list, not a sentence. */
const dotted = (parts) => parts.filter(Boolean).join(' · ');

const stillness = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function lapText(ms) {
  if (ms == null || !Number.isFinite(ms)) {
    return '--.--';
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = ms / 1000 - minutes * 60;
  return minutes > 0 ? `${minutes}:${seconds.toFixed(2).padStart(5, '0')}` : seconds.toFixed(2);
}

/* A lap with its hundredths in their own span, a shade quieter. */
function lapNode(ms, cls = 'tm', prefix = '') {
  const node = make('span', cls);
  if (ms == null || !Number.isFinite(ms)) {
    node.classList.add('empty');
    node.textContent = '--.--';
    return node;
  }
  const text = lapText(ms);
  const dot = text.lastIndexOf('.');
  node.append(`${prefix}${text.slice(0, dot)}`, make('span', 'frac', text.slice(dot)));
  return node;
}

function dateOf(iso) {
  if (!iso) {
    return null;
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

function dateText(iso) {
  const at = dateOf(iso);
  return at ? at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

/* How long ago, in steps a reader would say; a month on, the date. */
const AGO_STEPS = [
  [45, () => 'just now'],
  [90, () => '1 min ago'],
  [3600, (s) => `${Math.floor(s / 60)} min ago`],
  [5400, () => '1 hour ago'],
  [86400, (s) => `${Math.floor(s / 3600)} hours ago`],
  [172800, () => '1 day ago'],
  [86400 * 30, (s) => `${Math.floor(s / 86400)} days ago`],
];

function agoText(iso) {
  const at = dateOf(iso);
  if (!at) {
    return '';
  }
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  const step = AGO_STEPS.find(([limit]) => seconds < limit);
  return step ? step[1](seconds) : dateText(iso);
}

/*
 * When an admin's sign in runs out, a few hours away: today gets a clock
 * time, tomorrow a day and a time, anything later the date and time. A
 * bare date would say nothing about a sign in that ends this evening.
 */
function untilText(iso) {
  const at = dateOf(iso);
  if (!at) {
    return '';
  }
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(at) - midnight(now)) / 86400000);
  if (days <= 0) {
    return str('app.at', { clock });
  }
  return days === 1 ? str('app.tomorrow_at', { clock }) : str('app.at_2', { formatWhen: dateText(iso), clock });
}

/* ================================================================== */
/* Tracks, classes and boards                                          */
/* ================================================================== */

/* MIRRORS TRACK_CLASSES in src/validate.js. A track from before classes
 * is a field, which it is. */
const CLASSES = ['full', 'micro', 'wing'];
/* What a pilot flies, not what the document calls it. */
const AIRCRAFT_NAME = { full: str('app.five_inch'), micro: '65 mm whoop', wing: str('app.fixed_wing') };
/* The simulator's airframe id per class (its configs/airframes.js). */
const AIRFRAME_ID = { full: '5inch', micro: 'whoop65', wing: 'wing1000' };
/* MIRRORS MAP_IDS in src/validate.js, named as the simulator names them. */
const WORLD_NAME = { swiss2: str('app.world_swiss2'), alps: str('app.world_alps') };

const classOf = (track) => (track && CLASSES.includes(track.trackClass) ? track.trackClass : 'full');
const worldOf = (track) => (track && WORLD_NAME[track.map]) || '';
const tagsOf = (track) => (Array.isArray(track.tags) ? track.tags : []);
const timesOn = (track) => (track.times || 0) + (track.wing ? track.wing.times : 0);

/*
 * What the page knows. `craft` is the aircraft switch, which is a choice
 * and not a filter: one class is always on, and a track is offered only to
 * the aircraft it seats. The tag filter is a set and means AND, because a
 * reader ticking two boxes wants tracks that are both.
 */
const board = {
  config: { simOrigin: simulatorGuess() || 'http://127.0.0.1:8000', boardOrigin: BOARD_HOME },
  tracks: [],
  timesById: new Map(),
  query: '',
  sort: 'flown',
  tags: new Set(),
  author: '',
  craft: 'full',
  openId: null,
  lastFocus: null,
};

/* The tag vocabulary, served with the track list so the page offers
 * exactly what the board accepts (src/validate.js is the copy of record). */
let tagVocabulary = [];
const tagNames = new Map();
const tagName = (id) => tagNames.get(id) || id;

const loadedTimes = (id) => board.timesById.get(id) || null;

/*
 * A track built inside a world has two boards: the quads' (times with no
 * craft) and the planes' (times naming a fixed wing). Under Fixed wing such
 * a track shows its plane board; everywhere else, the quads'.
 */
const onPlaneBoard = (track) => board.craft === 'wing' && Boolean(track?.map);

function boardRows(track, times) {
  if (!times || !track || !track.map) {
    return times;
  }
  const planes = onPlaneBoard(track);
  return times.filter((row) => Boolean(row.craft) === planes);
}

/* The track as the current board sees it: that board's count and record. */
function asSeen(track) {
  if (!onPlaneBoard(track)) {
    return track;
  }
  return { ...track, times: track.wing ? track.wing.times : 0, best: track.wing ? track.wing.best : null };
}

function trackById(id) {
  const track = board.tracks.find((t) => t.id === id);
  return track ? asSeen(track) : null;
}

/* Every board a track has, as separate lists; a record is per board. */
function boardsIn(times) {
  return [times.filter((row) => !row.craft), times.filter((row) => row.craft)].filter((rows) => rows.length);
}

/* Whether a track is on an aircraft's list: its own class, or under Fixed
 * wing a world track some fixed wing fits. */
function offeredTo(track, craft) {
  if (craft === 'wing' && track.map && Array.isArray(track.planes) && track.planes.length) {
    return true;
  }
  return classOf(track) === craft;
}

const aircraftOf = (track) => AIRCRAFT_NAME[onPlaneBoard(track) ? 'wing' : classOf(track)];

function bestLap(track) {
  const rows = boardRows(track, loadedTimes(track.id));
  if (rows && rows.length) {
    return rows[0].lapMs;
  }
  return track.best ? track.best.lapMs : null;
}

/* ================================================================== */
/* Links to the simulator                                              */
/* ================================================================== */

/*
 * Which aircraft a link seats: a chased lap's own plane, the first plane
 * that fits on a plane board, otherwise the track's class. Saying so lets
 * the simulator draw the right world from the first frame.
 */
function craftQuery(id, craft) {
  const track = board.tracks.find((t) => t.id === id);
  if (!track) {
    return '';
  }
  if (craft) {
    return `&craft=${encodeURIComponent(craft)}`;
  }
  return onPlaneBoard(track) ? `&craft=${encodeURIComponent(track.planes[0])}` : `&craft=${AIRFRAME_ID[classOf(track)]}`;
}

/* Fly the track; with a ghost id, chase that recorded lap. */
function flyHref(config, id, ghostId, craft) {
  const back = encodeURIComponent(config.boardOrigin);
  const href = inLanguage(`${config.simOrigin}/?map=custom&share=${encodeURIComponent(id)}&board=${back}${craftQuery(id, craft)}`);
  return ghostId ? `${href}&ghost=${encodeURIComponent(ghostId)}` : href;
}

/* The builder opens on the track's own class. */
function remixHref(config, id) {
  const back = encodeURIComponent(config.boardOrigin);
  const track = board.tracks.find((t) => t.id === id);
  const cls = track ? `&class=${classOf(track)}` : '';
  return inLanguage(`${config.simOrigin}/src/trackbuilder/index.html?share=${encodeURIComponent(id)}&board=${back}${cls}`);
}

/* Relative to simOrigin with its trailing slash, so a simulator mounted
 * under a path keeps the path. */
function orbitHref(config, id) {
  const url = new URL('src/share/orbit.html', `${config.simOrigin}/`);
  url.searchParams.set('map', 'custom');
  url.searchParams.set('share', id);
  url.searchParams.set('board', config.boardOrigin);
  return url.href;
}

/* The credits roll is the simulator's #credits page. */
function creditsHref(config) {
  const sim = String(config?.simOrigin || simulatorGuess() || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  try {
    if (window.location.hostname === 'fdfpv.example' || window.location.hostname === 'www.fdfpv.example') {
      return `${window.location.origin}/sim/#credits`;
    }
  } catch {
    /* No window. */
  }
  return `${sim}/#credits`;
}

function simLink(cls, text, href) {
  const a = make('a', cls, text);
  a.href = href;
  a.target = SIM_WINDOW;
  return a;
}

/* The mint "chase" that races a recorded lap, on the podium and the sheet. */
function chaseLink(config, trackId, row) {
  const a = simLink('chase', 'chase', flyHref(config, trackId, row.id, row.craft));
  a.title = str('app.fly_against_s_recorded_lap', { name: row.name });
  return a;
}

/* ================================================================== */
/* Order and filters                                                   */
/* ================================================================== */

const newerFirst = (a, b) => String(b.publishedUtc || '').localeCompare(String(a.publishedUtc || ''));
const biggerFirst = (a, b) => (b.gates || 0) - (a.gates || 0);

/*
 * Most flown first by default, since a track with times has something to
 * beat; gate count breaks ties so a young board leads with real layouts.
 */
const ORDERS = {
  flown: (a, b) => (b.times || 0) - (a.times || 0) || biggerFirst(a, b) || newerFirst(a, b),
  fastest: (a, b) => {
    const [x, y] = [bestLap(a), bestLap(b)];
    if (x == null || y == null) {
      return x == null && y == null ? biggerFirst(a, b) : (x == null ? 1 : -1);
    }
    return x - y;
  },
  biggest: (a, b) => biggerFirst(a, b) || (b.times || 0) - (a.times || 0),
  newest: newerFirst,
  name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }),
};

/* A search matches the name, the publisher, the designer and series, or
 * any pilot with a time on it. */
function matchesSearch(track, needle) {
  if (!needle) {
    return true;
  }
  const said = [track.name, track.author, track.designer, track.series];
  if (said.some((v) => String(v || '').toLowerCase().includes(needle))) {
    return true;
  }
  return Boolean(loadedTimes(track.id)?.some((row) => String(row.name).toLowerCase().includes(needle)));
}

/* Everything but the tags, which are counted against this so a tag can
 * grey out instead of leading to nothing. */
function beforeTags() {
  const needle = board.query.trim().toLowerCase();
  return board.tracks.filter((t) => matchesSearch(t, needle)
    && (!board.author || String(t.author) === board.author)
    && (!board.craft || offeredTo(t, board.craft)));
}

function shownTracks() {
  const wanted = [...board.tags];
  return beforeTags()
    .filter((t) => wanted.every((id) => tagsOf(t).includes(id)))
    .map(asSeen)
    .sort(ORDERS[board.sort] || ORDERS.flown);
}

function tagTally(tracks) {
  const tally = new Map();
  for (const id of tracks.flatMap(tagsOf)) {
    tally.set(id, (tally.get(id) || 0) + 1);
  }
  return tally;
}

/* Authors, most tracks first, then by name. */
function authorsByTracks() {
  const tally = new Map();
  for (const t of board.tracks) {
    const name = String(t.author || '');
    tally.set(name, (tally.get(name) || 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
}

/* ================================================================== */
/* Cards                                                               */
/* ================================================================== */

function sizeOf(track) {
  const plan = track.plan || {};
  const gates = track.gates === 1 ? '1 gate' : `${track.gates} gates`;
  return { w: Math.round(Number(plan.width) || 0), d: Math.round(Number(plan.depth) || 0), gates };
}

/*
 * A card's art: the plan, or for a room with an animation on file, that
 * GIF (a room's plan is a near empty rectangle and its difficulty is
 * vertical). The board decides which tracks may have one. Reduced motion
 * gets the plan, since no stylesheet can stop a GIF; a GIF that fails to
 * load is swapped for the plan rather than a broken image.
 */
function cardArt(track) {
  if (!track.hasGif || stillness()) {
    return planCanvas(track.plan, planLabel(track));
  }
  const img = document.createElement('img');
  img.className = 'gif-art';
  img.loading = 'lazy';
  img.decoding = 'async';
  const version = track.gifUtc ? `?v=${encodeURIComponent(track.gifUtc)}` : '';
  img.src = here(`api/tracks/${encodeURIComponent(track.id)}/gif${version}`);
  const { w, d, gates } = sizeOf(track);
  img.alt = str('app.a_lap_of_in_a_by', { name: track.name, gates, w, d });
  img.addEventListener('error', () => {
    if (img.parentElement) {
      const plan = planCanvas(track.plan, planLabel(track));
      img.replaceWith(plan);
      paintPlans(plan.parentElement || document);
    }
  }, { once: true });
  return img;
}

/* "Designed by X for S, published by A" when the document names a
 * designer (the RaceGOW rooms), else "by A"; then the gate count. */
function bylineOf(track) {
  const by = make('p', 'by');
  if (track.designer) {
    by.append(str('app.designed_by'), make('b', null, track.designer));
    if (track.series) {
      by.append(str('app.for', { series: track.series }));
    }
    by.append(str('app.published_by', { author: track.author }));
  } else {
    by.append('by ', make('b', null, track.author));
  }
  by.append(` · ${counted(track.gates, 'gate', 'gates')}`);
  return by;
}

const moreText = (n) => (n > 3 ? str('app.all', { plural: counted(n, 'time', 'times') }) : str('app.track_detail'));

function cardFor(track, config) {
  const card = make('article', 'card');
  card.dataset.id = track.id;

  const tile = make('a', 'tile');
  tile.href = trackHash(track.id);
  tile.setAttribute('aria-label', str('app.and_times', { name: track.name, v2: track.hasGif ? str('app.a_lap') : 'plan' }));
  tile.append(cardArt(track));
  const chip = worldOf(track) || fieldSize(track);
  if (chip) {
    tile.append(make('span', 'tile-chip', chip));
  }
  /* The five inch is the norm and goes unmarked. */
  if (classOf(track) !== 'full' || onPlaneBoard(track)) {
    tile.append(make('span', 'tile-craft', aircraftOf(track)));
  }
  if (track.times > 0) {
    tile.append(make('span', 'tile-flown', counted(track.times, 'time', 'times')));
  }
  card.append(tile);

  /* No record block until somebody has flown it: a card of dashes reads
   * as a form. The quiet line below says it once. */
  const record = make('div', 'record');
  record.hidden = !track.best;
  record.append(
    make('span', 'record-label', str('app.record')),
    lapNode(track.best ? track.best.lapMs : null, 'record-time'),
    make('div', 'record-holder', track.best ? track.best.name : ''),
  );
  const head = make('div', 'head');
  head.append(make('h2', null, track.name), bylineOf(track), record);

  const tags = make('div', 'tags');
  tags.append(...tagsOf(track).map((id) => make('span', null, tagName(id))));
  const podium = make('ol', 'podium');
  podium.hidden = true;
  const none = make('p', 'none', str('app.no_time_posted_yet'));
  none.hidden = Boolean(track.best);

  const fly = make('a', 'btn primary small', str('app.fly_this_track'));
  fly.href = flyHref(config, track.id);
  fly.target = SIM_WINDOW;
  fly.setAttribute('aria-label', str('app.fly_opens_it_in_the_simulator', { name: track.name }));
  const more = make('a', 'text more', moreText(track.times));
  more.href = trackHash(track.id);
  const actions = make('div', 'actions');
  actions.append(fly, more);

  const body = make('div', 'body');
  body.append(head, tags, podium, none, actions);
  card.append(body);
  return card;
}

/*
 * The top three on a card, once its times arrive, into a card already in
 * the page. One time is a record and not a podium, and the holder's name
 * appears once: on the record line alone, or on the podium.
 */
function paintPodium(card, times) {
  const part = (cls) => card.querySelector(cls);
  const [podium, none, more, record] = ['.podium', '.none', '.more', '.record'].map(part);
  if (!podium || !none) {
    return;
  }
  podium.textContent = '';
  const any = Boolean(times && times.length);
  none.hidden = any;
  if (record) {
    record.hidden = !any;
  }
  if (!any) {
    podium.hidden = true;
    return;
  }
  part('.record-time')?.replaceWith(lapNode(times[0].lapMs, 'record-time'));
  const ranked = times.length > 1;
  const holder = part('.record-holder');
  if (holder) {
    holder.textContent = ranked ? '' : times[0].name;
  }
  podium.hidden = !ranked;
  if (!ranked) {
    return;
  }
  times.slice(0, 3).forEach((row, i) => {
    const li = make('li', `podium-row r${i + 1}`);
    li.append(make('span', 'rk', String(i + 1)), make('span', 'nm', row.name), lapNode(row.lapMs, 'tm'));
    if (row.hasGhost && row.id) {
      li.classList.add('has-chase');
      li.append(chaseLink(board.config, card.dataset.id, row));
    }
    podium.append(li);
  });
  if (more) {
    more.textContent = moreText(times.length);
  }
}

function placeholders(list, n) {
  list.textContent = '';
  for (let i = 0; i < n; i += 1) {
    const body = make('div', 'body');
    body.append(make('div', 'bone wide'), make('div', 'bone thin'));
    const card = make('article', 'card skeleton');
    card.append(make('div', 'tile'), body);
    list.append(card);
  }
}

/*
 * When the filters leave nothing: say which filters did it, name the
 * aircraft separately (it is the reading choice, not a filter, and Clear
 * leaves it alone), and offer to clear the rest.
 */
function nothingMatches() {
  const reasons = [];
  if (board.query.trim()) {
    reasons.push(str('app.the_search', { v1: board.query.trim() }));
  }
  if (board.author) {
    reasons.push(str('app.tracks_built_by', { author: board.author }));
  }
  if (board.tags.size) {
    reasons.push([...board.tags].map(tagName).join(' and '));
  }
  const clear = make('button', 'btn small', str('app.clear_the_filters'));
  clear.type = 'button';
  clear.addEventListener('click', () => {
    board.query = '';
    board.author = '';
    board.tags.clear();
    const [find, by] = [$('find'), $('by')];
    if (find) {
      find.value = '';
    }
    if (by) {
      by.value = '';
    }
    paintTags();
    paintGrid();
    find?.focus();
  });
  const box = make('div', 'empty panel');
  box.append(
    make('h2', null, str('app.nothing_matches_that')),
    make('p', 'empty-craft', str('app.you_are_looking_at_the_tracks', { v1: AIRCRAFT_NAME[board.craft].toLowerCase() })),
    make('p', null, reasons.length
      ? str('app.no_track_on_the_board_is', { joined: dotted(reasons) })
      : str('app.no_track_on_the_board_answers')),
    clear,
  );
  return box;
}

function paintGrid() {
  const list = $('list');
  const notice = $('notice');
  const tally = $('count');
  const shown = shownTracks();
  list.textContent = '';
  notice.textContent = '';
  for (const track of shown) {
    const card = cardFor(track, board.config);
    list.append(card);
    const rows = boardRows(track, loadedTimes(track.id));
    if (rows) {
      paintPodium(card, rows);
    }
  }
  paintPlans(list);
  const all = counted(board.tracks.length, 'track', 'tracks');
  if (tally) {
    tally.textContent = shown.length === board.tracks.length ? all : str('app.of', { length: shown.length, plural: all });
  }
  if (!shown.length && board.tracks.length) {
    notice.append(nothingMatches());
  }
}

/*
 * The whole vocabulary, not only the tags in use, so a reader sees that a
 * kind exists; a tag nobody wears is disabled (unless it is on, or the
 * reader could not untick it), never hidden, so the bar does not reflow.
 */
function paintTags() {
  const bar = $('tagbar');
  if (!bar) {
    return;
  }
  const tally = tagTally(beforeTags());
  bar.textContent = '';
  bar.hidden = tagVocabulary.length === 0;
  for (const tag of tagVocabulary) {
    const n = tally.get(tag.id) || 0;
    const on = board.tags.has(tag.id);
    const btn = make('button', 'tag');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(on));
    btn.disabled = n === 0 && !on;
    btn.append(make('span', null, tag.label), make('span', 'n', String(n)));
    btn.addEventListener('click', () => {
      if (!board.tags.delete(tag.id)) {
        board.tags.add(tag.id);
      }
      paintTags();
      paintGrid();
    });
    bar.append(btn);
  }
}

function paintAuthors() {
  const select = $('by');
  if (!select) {
    return;
  }
  const kept = board.author;
  select.textContent = '';
  const option = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  select.append(option('', str('app.anyone')), ...authorsByTracks().map(([name, n]) => option(name, n > 1 ? `${name} (${n})` : name)));
  /* An author whose last track went must not stay selected. */
  select.value = [...select.options].some((o) => o.value === kept) ? kept : '';
  board.author = select.value;
}

/* ================================================================== */
/* Standings and counts                                                */
/* ================================================================== */

/* A pilot ranks by records held, then podiums, then laps: posting more
 * laps is not being quicker. */
function standings() {
  const pilots = new Map();
  for (const track of board.tracks) {
    for (const rows of boardsIn(loadedTimes(track.id) || [])) {
      rows.forEach((row, place) => {
        const p = pilots.get(row.name) || { name: row.name, laps: 0, records: 0, podiums: 0 };
        p.laps += 1;
        p.records += place === 0 ? 1 : 0;
        p.podiums += place < 3 ? 1 : 0;
        pilots.set(row.name, p);
      });
    }
  }
  return [...pilots.values()].sort((a, b) => b.records - a.records || b.podiums - a.podiums
    || b.laps - a.laps || a.name.localeCompare(b.name));
}

function recentTimes(limit) {
  const rows = [];
  for (const track of board.tracks) {
    for (const rowsOfBoard of boardsIn(loadedTimes(track.id) || [])) {
      rowsOfBoard.forEach((row, place) => rows.push({ ...row, course: track, best: place === 0 }));
    }
  }
  return rows.sort((a, b) => String(b.postedUtc || '').localeCompare(String(a.postedUtc || ''))).slice(0, limit);
}

function railSection(kicker, title) {
  const section = make('section', 'rail-block panel');
  section.append(make('div', 'kicker', kicker), make('h2', null, title));
  return section;
}

function paintRail() {
  const rail = $('rail');
  const deck = $('deck');
  if (!rail || !deck) {
    return;
  }
  const pilots = standings();
  const recent = recentTimes(6);
  rail.textContent = '';
  rail.hidden = pilots.length === 0;
  deck.classList.toggle('has-rail', pilots.length > 0);
  if (!pilots.length) {
    return;
  }
  const table = railSection('Standings', str('app.fastest_pilots'));
  pilots.slice(0, 8).forEach((p, i) => {
    const row = make('div', `standing p${i + 1}`);
    row.append(
      make('span', 'rk', String(i + 1)),
      make('span', 'nm', p.name),
      make('span', 'sc', String(p.records)),
      make('span', 'mt', dotted([p.records === 1 ? 'record held' : 'records held', p.laps > p.records ? counted(p.laps, 'lap', 'laps') : ''])),
    );
    table.append(row);
  });
  table.append(make('p', 'rail-note', str('app.ranked_by_track_records_held_then')));
  rail.append(table);
  if (!recent.length) {
    return;
  }
  const feed = make('div', 'feed');
  for (const row of recent) {
    const on = make('a', 'on', row.course.name);
    on.href = trackHash(row.course.id);
    const line = make('div', 'feed-row');
    line.append(make('span', 'nm', row.name), lapNode(row.lapMs, `rail-time${row.best ? ' best' : ''}`), on, make('span', 'ago', agoText(row.postedUtc)));
    feed.append(line);
  }
  const lately = railSection('Lately', str('app.times_posted'));
  lately.append(feed);
  rail.append(lately);
}

function paintCounts() {
  const tracks = board.tracks.length;
  const times = board.tracks.reduce((sum, t) => sum + timesOn(t), 0);
  const pilots = standings().length;
  const mast = $('mast-stats');
  if (mast) {
    mast.hidden = !tracks;
  }
  for (const [id, n] of [['stat-courses', tracks], ['stat-times', times]]) {
    if ($(id)) {
      $(id).textContent = String(n);
    }
  }
  const pilotCell = $('stat-pilots');
  if (pilotCell) {
    pilotCell.textContent = String(pilots);
    pilotCell.parentElement.hidden = pilots === 0;
  }
  const spine = $('spine-stats');
  if (spine) {
    spine.textContent = tracks
      ? dotted([counted(tracks, 'track', 'tracks'), counted(times, 'time', 'times'), pilots ? counted(pilots, 'pilot', 'pilots') : ''])
      : '';
  }
}

/* ================================================================== */
/* Times                                                               */
/* ================================================================== */

/* One request per track however many callers want it at once. */
const pending = new Map();

async function loadTimes(id) {
  if (board.timesById.has(id)) {
    return board.timesById.get(id);
  }
  if (!pending.has(id)) {
    pending.set(id, (async () => {
      try {
        const res = await fetch(here(`api/tracks/${encodeURIComponent(id)}`));
        const detail = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(detail.error || str('app.those_times_could_not_be_loaded'));
        }
        const times = detail.times || [];
        board.timesById.set(id, times);
        return times;
      } finally {
        pending.delete(id);
      }
    })());
  }
  return pending.get(id);
}

/* Times for every track that has any, painted onto its card as they come;
 * a track whose times fail keeps the record from the list. */
async function fetchAllTimes() {
  await Promise.all(board.tracks.filter((t) => timesOn(t) > 0).map(async (track) => {
    try {
      const times = await loadTimes(track.id);
      const card = document.querySelector(`.card[data-id="${CSS.escape(track.id)}"]`);
      if (card) {
        paintPodium(card, boardRows(track, times));
      }
    } catch {
      /* The list's record stays on the card. */
    }
  }));
  paintRail();
  paintCounts();
}

/* ================================================================== */
/* The aircraft switch                                                 */
/* ================================================================== */

/*
 * The aircraft this visitor is here for: the address (a class or an
 * airframe id, whichever the linking page had), then the last choice, then
 * the five inch.
 */
function chosenCraft() {
  try {
    const asked = new URL(window.location.href).searchParams.get('craft');
    const fromLink = CLASSES.includes(asked) ? asked : CLASSES.find((cls) => AIRFRAME_ID[cls] === asked);
    if (fromLink) {
      return fromLink;
    }
  } catch {
    /* No address to read. */
  }
  try {
    const kept = localStorage.getItem(CRAFT_KEY);
    return CLASSES.includes(kept) ? kept : 'full';
  } catch {
    return 'full';
  }
}

/* Remembered, and written into the address so a copied link carries it. */
function keepCraft(craft) {
  const cls = CLASSES.includes(craft) ? craft : 'full';
  try {
    localStorage.setItem(CRAFT_KEY, cls);
  } catch {
    /* Private window: the choice lasts this visit. */
  }
  try {
    const url = new URL(window.location.href);
    if (cls === 'full') {
      url.searchParams.delete('craft');
    } else {
      url.searchParams.set('craft', cls);
    }
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* No history. */
  }
}

function chooseCraft(craft, { remember = true } = {}) {
  board.craft = CLASSES.includes(craft) ? craft : 'full';
  for (const cls of CLASSES) {
    const btn = $(`craft-${cls}`);
    if (btn) {
      btn.classList.toggle('is-on', board.craft === cls);
      btn.setAttribute('aria-pressed', String(board.craft === cls));
    }
  }
  if (remember) {
    keepCraft(board.craft);
  }
  paintCraftCounts();
  paintTags();
  paintGrid();
}

/* Counted over the whole board: the switch sits above the filters. */
function paintCraftCounts() {
  for (const cls of CLASSES) {
    const n = board.tracks.filter((t) => offeredTo(t, cls)).length;
    const cell = $(`craft-${cls}-count`);
    if (cell) {
      cell.textContent = n ? counted(n, 'track', 'tracks') : 'none yet';
    }
  }
}

/* ================================================================== */
/* Admin                                                               */
/* ================================================================== */

/*
 * The sign in lives in sessionStorage: never a cookie, because the board
 * reflects any origin (cors() in src/server.js) and a credential the
 * browser sent by itself would make that a grant to every site; and not
 * localStorage, because closing the tab is a fine moment to lose an admin
 * credential. The server ends it after twelve hours anyway.
 */
const admin = { token: '', email: '', kind: '', expiresUtc: '', sponsors: [] };
const isSignedIn = () => Boolean(admin.token);

function keptToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    /* Refused: signing in lasts until a reload. */
    return '';
  }
}

function keepToken(token) {
  try {
    if (token) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    /* Refused: the copy in memory is the one requests use. */
  }
}

/* Every admin request: the token attached, and a refusal of it (expired,
 * whitelist or password changed) drops it at once so the page goes back
 * to its signed out face. */
async function adminRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (admin.token) {
    headers.authorization = str('app.bearer', { token: admin.token });
  }
  const res = await fetch(here(path), { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    signOut();
    const err = new Error(body.error || str('app.that_sign_in_is_no_longer'));
    err.signedOut = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(body.error || str('app.the_board_answered', { status: res.status }));
  }
  return body;
}

function takeSession(body, kind) {
  admin.email = body.email || '';
  admin.kind = kind;
  admin.expiresUtc = body.expiresUtc || '';
  admin.sponsors = Array.isArray(body.sponsors) ? body.sponsors : [];
}

function signOut() {
  Object.assign(admin, { token: '', email: '', kind: '', expiresUtc: '', sponsors: [] });
  keepToken('');
  paintAdmin();
}

/* Signed in, the button shows whose hands are on the board, by the local
 * part of the address. */
function paintAdminButton() {
  const btn = $('admin-open');
  if (!btn) {
    return;
  }
  btn.classList.toggle('is-on', isSignedIn());
  btn.textContent = isSignedIn() ? (admin.email.split('@')[0] || str('app.signed_in')) : 'Admin';
  btn.setAttribute('aria-label', isSignedIn() ? str('app.admin_signed_in_as', { v1: admin.email || str('app.this_board_s_token') }) : 'Admin');
}

/*
 * Each sponsor's link, for the admin to copy into an email. The list is
 * here and not on the statistics tab because it includes sponsors with no
 * traffic yet, which is a commercial fact; their numbers are public there.
 */
function paintSponsors() {
  const host = $('admin-sponsors');
  if (!host) {
    return;
  }
  host.textContent = '';
  host.hidden = !isSignedIn();
  if (!isSignedIn()) {
    return;
  }
  host.append(make('h3', null, str('app.sponsor_links')));
  if (!admin.sponsors.length) {
    host.append(make('p', null, str('app.no_sponsors_are_set_on_this')));
    return;
  }
  host.append(make('p', null, str('app.each_link_lands_in_the_simulator')));
  for (const sponsor of admin.sponsors) {
    const copy = make('button', 'btn small', str('app.copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sponsor.link || '');
        copy.textContent = str('app.copied');
      } catch {
        /* No clipboard here; the link is on screen to select. */
        copy.textContent = str('app.select_it');
      }
      setTimeout(() => {
        copy.textContent = str('app.copy');
      }, 1600);
    });
    const row = make('div', 'sponsor-row');
    row.append(make('span', 'sponsor-name', sponsor.name || sponsor.slug), make('span', 'sponsor-link', sponsor.link || ''), copy);
    host.append(row);
  }
}

/* The panel's two faces and the sheet's control follow one fact, so they
 * are always painted together. */
function paintAdmin() {
  paintAdminButton();
  const [form, signed] = [$('admin-signin'), $('admin-signed')];
  if (form) {
    form.hidden = isSignedIn();
  }
  if (signed) {
    signed.hidden = !isSignedIn();
  }
  if ($('admin-who')) {
    $('admin-who').textContent = admin.email || str('app.this_board_s_own_token');
  }
  const until = $('admin-until');
  if (until) {
    const when = untilText(admin.expiresUtc);
    until.textContent = when ? str('app.this_sign_in_runs_out_and', { when }) : str('app.closing_this_tab_ends_this_sign');
  }
  paintSponsors();
  const open = board.openId ? trackById(board.openId) : null;
  if (open) {
    paintTrackAdmin(open);
  } else if ($('sheet-admin')) {
    $('sheet-admin').hidden = true;
    $('sheet-admin').textContent = '';
  }
}

function showAdminError(message) {
  if ($('admin-error')) {
    $('admin-error').textContent = message || '';
  }
}

async function signIn(email, password) {
  const body = await adminRequest('api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  admin.token = body.token || '';
  takeSession(body, 'session');
  keepToken(admin.token);
  paintAdmin();
}

/* A token kept from before a reload is checked with the board, not
 * trusted: a masthead claiming a sign in the board has dropped would fail
 * at the one button that matters. A board that is merely down leaves the
 * token alone. */
async function resumeAdmin() {
  admin.token = keptToken();
  if (!admin.token) {
    paintAdmin();
    return;
  }
  try {
    const body = await adminRequest('api/admin/session');
    takeSession(body, body.kind || 'session');
    paintAdmin();
  } catch (err) {
    if (!err.signedOut) {
      paintAdmin();
    }
  }
}

/*
 * Taking a track off the board, the one destructive control: two presses,
 * the second red and naming what goes, and it disarms itself after six
 * seconds so a panel left open holds no loaded button. Not confirm(),
 * which cannot say how many times go with it and which people dismiss.
 */
function paintTrackAdmin(track) {
  const host = $('sheet-admin');
  if (!host) {
    return;
  }
  host.textContent = '';
  host.hidden = !isSignedIn();
  if (!isSignedIn()) {
    return;
  }
  /* Both boards' times go with it, whichever is on screen. */
  const held = timesOn(board.tracks.find((t) => t.id === track.id) || track);
  host.append(make('div', 'kicker', str('app.admin')), make('p', null, held
    ? str('app.taking_this_off_the_board_takes', { plural: counted(held, 'posted time', 'posted times') })
    : str('app.taking_this_off_the_board_cannot')));
  const btn = make('button', 'btn danger small', str('app.take_off_the_board'));
  btn.type = 'button';
  let timer = 0;
  const disarm = () => {
    clearTimeout(timer);
    timer = 0;
    btn.classList.remove('armed');
    btn.textContent = str('app.take_off_the_board');
  };
  btn.addEventListener('click', async () => {
    if (!timer) {
      btn.classList.add('armed');
      btn.textContent = str('app.remove_for_good', { name: track.name });
      timer = setTimeout(disarm, 6000);
      return;
    }
    clearTimeout(timer);
    timer = 0;
    btn.disabled = true;
    btn.textContent = str('app.removing');
    try {
      await adminRequest(`api/tracks/${encodeURIComponent(track.id)}/remove`, { method: 'POST' });
      forgetTrack(track.id);
    } catch (err) {
      btn.disabled = false;
      disarm();
      host.append(make('p', 'admin-error', err.message));
    }
  });
  host.append(btn);
}

/* A removed track leaves everything that counted it, without a reload
 * that would lose the reader's search and tags. */
function forgetTrack(id) {
  board.tracks = board.tracks.filter((t) => t.id !== id);
  board.timesById.delete(id);
  paintCounts();
  paintCraftCounts();
  paintAuthors();
  paintTags();
  paintGrid();
  paintRail();
  clearHash();
}

function bindAdmin() {
  $('admin-open')?.addEventListener('click', () => {
    showAdminError('');
    openSheet($('admin-sheet'));
    paintAdmin();
    /* Straight into the address field, when there is one to type into. */
    if ($('admin-email') && !$('admin-signin').hidden) {
      $('admin-email').focus();
    }
  });
  $('admin-close')?.addEventListener('click', closeAdmin);
  $('admin-signout')?.addEventListener('click', () => {
    signOut();
    closeAdmin();
  });
  $('admin-signin')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const [password, submit, busy] = [$('admin-password'), $('admin-submit'), $('admin-busy')];
    showAdminError('');
    submit.disabled = true;
    if (busy) {
      busy.hidden = false;
    }
    try {
      await signIn($('admin-email').value, password.value);
      /* The password leaves the page as soon as it has been used. */
      password.value = '';
    } catch (err) {
      showAdminError(err.message);
      password.select();
    } finally {
      submit.disabled = false;
      if (busy) {
        busy.hidden = true;
      }
    }
  });
}

/* The panel has no address of its own, so closing it re-routes: a track
 * sheet open behind it comes back. */
function closeAdmin() {
  const panel = $('admin-sheet');
  if (!panel || panel.hidden) {
    return;
  }
  panel.hidden = true;
  document.body.classList.remove('locked');
  pageInert(false);
  route();
  const back = board.lastFocus;
  if (back && document.contains(back) && !panel.contains(back)) {
    back.focus();
  } else {
    $('admin-open')?.focus();
  }
}

/* ================================================================== */
/* The track sheet                                                     */
/* ================================================================== */

/* A label and value in their own box, so a grid never pairs a label with
 * the wrong value. */
function addFact(list, label, value) {
  if (value == null || value === '') {
    return;
  }
  const cell = make('div');
  cell.append(make('dt', null, label), make('dd', null, String(value)));
  list.append(cell);
}

/* The plan at full size, with the simulator's orbit camera over it when
 * motion is allowed; the plan stays until the frame says it is ready. */
function paintShot(host, track) {
  host.textContent = '';
  host.append(planCanvas(track.plan, planLabel(track), { scaleBar: true, pad: 26 }));
  if (stillness()) {
    return;
  }
  const frame = document.createElement('iframe');
  frame.className = 'orbit';
  frame.title = str('app.a_flight_through_the_track', { name: track.name });
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = orbitHref(board.config, track.id);
  const waiting = make('div', 'shot-wait');
  waiting.append(make('span', 'shot-dot'), make('span', null, str('app.flying_the_track')));
  host.append(waiting, frame);
}

/*
 * The full table. A room is scored on three consecutive laps as well as
 * one, so its sheet gets a three lap column, but only once somebody has
 * posted one; a field never has. Empty cells, not dashes, where a run has
 * no such number.
 */
function paintTimes(host, track, times) {
  host.textContent = '';
  const head = make('div', 'board-head');
  head.append(make('h3', null, times.length ? str('app.every_time_posted') : str('app.the_board_is_open')));
  if (times.length) {
    head.append(make('span', 'count', counted(times.length, 'lap', 'laps')));
  }
  host.append(head);
  if (!times.length) {
    host.append(make('p', 'none', str('app.nobody_has_posted_a_lap_on', { name: track.name })));
    return;
  }
  const leader = times[0].lapMs;
  const slowest = times[times.length - 1].lapMs || leader;
  const threeCls = str('app.time_three');
  const withThree = classOf(track) === 'micro' && times.some((t) => Number.isFinite(t.threeMs));
  const columns = [['rank', ''], ['nm', 'Pilot'], ['time', 'Lap'],
    ...(withThree ? [[threeCls, str('app.three_laps')]] : []),
    ['gap', 'Gap'], ['when', 'Posted'], ['chase', '']];
  const headRow = make('tr');
  headRow.append(...columns.map(([cls, label]) => make('th', cls, label)));
  const thead = make('thead');
  thead.append(headRow);
  const tbody = make('tbody');
  times.forEach((row, i) => {
    const fill = make('span');
    fill.style.width = `${Math.max(8, (row.lapMs / slowest) * 100)}%`;
    const bar = make('div', 'gap-bar');
    bar.append(fill);
    const name = make('td', 'nm');
    name.append(make('span', null, row.name), bar);
    const lap = make('td', 'time');
    lap.append(lapNode(row.lapMs, 'tm'));
    const tr = make('tr', `r${i + 1}`);
    tr.append(make('td', 'rank', String(i + 1)), name, lap);
    if (withThree) {
      const three = make('td', threeCls);
      if (Number.isFinite(row.threeMs)) {
        three.append(lapNode(row.threeMs, 'tm'));
      } else {
        three.title = str('app.this_run_did_not_put_three');
      }
      tr.append(three);
    }
    const gap = make('td', 'gap');
    if (i > 0) {
      gap.append(lapNode(row.lapMs - leader, 'tm', '+'));
    }
    const when = make('td', 'when', agoText(row.postedUtc));
    when.title = dateText(row.postedUtc);
    const chase = make('td', 'chase');
    if (row.hasGhost && row.id) {
      chase.append(chaseLink(board.config, track.id, row));
    }
    tr.append(gap, when, chase);
    tbody.append(tr);
  });
  const table = make('table');
  table.append(thead, tbody);
  host.append(table);
}

/* The record, large; none at all for a track nobody has flown. */
function paintRecord(host, track, times) {
  host.textContent = '';
  const best = times.length ? times[0] : track.best;
  host.hidden = !best;
  if (best) {
    host.append(make('span', 'record-label', str('app.track_record')), lapNode(best.lapMs, 'record-time'), make('div', 'record-holder', best.name));
  }
}

function copyLinkButton(url) {
  const btn = make('button', 'text', str('app.copy_link'));
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = str('app.link_copied');
    } catch {
      btn.textContent = url;
    }
    setTimeout(() => {
      btn.textContent = str('app.copy_link');
    }, 2200);
  });
  return btn;
}

function paintSheetByline(track) {
  const by = $('sheet-by');
  by.textContent = '';
  if (track.designer) {
    by.append(str('app.designed_by_2'), make('b', null, track.designer),
      track.series ? str('app.for_2', { series: track.series }) : '.',
      str('app.brought_over_by', { author: track.author }));
  } else {
    by.append(str('app.built_by'), make('b', null, track.author));
  }
  const published = dateText(track.publishedUtc);
  by.append(published ? str('app.published', { published }) : '.');
}

function paintFacts(track) {
  const facts = $('sheet-facts');
  facts.textContent = '';
  /* What it is for first; what it is made of after. */
  if (tagsOf(track).length) {
    addFact(facts, str('app.built_for'), tagsOf(track).map(tagName).join(', '));
  }
  addFact(facts, 'Gates', counted(track.gates, 'gate', 'gates'));
  addFact(facts, 'Elements', track.elements);
  if (worldOf(track)) {
    addFact(facts, str('app.world'), worldOf(track));
  } else {
    addFact(facts, classOf(track) === 'micro' ? 'Room' : 'Field', fieldSize(track));
  }
  addFact(facts, str('app.flown_on'), aircraftOf(track));
  addFact(facts, 'Updated', agoText(track.updatedUtc));
  if (track.hasLogo) {
    addFact(facts, 'Branding', str('app.sponsor_print'));
  }
}

async function paintSheet(track) {
  $('sheet-kicker').textContent = track.times > 0 ? `${counted(track.times, 'time', 'times')} posted` : str('app.open_track');
  $('sheet-title').textContent = track.name;
  paintSheetByline(track);
  paintShot($('sheet-shot'), track);
  paintFacts(track);

  /* The builder navigates the simulator's tab in place, so it shares the
   * tab name. */
  const fly = make('a', 'btn primary', str('app.fly_this_track'));
  fly.href = flyHref(board.config, track.id);
  fly.target = SIM_WINDOW;
  const remix = make('a', 'text', str('app.remix_in_the_builder'));
  remix.href = remixHref(board.config, track.id);
  remix.target = SIM_WINDOW;
  const actions = $('sheet-actions');
  actions.textContent = '';
  actions.append(fly, remix, copyLinkButton(`${board.config.boardOrigin}/${trackHash(track.id)}`));

  paintTrackAdmin(track);
  const rows = boardRows(track, loadedTimes(track.id)) || [];
  paintRecord($('sheet-hero'), track, rows);
  paintTimes($('sheet-board'), track, rows);
  paintPlans($('sheet'));

  if (loadedTimes(track.id) || !(track.times > 0)) {
    return;
  }
  try {
    const fetched = boardRows(track, await loadTimes(track.id));
    if (board.openId === track.id) {
      paintRecord($('sheet-hero'), track, fetched);
      paintTimes($('sheet-board'), track, fetched);
    }
  } catch (err) {
    $('sheet-board').append(make('p', 'none', err.message));
  }
}

/* ================================================================== */
/* Sheets and routing                                                  */
/* ================================================================== */

const SHEETS = ['sheet', 'credits-sheet', 'admin-sheet'];

/* Behind an open sheet the page is inert, so Tab cannot wander out of
 * the dialog into a grid nobody can see. */
function pageInert(on) {
  for (const node of [document.querySelector('.mast'), document.querySelector('.spine'), $('tracks'), document.querySelector('footer')]) {
    if (node) {
      node.inert = on;
    }
  }
}

const anySheetOpen = () => SHEETS.some((id) => !$(id).hidden);

/* Every sheet, the admin panel included, so opening a track over the
 * panel replaces it instead of stacking. Emptying the shot stops the
 * simulator that was running in it. */
function closeSheets() {
  for (const id of SHEETS) {
    $(id).hidden = true;
  }
  if ($('sheet-shot')) {
    $('sheet-shot').textContent = '';
  }
  board.openId = null;
  document.body.classList.remove('locked');
  pageInert(false);
}

function openSheet(node) {
  if (!anySheetOpen()) {
    board.lastFocus = document.activeElement;
  }
  closeSheets();
  node.hidden = false;
  node.scrollTop = 0;
  document.body.classList.add('locked');
  pageInert(true);
  node.querySelector('.btn')?.focus();
}

function clearHash() {
  const back = board.lastFocus;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  route();
  if (back && document.contains(back)) {
    back.focus();
  }
}

/*
 * The tab showing follows the address, so a pasted #stats lands on the
 * statistics and a reload stays put. The aircraft switch belongs to the
 * tracks tab and hides with it. When the tab changes and its row is off
 * screen (a footer link), the row is brought into view; otherwise the page
 * does not move.
 */
let currentTab = '';

function showTab(name) {
  const stats = name === 'stats';
  const changed = Boolean(currentTab) && currentTab !== name;
  currentTab = name;
  for (const [id, hidden] of [['view-tracks', stats], ['view-stats', !stats], ['craftswitch', stats]]) {
    if ($(id)) {
      $(id).hidden = hidden;
    }
  }
  for (const [id, on] of [['tab-tracks', !stats], ['tab-stats', stats]]) {
    const tab = $(id);
    if (tab) {
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
      /* One tab stop for the row; arrows move within it. */
      tab.tabIndex = on ? 0 : -1;
    }
  }
  const row = $('tabs');
  const box = changed && row ? row.getBoundingClientRect() : null;
  if (box && (box.top < 0 || box.bottom > window.innerHeight)) {
    row.scrollIntoView({ block: 'start', behavior: stillness() ? 'auto' : 'smooth' });
  }
  showStats(stats);
}

/*
 * #stats, #credits (now the simulator's page), #track=<id>, and #course=
 * <id>, which every link shared before the rename says: read, then
 * rewritten in place to #track= so the visitor leaves with the new
 * spelling and Back still works.
 */
function route() {
  const hash = location.hash;
  if (hash === '#stats') {
    closeSheets();
    showTab('stats');
    return;
  }
  showTab('tracks');
  if (hash === '#credits') {
    window.location.replace(creditsHref(board.config));
    return;
  }
  const asked = hash.match(/^#(?:track|course)=(.+)$/);
  if (!asked) {
    closeSheets();
    return;
  }
  let id = asked[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    /* Not percent encoded after all; use it as written. */
  }
  const track = trackById(id);
  if (!track) {
    closeSheets();
    return;
  }
  if (hash.startsWith('#course=')) {
    history.replaceState(null, '', trackHash(track.id));
  }
  openSheet($('sheet'));
  board.openId = id;
  paintSheet(track);
}

/* ================================================================== */
/* Page furniture                                                      */
/* ================================================================== */

/* The slim bar appears once the masthead has scrolled away. */
function watchMasthead() {
  const [mast, spine] = [document.querySelector('.mast'), document.querySelector('.spine')];
  if (!mast || !spine) {
    return;
  }
  new IntersectionObserver((entries) => {
    for (const entry of entries) {
      spine.classList.toggle('on', !entry.isIntersecting);
    }
  }, { threshold: 0 }).observe(mast);
}

/* The other language, named in itself. */
function bindLanguageLink() {
  const link = $('lang-toggle');
  if (!link) {
    return;
  }
  const other = LOCALES[(LOCALES.indexOf(currentLocale()) + 1) % LOCALES.length];
  link.textContent = LOCALE_NAMES[other] || other;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    rememberLocale(other);
    window.location.reload();
  });
}
bindLanguageLink();

/* The links in the markup that cross to the simulator, all into its one
 * tab so the board stays open behind it. Bound from the guess first and
 * again when /api/config answers. */
function bindSimLinks(config) {
  const sim = inLanguage(`${config.simOrigin}/`);
  const builder = inLanguage(`${config.simOrigin}/src/trackbuilder/index.html`);
  const credits = creditsHref(config);
  for (const [id, href] of [
    ['sim-link', sim], ['foot-sim', sim], ['builder-link', builder], ['spine-build', builder],
    ['mast-credits', credits], ['spine-credits', credits], ['foot-credits', credits],
  ]) {
    const link = $(id);
    if (link) {
      link.href = href;
      link.target = SIM_WINDOW;
    }
  }
}

/* The marks go home, in this tab, and owe nothing to /api/config. */
function bindHome() {
  const href = frontDoor();
  if (!href) {
    return;
  }
  for (const id of ['brand-home', 'spine-home']) {
    if ($(id)) {
      $(id).href = href;
    }
  }
}

function bindCraftSwitch() {
  for (const cls of CLASSES) {
    $(`craft-${cls}`)?.addEventListener('click', () => chooseCraft(cls));
  }
}

function bindToolbar() {
  const [find, sort, by] = [$('find'), $('sort'), $('by')];
  const refilter = () => {
    paintTags();
    paintGrid();
  };
  find?.addEventListener('input', () => {
    board.query = find.value;
    refilter();
  });
  find?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && find.value) {
      event.stopPropagation();
      find.value = '';
      board.query = '';
      refilter();
    }
  });
  if (sort) {
    sort.value = board.sort;
    sort.addEventListener('change', () => {
      board.sort = sort.value;
      paintGrid();
    });
  }
  by?.addEventListener('change', () => {
    board.author = by.value;
    refilter();
  });
}

function learnTags(payload) {
  if (!Array.isArray(payload.tags) || !payload.tags.length) {
    return;
  }
  tagVocabulary = payload.tags;
  tagNames.clear();
  for (const tag of tagVocabulary) {
    tagNames.set(tag.id, tag.label);
  }
}

function bindCredits() {
  const roll = $('credits-roll');
  if (roll) {
    fillCredits(roll, { assetBase: 'credits' });
  }
  for (const id of ['credits-close', 'sheet-close']) {
    $(id)?.addEventListener('click', clearHash);
  }
}

/* A sheet's orbit frame says when its first frame is drawn, and the plan
 * under it hands over. */
function watchOrbit() {
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'fdfpv-orbit-ready') {
      return;
    }
    for (const frame of document.querySelectorAll('iframe.orbit')) {
      if (frame.contentWindow === event.source) {
        frame.classList.add('ready');
        const waiting = frame.parentElement?.querySelector('.shot-wait');
        if (waiting) {
          waiting.hidden = true;
        }
      }
    }
  });
}

/*
 * The tab row. A plain click sets the address by hand and routes without
 * the jump an anchor makes to <main>; a modified click is left to the
 * browser, since the hrefs are real for opening in a new tab. Arrows, Home
 * and End move between tabs and follow them, as a tablist promises.
 */
function bindTabs() {
  const row = $('tabs');
  if (!row) {
    return;
  }
  const tabs = [...row.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      const href = tab.getAttribute('href') || '#';
      if (location.hash !== href) {
        history.pushState(null, '', href);
      }
      route();
    });
  }
  const moves = {
    ArrowRight: (i) => (i + 1) % tabs.length,
    ArrowDown: (i) => (i + 1) % tabs.length,
    ArrowLeft: (i) => (i - 1 + tabs.length) % tabs.length,
    ArrowUp: (i) => (i - 1 + tabs.length) % tabs.length,
    Home: () => 0,
    End: () => tabs.length - 1,
  };
  row.addEventListener('keydown', (event) => {
    const at = tabs.indexOf(document.activeElement);
    const move = moves[event.key];
    if (at < 0 || !move) {
      return;
    }
    event.preventDefault();
    const next = tabs[move(at)];
    next.focus();
    next.click();
  });
}

/*
 * Escape closes the admin panel first (it has no address), else a track
 * sheet, but never undoes a tab address. / jumps to the search unless the
 * reader is typing or a sheet is open.
 */
function watchKeys() {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('admin-sheet').hidden) {
        closeAdmin();
      } else if (location.hash && location.hash !== '#stats' && location.hash !== '#tracks') {
        clearHash();
      }
      return;
    }
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName || '');
    const find = $('find');
    if (typing || anySheetOpen() || !find || find.closest('[hidden]')) {
      return;
    }
    event.preventDefault();
    find.focus();
    find.select();
  });
}

/* Plans are drawn at real pixels, so a resize repaints them. */
function watchResize() {
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintPlans(document), 140);
  });
}

/* ================================================================== */
/* Start                                                               */
/* ================================================================== */

/* JSON, or an Error with the board's sentence: a 500 must not read as an
 * empty board and tell the visitor to go and build the first track. */
async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || str('app.the_board_answered', { status: res.status }));
  }
  return body;
}

function emptyBoard() {
  const box = make('div', 'empty panel');
  const build = make('a', 'btn primary', str('app.build_a_track'));
  build.href = `${board.config.simOrigin}/src/trackbuilder/index.html`;
  build.target = SIM_WINDOW;
  box.append(make('h2', null, str('app.nothing_published_yet')), make('p', null, str('app.build_a_track_in_the_track')), build);
  return box;
}

async function start() {
  /* This tab is the board: the simulator opens the board under this name,
   * so checking times between runs comes back here instead of stacking
   * tabs. The name survives navigation within the origin. */
  window.name = BOARD_WINDOW;
  window.addEventListener('hashchange', route);
  if (location.hash === '#credits') {
    route();
    return;
  }
  watchMasthead();
  watchOrbit();
  watchKeys();
  watchResize();
  bindCredits();
  /*
   * The Admin button, the statistics tab and the first route come before
   * any request: they have to work on an empty board and on one whose list
   * failed, which is when somebody needs them. Neither the session check
   * nor the visit is awaited.
   */
  bindAdmin();
  resumeAdmin();
  mountStats(here('api/stats'));
  bindTabs();
  pingVisit('board', here('api/stats/events'));
  route();

  const list = $('list');
  const notice = $('notice');
  placeholders(list, 6);

  /* The markup's simulator links are loopback addresses for a checkout,
   * so they are bound from the guess now, before any request can fail. */
  bindSimLinks(board.config);
  bindHome();

  /* Config only corrects simOrigin, which the guess already answered, so
   * losing it is quiet; losing the track list is not. */
  try {
    const served = await getJson(here('api/config'));
    board.config = { ...board.config, ...served, boardOrigin: BOARD_HOME };
    bindSimLinks(board.config);
  } catch {
    /* Quiet: the links are bound and the list below speaks if the board is down. */
  }

  try {
    const payload = await getJson(here('api/tracks'));
    board.tracks = payload.tracks || [];
    learnTags(payload);
  } catch (err) {
    list.textContent = '';
    notice.append(make('div', 'status panel', err.message || str('app.this_page_could_not_be_loaded')));
    return;
  }

  paintCounts();
  if (!board.tracks.length) {
    list.textContent = '';
    notice.append(emptyBoard());
    return;
  }
  $('toolbar').hidden = false;
  bindToolbar();
  bindCraftSwitch();
  paintAuthors();
  /* Paints the counts, the tags and the grid; needs the tracks in hand. */
  chooseCraft(chosenCraft(), { remember: false });
  route();
  await fetchAllTimes();
}

start();
