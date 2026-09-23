/*
 * app.js: the public board page.
 *
 * One tile per published track, ordered by a control the reader can see
 * and change. The tile art is the track plan, drawn from the list payload
 * by plan.js: the flown line and the things that stand on the field, so a
 * waypoint that pins the line does not stand in as a gate. The index costs
 * two requests and no WebGL. Opening a
 * track is a real link, #track=trk-1a2b3c4d, and the sheet behind it is
 * where the expensive and beautiful thing lives: the simulator's own title
 * camera, playing once rather than twelve times at once.
 *
 * Times are fetched only for tracks that have any, which on a young board
 * is one request instead of one per track. Those times then feed three
 * things at no extra cost: the top three on a tile, the standings rail,
 * and the count of pilots in the masthead.
 *
 * Fly this track opens the simulator with ?share=id, which is the whole
 * of the link between the two sites.
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

import { guessSimOrigin as guess, landingOrigin as frontDoor } from './origins.js';
import { mountStats, pingVisit, showStats } from './stats.js';
import { fillCredits } from './credits.js';
import { str } from './strings/index.js';

/* Static sentences in the markup carry data-str keys; filled here so the
 * page stays greppable and the copy lives in one table. */
for (const node of document.querySelectorAll('[data-str]')) {
  node.textContent = str(node.dataset.str);
}
import {
  fieldSize, paintPlans, planCanvas, planLabel,
} from './plan.js';

/* ------------------------------------------------------------------ */
/* Where this page lives                                               */
/* ------------------------------------------------------------------ */

/*
 * The board is served from its own root on Render and from /board/ on
 * fdfpv.example, where a Cloudflare Worker takes the prefix off before the
 * request reaches this service. The server therefore sees the same paths
 * either way and needs no telling. The PAGE does: a fetch of '/api/tracks'
 * from https://fdfpv.example/board/ leaves the board's namespace entirely and
 * asks the landing page for the tracks.
 *
 * So every url this page builds for itself is resolved against the directory
 * it was served from. `document.baseURI` is the document's own address, and
 * './' against it is that address's directory, which is /board/ for both
 * /board/ and /board/bugs and / for both / and /bugs. credits.js already
 * resolved its logos this way and this is the same idea applied to the api.
 */
const HERE = new URL('./', document.baseURI);

/*
 * This page's own address INCLUDING the prefix it is mounted under, which is
 * what the simulator needs in a ?board= to find its way back.
 *
 * This OUTRANKS the boardOrigin in /api/config, and that is the whole point.
 * The server works its own address out of the request headers, and a header
 * cannot carry a path: a host is a host. Behind the mount it answers
 * https://fdfpv.example, which is the landing page, so every Fly link would send
 * a pilot somewhere that has never heard of a lap time, and nothing would say
 * so out loud. The page is standing at the address in question and does not
 * have to work anything out.
 */
const HERE_ORIGIN = HERE.href.replace(/\/+$/, '');

function here(path) {
  return new URL(path, HERE).href;
}

/* Where the simulator is when /api/config cannot say. See origins.js. */
function guessSimOrigin() {
  try {
    return guess(window.location, HERE);
  } catch (e) {
    /* No window, as in Node. */
    return null;
  }
}

/*
 * Where the front door is. Not a config field and not a guess that can
 * decline: there is one landing page and origins.js names it. See the long
 * comment there for why this question is not the same shape as the one
 * above.
 */
function landingHref() {
  try {
    return `${frontDoor(window.location, HERE)}/`;
  } catch (e) {
    /* No window, as in Node. */
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text != null) {
    n.textContent = text;
  }
  return n;
}

function byId(id) {
  return document.getElementById(id);
}

function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms)) {
    return '--.--';
  }
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (m > 0) {
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  return s.toFixed(2);
}

/* A lap, with the hundredths in their own span so they can sit a shade
 * quieter than the seconds. */
function timeNode(ms, cls, prefix) {
  const node = el('span', cls || 'tm');
  if (ms == null || !Number.isFinite(ms)) {
    node.classList.add('empty');
    node.textContent = '--.--';
    return node;
  }
  const t = formatTime(ms);
  const dot = t.lastIndexOf('.');
  node.append(`${prefix || ''}${t.slice(0, dot)}`);
  node.append(el('span', 'frac', t.slice(dot)));
  return node;
}

function formatWhen(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatAgo(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) {
    return 'just now';
  }
  if (sec < 90) {
    return '1 min ago';
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)} min ago`;
  }
  if (sec < 5400) {
    return '1 hour ago';
  }
  if (sec < 86400) {
    return `${Math.floor(sec / 3600)} hours ago`;
  }
  if (sec < 172800) {
    return '1 day ago';
  }
  if (sec < 86400 * 30) {
    return `${Math.floor(sec / 86400)} days ago`;
  }
  return formatWhen(iso);
}

/*
 * A moment a few hours away, which is the only thing on this page that
 * wants a clock. formatWhen prints a date, which is right for a track
 * published in March and useless for a sign in that runs out this evening:
 * "runs out Sep 12" on the twelfth of September says nothing at all. So
 * today gets a time, tomorrow gets a day and a time, and anything further
 * out falls back on the date, which is what the server's twelve hours can
 * never actually reach.
 */
function formatUntil(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate())
      - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000,
  );
  if (days <= 0) {
    return str('app.at', { clock });
  }
  if (days === 1) {
    return str('app.tomorrow_at', { clock });
  }
  return str('app.at_2', { formatWhen: formatWhen(iso), clock });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/* Facts on one line read as a list, not as a sentence, so they are
 * separated by a middot rather than by punctuation. */
function joined(parts) {
  return parts.filter(Boolean).join(' \u00b7 ');
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ */
/* The two links between this site and the simulator                   */
/* ------------------------------------------------------------------ */

/*
 * One board tab, one simulator tab.
 *
 * Every link that crossed to the simulator carried target="_blank", so a
 * visitor who flew three tracks off this board finished with three
 * simulators open, each of them running a physics loop and holding a WebGL
 * context. Naming the tab instead means the second track lands in the tab
 * the first one is already using, and the browser focuses it.
 *
 * Two things this depends on, both easy to undo by accident:
 *
 *   No rel="noopener" on these links. The spec resolves a noopener link by
 *   setting its target to "_blank" first, so a named link that also asks
 *   for noopener opens a new tab every single time, which is the bug being
 *   fixed here. The cost is that the simulator gets a cross origin
 *   window.opener pointing back at this page. It is our own site at the
 *   other end. A link that leaves the product keeps its noopener.
 *
 *   The names have to match src/share/windows.js in the simulator, which is
 *   the copy of record and carries the long version of this comment. This
 *   page cannot import from there, so the strings are written down twice.
 *
 * A modifier click still opens a new tab: the browser overrides the target
 * when the visitor asks for that, which is the one case where a second
 * simulator is what was wanted.
 */
const SIM_WINDOW = 'fdfpv-sim';
const BOARD_WINDOW = 'fdfpv-board';

/*
 * WHICH AIRCRAFT A LINK IS FOR, from the track it names.
 *
 * The simulator keeps one seat per class and files a linked track by the
 * track's own class, so a link that named a room but not the aircraft, opened
 * on a profile flying the five inch, filed the room in the whoop seat and
 * then read the five inch's: the pilot arrived on their old field with the
 * track they were sent to nowhere. The simulator seats the aircraft from the
 * document now as well, but the link saying so is what lets it draw the
 * right world from the first frame instead of swapping under the title.
 */
function craftParamOf(id) {
  const track = state.courses.find((t) => t.id === id);
  if (!track) {
    return '';
  }
  return `&craft=${classOf(track) === 'micro' ? 'whoop65' : '5inch'}`;
}

function flyHref(config, id, ghostId) {
  const board = encodeURIComponent(config.boardOrigin);
  const base = `${config.simOrigin}/?map=custom&share=${encodeURIComponent(id)}&board=${board}${craftParamOf(id)}`;
  /* A ghost id turns the link into a chase: the simulator fetches that
   * lap's recording and flies it beside the visitor as a translucent
   * pacer. Only times posted with a recording carry one. */
  return ghostId ? `${base}&ghost=${encodeURIComponent(ghostId)}` : base;
}

/* The little mint link that races a recorded lap. One builder, because the
 * podium and the sheet's table must not drift apart on what a chase is. */
function chaseLink(config, trackId, row) {
  const a = el('a', 'chase', 'chase');
  a.href = flyHref(config, trackId, row.id);
  a.target = SIM_WINDOW;
  a.title = str('app.fly_against_s_recorded_lap', { name: row.name });
  return a;
}

function remixHref(config, id) {
  const board = encodeURIComponent(config.boardOrigin);
  const track = state.courses.find((t) => t.id === id);
  /* The builder reads ?class= for which canvas to open on. Same reason as
   * craftParamOf: a room remixed on a five inch builder is a room. */
  const cls = track ? `&class=${classOf(track)}` : '';
  return `${config.simOrigin}/src/trackbuilder/index.html?share=${encodeURIComponent(id)}&board=${board}${cls}`;
}

function orbitHref(config, id) {
  /*
   * Relative, against simOrigin WITH a trailing slash. It was
   * new URL('/src/share/orbit.html', config.simOrigin), and a leading slash
   * throws away everything but the base's scheme and host: with the simulator
   * at https://fdfpv.example/sim that produced https://fdfpv.example/src/share/...,
   * which is the landing page, so every card on the board drew an empty box.
   * The other two links below concatenate and were never affected, which is
   * exactly why this one was easy to miss.
   */
  const u = new URL('src/share/orbit.html', `${config.simOrigin}/`);
  u.searchParams.set('map', 'custom');
  u.searchParams.set('share', id);
  u.searchParams.set('board', config.boardOrigin);
  return u.href;
}

function courseHref(id) {
  return `#track=${encodeURIComponent(id)}`;
}

/*
 * The credits roll lives on the simulator at #credits. This board used to
 * paint a second copy, and the two drifted. One page, not two.
 *
 * On fdfpv.example the simulator is a mount on the same host, so a root-relative
 * /sim/#credits is the address. Locally the simulator is another origin, so
 * the config's simOrigin is the address.
 */
function creditsHref(config) {
  const origin = String((config && config.simOrigin) || guessSimOrigin() || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  try {
    const host = window.location.hostname;
    if (host === 'fdfpv.example' || host === 'www.fdfpv.example') {
      return `${window.location.origin}/sim/#credits`;
    }
  } catch (e) {
    /* No window, as in Node. */
  }
  return `${origin}/#credits`;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  /* The guess, not a loopback literal. /api/config overwrites it when it
   * answers; when it does not, this is already right on both layouts that
   * can be worked out from this page's address. See guessSimOrigin. */
  config: { simOrigin: guessSimOrigin() || 'http://127.0.0.1:8000', boardOrigin: HERE_ORIGIN },
  courses: [],
  timesById: new Map(),
  query: '',
  sort: 'flown',
  /* The tag filter is a SET and the rule is AND, not OR. A reader who ticks
   * "skills" and "beginner" is asking for a track that is both, because
   * that is what a reader ticking two boxes means, and OR would hand back
   * more results than one box alone which reads as the filter not working. */
  tags: new Set(),
  author: '',
  /*
   * WHICH AIRCRAFT, and it is a CHOICE rather than a filter: one of the two
   * is always on and there is no "anything".
   *
   * A track on this board is one of two things and they are not alternatives
   * to each other. A MultiGP field is 5 ft gates over sixty metres flown on a
   * five inch; a RaceGOW room is 28 inch gates inside about 1.4 by 2.1 m
   * flown on a 65 mm whoop. The simulator seats the aircraft from the track,
   * so offering a whoop pilot a five inch track is offering them one that
   * changes their aircraft the moment they press Fly.
   *
   * 'full' is the default because every track published before there were two
   * classes is one, and because a first visitor with no simulator behind them
   * should land on the board this has always been.
   */
  craft: 'full',
  openId: null,
  lastFocus: null,
};

/* The tag vocabulary, as the board describes it. Served rather than written
 * down here, so the list this page offers and the list the board accepts
 * cannot drift: validate.js is the copy of record. It rides along with the
 * track list rather than having a request of its own, so it is empty for
 * exactly as long as the tracks are. */
let TAGS = [];
const TAG_LABEL = new Map();

function tagLabel(id) {
  return TAG_LABEL.get(id) || id;
}

function courseById(id) {
  return state.courses.find((t) => t.id === id) || null;
}

function timesFor(id) {
  return state.timesById.get(id) || null;
}

function bestMsOf(track) {
  const times = timesFor(track.id);
  if (times && times.length) {
    return times[0].lapMs;
  }
  return track.best ? track.best.lapMs : null;
}

/* ------------------------------------------------------------------ */
/* Order and search                                                    */
/* ------------------------------------------------------------------ */

/*
 * Most flown is the default because a track with times on it is a track
 * with something to beat. The tie break is gate count rather than the
 * clock, so on a young board where almost nothing has been flown the
 * championship layouts lead and a three gate drill does not.
 */
const SORTS = {
  flown: (a, b) => (b.times || 0) - (a.times || 0)
    || (b.gates || 0) - (a.gates || 0)
    || String(b.publishedUtc || '').localeCompare(String(a.publishedUtc || '')),
  fastest: (a, b) => {
    const x = bestMsOf(a);
    const y = bestMsOf(b);
    if (x == null && y == null) {
      return (b.gates || 0) - (a.gates || 0);
    }
    if (x == null) {
      return 1;
    }
    if (y == null) {
      return -1;
    }
    return x - y;
  },
  biggest: (a, b) => (b.gates || 0) - (a.gates || 0) || (b.times || 0) - (a.times || 0),
  newest: (a, b) => String(b.publishedUtc || '').localeCompare(String(a.publishedUtc || '')),
  name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }),
};

function matches(track, needle) {
  if (!needle) {
    return true;
  }
  if (String(track.name).toLowerCase().includes(needle)) {
    return true;
  }
  if (String(track.author).toLowerCase().includes(needle)) {
    return true;
  }
  /* The designer and the series, where the track has them: somebody typing
   * "MrE" wants Track 6 whoever published it, and "RaceGOW5" is the set. */
  if ([track.designer, track.series].some((v) => String(v || '').toLowerCase().includes(needle))) {
    return true;
  }
  const times = timesFor(track.id);
  return Boolean(times && times.some((row) => String(row.name).toLowerCase().includes(needle)));
}

function tagsOf(track) {
  return Array.isArray(track.tags) ? track.tags : [];
}

/*
 * The class of a track, and 'full' for every one published before there were
 * two, which is what they are. The server derives it from the stored document
 * on every list, so this never has to guess.
 */
function classOf(track) {
  return track && track.trackClass === 'micro' ? 'micro' : 'full';
}

/* What a pilot calls it. The board says the aircraft, not the class, because
 * "micro" is a word about the document and "65 mm whoop" is a word about the
 * thing you fly. */
const CRAFT_LABEL = { full: str('app.five_inch'), micro: '65 mm whoop' };

function craftLabel(track) {
  return CRAFT_LABEL[classOf(track)];
}

/* Every tag actually in use, with how many tracks wear it. Counted over the
 * tracks the OTHER filters leave standing, so ticking an author greys out
 * the tags that author never used rather than offering an empty result. */
function tagCounts(pool) {
  const by = new Map();
  for (const track of pool) {
    for (const id of tagsOf(track)) {
      by.set(id, (by.get(id) || 0) + 1);
    }
  }
  return by;
}

/* The authors on the board, most tracks first, then alphabetical. */
function authors() {
  const by = new Map();
  for (const track of state.courses) {
    const name = String(track.author || '');
    by.set(name, (by.get(name) || 0) + 1);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
}

/* Everything except the tag filter, which the tag counts are measured
 * against so a tag can be greyed out rather than lead nowhere. */
function poolBeforeTags() {
  const needle = state.query.trim().toLowerCase();
  return state.courses.filter((t) => matches(t, needle)
    && (!state.author || String(t.author) === state.author)
    && (!state.craft || classOf(t) === state.craft));
}

function visibleCourses() {
  const compare = SORTS[state.sort] || SORTS.flown;
  const wanted = [...state.tags];
  return poolBeforeTags()
    .filter((t) => wanted.every((id) => tagsOf(t).includes(id)))
    .sort(compare);
}

/* ------------------------------------------------------------------ */
/* A track tile                                                       */
/* ------------------------------------------------------------------ */

/*
 * THE CARD ART: A DRAWING ON A FIELD, A LAP IN A ROOM.
 *
 * A sixty metre field has a plan worth drawing. The flown line through
 * twenty gates is the shape of the track, plan.js draws it from the list
 * payload the card already holds, and it costs no request at all.
 *
 * A RaceGOW room is about five metres across with three gates in it, so its
 * plan is an almost empty rectangle with a dot in the middle. It says
 * nothing, and what it says nothing about is the part that matters: a room
 * track is built upwards, and height is the one thing a plan cannot show.
 * So a room carries the builder's own animation of the lap, rendered once
 * by the browser that published it and served by this board as a file.
 *
 * It is an <img>, which is the whole reason this can sit in a grid: no
 * WebGL, no iframe, no second copy of the simulator. Lazy, so a board of
 * rooms below the fold costs nothing until it is scrolled to. Sized by the
 * stylesheet before the bytes arrive, so nothing reflows as they land.
 *
 * Which tracks may have one is the BOARD's rule, not this page's: inspectGif
 * in src/validate.js refuses an animation for a field track, so hasGif is
 * already the answer to "is this a room with a lap on file".
 */
function gifSrc(track) {
  const at = track.gifUtc ? `?v=${encodeURIComponent(track.gifUtc)}` : '';
  return here(`api/tracks/${encodeURIComponent(track.id)}/gif${at}`);
}

function cardArt(track) {
  /*
   * REDUCED MOTION GETS THE PLAN, and it has to be decided here rather than
   * in the stylesheet, because a GIF loops on its own and no CSS can stop
   * it. The plan says less about a room than the animation does, and it is
   * the one thing on this page that says anything at all without moving, so
   * it is what a reader who asked for stillness is given.
   */
  if (!track.hasGif || reduceMotion()) {
    return planCanvas(track.plan, planLabel(track));
  }
  const img = document.createElement('img');
  img.className = 'gif-art';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = gifSrc(track);
  img.alt = gifLabel(track);
  /*
   * A board whose animation is missing, or whose bytes never arrive, falls
   * back to the drawing rather than to a broken image icon. The animation
   * is stored separately from the track, so the two CAN disagree: a row
   * whose GIF was dropped by a relayout between the list being fetched and
   * the card being drawn is exactly this case.
   */
  img.addEventListener('error', () => {
    if (img.parentElement) {
      const plan = planCanvas(track.plan, planLabel(track));
      img.replaceWith(plan);
      paintPlans(plan.parentElement || document);
    }
  }, { once: true });
  return img;
}

/* What a screen reader is told the animation is. Not "plan of": it is a lap
 * being flown, and the room it is flown in is not a field. */
function gifLabel(track) {
  const plan = track.plan || {};
  const w = Math.round(Number(plan.width) || 0);
  const d = Math.round(Number(plan.depth) || 0);
  const gates = track.gates === 1 ? '1 gate' : `${track.gates} gates`;
  return str('app.a_lap_of_in_a_by', { name: track.name, gates, w, d });
}

function cardFor(track, config) {
  const card = el('article', 'card');
  card.dataset.id = track.id;

  const tile = el('a', 'tile');
  tile.href = courseHref(track.id);
  tile.setAttribute('aria-label', str('app.and_times', { name: track.name, v2: track.hasGif ? str('app.a_lap') : 'plan' }));
  tile.append(cardArt(track));
  const size = fieldSize(track);
  if (size) {
    tile.append(el('span', 'tile-chip', size));
  }
  /* Only the whoop is marked. Every track here is a five inch track until
   * somebody publishes a room, so a chip on all of them is a word repeated
   * on every card; marking the exception is what a chip is for. */
  if (classOf(track) === 'micro') {
    tile.append(el('span', 'tile-craft', craftLabel(track)));
  }
  if (track.times > 0) {
    tile.append(el('span', 'tile-flown', plural(track.times, 'time', 'times')));
  }
  card.append(tile);

  const body = el('div', 'body');

  const head = el('div', 'head');
  head.append(el('h2', null, track.name));
  /*
   * THE DESIGNER FIRST WHERE THERE IS ONE. A board track's author is who
   * published it, and on a track brought over from somewhere else that is
   * not who built it. The document says so and the summary now carries it.
   */
  const by = el('p', 'by');
  if (track.designer) {
    by.append(str('app.designed_by'));
    by.append(el('b', null, track.designer));
    if (track.series) {
      by.append(str('app.for', { series: track.series }));
    }
    by.append(str('app.published_by', { author: track.author }));
  } else {
    by.append('by ');
    by.append(el('b', null, track.author));
  }
  by.append(` \u00b7 ${plural(track.gates, 'gate', 'gates')}`);
  head.append(by);

  /* No record block on a track nobody has flown. Ten cards each carrying
   * a label and a row of dashes is the difference between a board and a
   * form. The single quiet line below says the same thing once. */
  const record = el('div', 'record');
  record.hidden = !track.best;
  record.append(el('span', 'record-label', str('app.record')));
  record.append(timeNode(track.best ? track.best.lapMs : null, 'record-time'));
  record.append(el('div', 'record-holder', track.best ? track.best.name : ''));
  head.append(record);
  body.append(head);

  /* What the author says it is for. Above the times rather than below,
   * because it is the thing that decides whether a reader wants this track
   * at all and the times are the thing they read once they do. */
  const tags = el('div', 'tags');
  for (const id of tagsOf(track)) {
    tags.append(el('span', null, tagLabel(id)));
  }
  body.append(tags);

  const podium = el('ol', 'podium');
  podium.hidden = true;
  body.append(podium);

  const none = el('p', 'none', str('app.no_time_posted_yet'));
  none.hidden = Boolean(track.best);
  body.append(none);

  const actions = el('div', 'actions');
  const fly = el('a', 'btn primary small', str('app.fly_this_track'));
  fly.href = flyHref(config, track.id);
  fly.target = SIM_WINDOW;
  fly.setAttribute('aria-label', str('app.fly_opens_it_in_the_simulator', { name: track.name }));
  const more = el('a', 'text more');
  more.href = courseHref(track.id);
  more.textContent = track.times > 3 ? str('app.all', { plural: plural(track.times, 'time', 'times') }) : str('app.track_detail');
  actions.append(fly, more);
  body.append(actions);

  card.append(body);
  return card;
}

/*
 * The top three, once a track's times have arrived. Called after the
 * card is in the document, never while it is still a loose node: a card
 * has to exist before anything paints into it.
 */
function paintPodium(card, times) {
  const podium = card.querySelector('.podium');
  const none = card.querySelector('.none');
  const more = card.querySelector('.more');
  const record = card.querySelector('.record');
  const clock = card.querySelector('.record-time');
  const holder = card.querySelector('.record-holder');
  if (!podium || !none) {
    return;
  }
  podium.textContent = '';
  if (!times || !times.length) {
    podium.hidden = true;
    none.hidden = false;
    if (record) {
      record.hidden = true;
    }
    return;
  }
  none.hidden = true;
  if (record) {
    record.hidden = false;
  }
  if (clock) {
    clock.replaceWith(timeNode(times[0].lapMs, 'record-time'));
  }
  /* One time is a record, not a podium, and naming the holder twice on
   * one card is how a leaderboard starts to read as a receipt. The holder
   * line carries the name when there is no podium, and the podium carries
   * it when there is. */
  const ranked = times.length > 1;
  if (holder) {
    holder.textContent = ranked ? '' : times[0].name;
  }
  podium.hidden = !ranked;
  if (!ranked) {
    return;
  }
  const config = state.config;
  times.slice(0, 3).forEach((row, i) => {
    const li = el('li', `podium-row r${i + 1}`);
    li.append(el('span', 'rk', String(i + 1)));
    li.append(el('span', 'nm', row.name));
    li.append(timeNode(row.lapMs, 'tm'));
    if (row.hasGhost && row.id) {
      li.classList.add('has-chase');
      li.append(chaseLink(config, card.dataset.id, row));
    }
    podium.append(li);
  });
  if (more) {
    more.textContent = times.length > 3
      ? str('app.all', { plural: plural(times.length, 'time', 'times') })
      : str('app.track_detail');
  }
}

/* ------------------------------------------------------------------ */
/* The grid                                                            */
/* ------------------------------------------------------------------ */

function skeletons(host, n) {
  host.textContent = '';
  for (let i = 0; i < n; i += 1) {
    const card = el('article', 'card skeleton');
    card.append(el('div', 'tile'));
    const body = el('div', 'body');
    body.append(el('div', 'bone wide'), el('div', 'bone thin'));
    card.append(body);
    host.append(card);
  }
}

function paintGrid() {
  const list = byId('list');
  const notice = byId('notice');
  const count = byId('count');
  const shown = visibleCourses();
  list.textContent = '';
  notice.textContent = '';
  for (const track of shown) {
    const card = cardFor(track, state.config);
    list.append(card);
    const times = timesFor(track.id);
    if (times) {
      paintPodium(card, times);
    }
  }
  paintPlans(list);
  if (count) {
    count.textContent = shown.length === state.courses.length
      ? plural(state.courses.length, 'track', 'tracks')
      : str('app.of', { length: shown.length, plural: plural(state.courses.length, 'track', 'tracks') });
  }
  if (!shown.length && state.courses.length) {
    /*
     * Say WHICH filter emptied the list. There are three of them now, and
     * "nothing matches that" in front of a reader who set a search two
     * minutes ago and an author just now does not say which one to undo.
     */
    const parts = [];
    if (state.query.trim()) {
      parts.push(str('app.the_search', { v1: state.query.trim() }));
    }
    if (state.author) {
      parts.push(str('app.tracks_built_by', { author: state.author }));
    }
    if (state.tags.size) {
      parts.push(`${[...state.tags].map(tagLabel).join(' and ')}`);
    }

    const box = el('div', 'empty panel');
    box.append(el('h2', null, str('app.nothing_matches_that')));
    /* The aircraft is above the filters and is not one of them, so it is
     * named separately: a reader whose list is empty because they are on the
     * whoop side and every track is a five inch one needs to be told that,
     * and it is not something Clear the filters should undo. */
    box.append(el('p', 'empty-craft',
      str('app.you_are_looking_at_the_tracks', { v1: CRAFT_LABEL[state.craft].toLowerCase() })));
    box.append(el('p', null, parts.length
      ? str('app.no_track_on_the_board_is', { joined: joined(parts) })
      : str('app.no_track_on_the_board_answers')));
    const clear = el('button', 'btn small', str('app.clear_the_filters'));
    clear.type = 'button';
    clear.addEventListener('click', () => {
      const find = byId('find');
      const by = byId('by');
      /* The aircraft is NOT cleared. It is the choice this page is being
       * read under, not one of the filters narrowing it, and clearing it
       * would answer a whoop pilot's empty list by moving them to the five
       * inch tracks. */
      state.query = '';
      state.author = '';
      state.tags.clear();
      if (find) {
        find.value = '';
      }
      if (by) {
        by.value = '';
      }
      paintTags();
      paintGrid();
      if (find) {
        find.focus();
      }
    });
    box.append(clear);
    notice.append(box);
  }
}

/* ------------------------------------------------------------------ */
/* The tag bar and the author list                                     */
/* ------------------------------------------------------------------ */

/*
 * A closed vocabulary is what makes a filter possible, so the bar is the
 * whole list rather than the tags that happen to be in use: a reader can
 * see that "Showcase" exists and that nobody has built one, which is more
 * useful than the tag not being there. A tag no track wears is disabled
 * rather than hidden, so the bar does not reflow every time a filter moves.
 */
function paintTags() {
  const bar = byId('tagbar');
  if (!bar) {
    return;
  }
  const counts = tagCounts(poolBeforeTags());
  bar.textContent = '';
  bar.hidden = TAGS.length === 0;
  for (const tag of TAGS) {
    const n = counts.get(tag.id) || 0;
    const on = state.tags.has(tag.id);
    const btn = el('button', 'tag');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    /* A tag nobody wears is still pressable if it is already ON, or a
     * reader could tick their way into a filter they cannot untick. */
    btn.disabled = n === 0 && !on;
    btn.append(el('span', null, tag.label));
    btn.append(el('span', 'n', String(n)));
    btn.addEventListener('click', () => {
      if (state.tags.has(tag.id)) {
        state.tags.delete(tag.id);
      } else {
        state.tags.add(tag.id);
      }
      paintTags();
      paintGrid();
    });
    bar.append(btn);
  }
}

function paintAuthors() {
  const select = byId('by');
  if (!select) {
    return;
  }
  const held = state.author;
  select.textContent = '';
  const any = document.createElement('option');
  any.value = '';
  any.textContent = str('app.anyone');
  select.append(any);
  for (const [name, n] of authors()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = n > 1 ? `${name} (${n})` : name;
    select.append(opt);
  }
  /* An author who deleted their last track between paints must not leave
   * the filter pointing at a name with nothing behind it. */
  select.value = [...select.options].some((o) => o.value === held) ? held : '';
  state.author = select.value;
}

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

/*
 * A pilot's standing is how many tracks they hold, not how many laps
 * they have posted, because posting more laps is not the same as being
 * quicker than anybody.
 */
function standings() {
  const by = new Map();
  for (const course of state.courses) {
    const times = timesFor(course.id);
    if (!times || !times.length) {
      continue;
    }
    times.forEach((row, i) => {
      const rec = by.get(row.name) || {
        name: row.name, laps: 0, records: 0, podiums: 0,
      };
      rec.laps += 1;
      if (i === 0) {
        rec.records += 1;
      }
      if (i < 3) {
        rec.podiums += 1;
      }
      by.set(row.name, rec);
    });
  }
  return [...by.values()].sort((a, b) => b.records - a.records
    || b.podiums - a.podiums
    || b.laps - a.laps
    || a.name.localeCompare(b.name));
}

function latestTimes(limit) {
  const rows = [];
  for (const course of state.courses) {
    const times = timesFor(course.id);
    if (!times) {
      continue;
    }
    times.forEach((row, i) => {
      rows.push({ ...row, course, best: i === 0 });
    });
  }
  rows.sort((a, b) => String(b.postedUtc || '').localeCompare(String(a.postedUtc || '')));
  return rows.slice(0, limit);
}

function railBlock(kicker, heading) {
  const block = el('section', 'rail-block panel');
  block.append(el('div', 'kicker', kicker));
  block.append(el('h2', null, heading));
  return block;
}

function paintRail() {
  const rail = byId('rail');
  const deck = byId('deck');
  if (!rail || !deck) {
    return;
  }
  const pilots = standings();
  const feed = latestTimes(6);
  rail.textContent = '';
  if (!pilots.length) {
    rail.hidden = true;
    deck.classList.remove('has-rail');
    return;
  }
  rail.hidden = false;
  deck.classList.add('has-rail');

  const table = railBlock('Standings', str('app.fastest_pilots'));
  pilots.slice(0, 8).forEach((p, i) => {
    const row = el('div', `standing p${i + 1}`);
    row.append(el('span', 'rk', String(i + 1)));
    row.append(el('span', 'nm', p.name));
    row.append(el('span', 'sc', String(p.records)));
    row.append(el('span', 'mt', joined([
      p.records === 1 ? 'record held' : 'records held',
      p.laps > p.records ? plural(p.laps, 'lap', 'laps') : '',
    ])));
    table.append(row);
  });
  table.append(el('p', 'rail-note', str('app.ranked_by_track_records_held_then')));
  rail.append(table);

  if (feed.length) {
    const lately = railBlock('Lately', str('app.times_posted'));
    const list = el('div', 'feed');
    for (const row of feed) {
      const line = el('div', 'feed-row');
      line.append(el('span', 'nm', row.name));
      line.append(timeNode(row.lapMs, `rail-time${row.best ? ' best' : ''}`));
      const on = el('a', 'on', row.course.name);
      on.href = courseHref(row.course.id);
      line.append(on);
      line.append(el('span', 'ago', formatAgo(row.postedUtc)));
      list.append(line);
    }
    lately.append(list);
    rail.append(lately);
  }
}

/* ------------------------------------------------------------------ */
/* Counts                                                              */
/* ------------------------------------------------------------------ */

function paintStats() {
  const n = state.courses.length;
  const times = state.courses.reduce((sum, t) => sum + (t.times || 0), 0);
  const pilots = standings().length;
  const mast = byId('mast-stats');
  const spine = byId('spine-stats');
  if (mast) {
    mast.hidden = !n;
  }
  const courseCell = byId('stat-courses');
  const timeCell = byId('stat-times');
  const pilotCell = byId('stat-pilots');
  if (courseCell) {
    courseCell.textContent = String(n);
  }
  if (timeCell) {
    timeCell.textContent = String(times);
  }
  if (pilotCell) {
    pilotCell.textContent = String(pilots);
    pilotCell.parentElement.hidden = pilots === 0;
  }
  if (spine) {
    spine.textContent = n
      ? joined([
        plural(n, 'track', 'tracks'),
        plural(times, 'time', 'times'),
        pilots ? plural(pilots, 'pilot', 'pilots') : '',
      ])
      : '';
  }
}

/* ------------------------------------------------------------------ */
/* Times, fetched only where there are any                             */
/* ------------------------------------------------------------------ */

const inflight = new Map();

async function loadTimes(id) {
  const held = state.timesById.get(id);
  if (held) {
    return held;
  }
  /* The sheet and the background fill can both want the same track, and
   * a shared promise is cheaper than a second request. */
  if (inflight.has(id)) {
    return inflight.get(id);
  }
  const run = (async () => {
    const res = await fetch(here(`api/tracks/${encodeURIComponent(id)}`));
    const detail = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(detail.error || str('app.those_times_could_not_be_loaded'));
    }
    const times = detail.times || [];
    state.timesById.set(id, times);
    return times;
  })();
  inflight.set(id, run);
  try {
    return await run;
  } finally {
    inflight.delete(id);
  }
}

async function hydrate() {
  const active = state.courses.filter((t) => (t.times || 0) > 0);
  await Promise.all(active.map(async (track) => {
    try {
      const times = await loadTimes(track.id);
      const card = document.querySelector(`.card[data-id="${CSS.escape(track.id)}"]`);
      if (card) {
        paintPodium(card, times);
      }
    } catch (e) {
      /* The record from the list payload is still on the tile. */
    }
  }));
  paintRail();
  paintStats();
}

/* ------------------------------------------------------------------ */
/* The switch, which is the aircraft and nothing else                   */
/* ------------------------------------------------------------------ */

const CRAFT_KEY = 'webfpv.board.craft.v1';

/*
 * Which aircraft this visitor is here for: the link first, then what they
 * chose last time, then the five inch.
 *
 * The link wins because it is the more recent statement of intent, and it is
 * how the simulator hands its own answer over: a pilot who pressed The board
 * on the web while seated on a whoop should not arrive on the five inch
 * board. Both the class and the airframe id are accepted, so a link can
 * carry whichever of the two the page building it happens to hold.
 */
function readCraft() {
  try {
    const wanted = new URL(window.location.href).searchParams.get('craft');
    if (wanted === 'micro' || wanted === 'whoop65') {
      return 'micro';
    }
    if (wanted === 'full' || wanted === '5inch') {
      return 'full';
    }
  } catch (e) {
    /* No URL to read. Fall through to the remembered answer. */
  }
  try {
    return localStorage.getItem(CRAFT_KEY) === 'micro' ? 'micro' : 'full';
  } catch (e) {
    return 'full';
  }
}

function writeCraft(craft) {
  try {
    localStorage.setItem(CRAFT_KEY, craft === 'micro' ? 'micro' : 'full');
  } catch (e) {
    /* Private mode. The choice holds for this visit and not past it. */
  }
  try {
    const url = new URL(window.location.href);
    if (craft === 'micro') {
      url.searchParams.set('craft', 'micro');
    } else {
      url.searchParams.delete('craft');
    }
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (e) {
    /* No history. The page still works. */
  }
}

function showCraft(craft, { write = true } = {}) {
  state.craft = craft === 'micro' ? 'micro' : 'full';
  for (const [id, lit] of [['craft-full', state.craft === 'full'], ['craft-micro', state.craft === 'micro']]) {
    const btn = byId(id);
    if (btn) {
      btn.classList.toggle('is-on', lit);
      btn.setAttribute('aria-pressed', lit ? 'true' : 'false');
    }
  }
  if (write) {
    writeCraft(state.craft);
  }
  paintCraftCounts();
  paintTags();
  paintGrid();
}

/* How many tracks each aircraft has, counted over everything the board
 * holds rather than over what the other filters leave: this switch is above
 * them and a count that moved when a search did would read as the switch
 * being part of the search. */
function paintCraftCounts() {
  const by = { full: 0, micro: 0 };
  for (const t of state.courses) {
    by[classOf(t)] += 1;
  }
  for (const [id, n] of [['craft-full-count', by.full], ['craft-micro-count', by.micro]]) {
    const cell = byId(id);
    if (cell) {
      cell.textContent = n ? plural(n, 'track', 'tracks') : 'none yet';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

/*
 * SIGNING IN, AND WHERE THE TOKEN LIVES.
 *
 * sessionStorage, not localStorage and not a cookie, and each of those is
 * a decision rather than a default.
 *
 * Not a cookie, because a cookie is sent by the browser rather than by this
 * page, and the board reflects whatever origin asks it. See cors() in
 * src/server.js: the moment a credential travels on the browser's own
 * initiative, reflecting the origin becomes a standing grant to every site
 * on the internet. A token this page attaches by hand is reachable only by
 * script on this origin, so the reflection stays as harmless as it was.
 *
 * sessionStorage rather than localStorage because this is an admin
 * credential and the tab closing is a perfectly good moment to lose it. The
 * server gives it twelve hours anyway; whichever runs out first wins.
 */
const ADMIN_KEY = 'webfpv.board.admin.v1';

const admin = {
  token: '', email: '', kind: '', expiresUtc: '', sponsors: [],
};

function readAdminToken() {
  try {
    return sessionStorage.getItem(ADMIN_KEY) || '';
  } catch (e) {
    /* Storage refused, which is a private window or a locked down browser.
     * Signing in still works for as long as this page is open; it just does
     * not survive a reload. */
    return '';
  }
}

function writeAdminToken(token) {
  try {
    if (token) {
      sessionStorage.setItem(ADMIN_KEY, token);
    } else {
      sessionStorage.removeItem(ADMIN_KEY);
    }
  } catch (e) {
    /* As above. The in-memory copy is what the requests use. */
  }
}

function signedIn() {
  return Boolean(admin.token);
}

/* The one place an admin request is built, so nothing else has to remember
 * to attach the token or to notice that the board stopped believing it. */
async function adminFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (admin.token) {
    headers.authorization = str('app.bearer', { token: admin.token });
  }
  const r = await fetch(here(path), { ...options, headers });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    /*
     * The board no longer believes the token: it expired, the whitelist
     * changed, or a password was changed, which invalidates every session
     * it minted. Drop it here rather than letting the next request fail the
     * same way, so the page goes back to its signed out face immediately
     * and the panel is honest about what it can do.
     */
    forgetAdmin();
    const err = new Error(body.error || str('app.that_sign_in_is_no_longer'));
    err.signedOut = true;
    throw err;
  }
  if (!r.ok) {
    throw new Error(body.error || str('app.the_board_answered', { status: r.status }));
  }
  return body;
}

function forgetAdmin() {
  admin.token = '';
  admin.email = '';
  admin.kind = '';
  admin.expiresUtc = '';
  admin.sponsors = [];
  writeAdminToken('');
  paintAdmin();
}

function paintAdminButton() {
  const btn = byId('admin-open');
  if (!btn) {
    return;
  }
  btn.classList.toggle('is-on', signedIn());
  /* The address, not the word "Admin", once somebody is signed in: a board
   * that can delete a track should say whose hands are on it, and the local
   * part is enough to recognise yourself by without printing an email
   * address across the masthead. */
  btn.textContent = signedIn() ? (admin.email.split('@')[0] || str('app.signed_in')) : 'Admin';
  btn.setAttribute('aria-label', signedIn() ? str('app.admin_signed_in_as', { v1: admin.email || str('app.this_board_s_token') }) : 'Admin');
}

/* The panel's two faces, and the track sheet's control, all follow from one
 * fact, so they are painted together and never separately. */
/*
 * The sponsors, and the link each one is given.
 *
 * It lives in the admin panel rather than on the statistics tab because the
 * LIST is the set of sponsors including the ones with no traffic yet, which
 * is a commercial fact. The numbers per sponsor are public on that tab, so
 * a sponsor can check them without asking anybody.
 *
 * Copy rather than a mailto or a download: the one thing anybody does with
 * this is paste it into an email, and the clipboard is one press away.
 */
function paintAdminSponsors() {
  const host = byId('admin-sponsors');
  if (!host) {
    return;
  }
  host.textContent = '';
  host.hidden = !signedIn();
  if (!signedIn()) {
    return;
  }
  host.append(el('h3', null, str('app.sponsor_links')));
  const rows = admin.sponsors || [];
  if (!rows.length) {
    host.append(el('p', null, str('app.no_sponsors_are_set_on_this')));
    return;
  }
  host.append(el('p', null, str('app.each_link_lands_in_the_simulator')));
  for (const sponsor of rows) {
    const row = el('div', 'sponsor-row');
    row.append(el('span', 'sponsor-name', sponsor.name || sponsor.slug));
    row.append(el('span', 'sponsor-link', sponsor.link || ''));
    const copy = el('button', 'btn small', str('app.copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sponsor.link || '');
        copy.textContent = str('app.copied');
      } catch (e) {
        /* No clipboard permission, or an insecure origin. The link is on
         * screen and can be selected, so this says so rather than failing
         * silently. */
        copy.textContent = str('app.select_it');
      }
      setTimeout(() => {
        copy.textContent = str('app.copy');
      }, 1600);
    });
    row.append(copy);
    host.append(row);
  }
}

function paintAdmin() {
  paintAdminButton();
  const form = byId('admin-signin');
  const signed = byId('admin-signed');
  if (form) {
    form.hidden = signedIn();
  }
  if (signed) {
    signed.hidden = !signedIn();
  }
  const who = byId('admin-who');
  if (who) {
    who.textContent = admin.email || str('app.this_board_s_own_token');
  }
  const until = byId('admin-until');
  if (until) {
    const when = formatUntil(admin.expiresUtc);
    until.textContent = when
      ? str('app.this_sign_in_runs_out_and', { when })
      : str('app.closing_this_tab_ends_this_sign');
  }
  paintAdminSponsors();
  const track = state.openId ? courseById(state.openId) : null;
  if (track) {
    paintSheetAdmin(track);
  } else {
    const host = byId('sheet-admin');
    if (host) {
      host.hidden = true;
      host.textContent = '';
    }
  }
}

function adminError(message) {
  const box = byId('admin-error');
  if (box) {
    box.textContent = message || '';
  }
}

async function signIn(email, password) {
  const body = await adminFetch('api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  admin.token = body.token || '';
  admin.email = body.email || '';
  admin.kind = 'session';
  admin.expiresUtc = body.expiresUtc || '';
  admin.sponsors = Array.isArray(body.sponsors) ? body.sponsors : [];
  writeAdminToken(admin.token);
  paintAdmin();
}

/*
 * A token kept from before the reload, checked rather than trusted.
 *
 * The board is the only thing that knows whether it is still good, and the
 * cost of asking is one request that happens on a page load nobody is
 * watching. The alternative is a masthead that says somebody is signed in
 * until the moment they press the one button that matters.
 */
async function restoreAdmin() {
  const token = readAdminToken();
  if (!token) {
    paintAdmin();
    return;
  }
  admin.token = token;
  try {
    const body = await adminFetch('api/admin/session');
    admin.email = body.email || '';
    admin.kind = body.kind || 'session';
    admin.expiresUtc = body.expiresUtc || '';
    admin.sponsors = Array.isArray(body.sponsors) ? body.sponsors : [];
    paintAdmin();
  } catch (e) {
    /* adminFetch has already dropped it and repainted if the board said no.
     * A board that is simply down leaves the token alone: it may be good
     * again in a minute, and nothing on the page acts on it meanwhile. */
    if (!e.signedOut) {
      paintAdmin();
    }
  }
}

/*
 * THE ONE CONTROL THAT DESTROYS SOMETHING.
 *
 * Two presses, and the second one is a different colour and says what it is
 * about to take. Not window.confirm, for two reasons: it cannot say how
 * many times are about to go with the track, and a browser dialog is the
 * thing people dismiss without reading because almost every one they have
 * ever seen was worth dismissing.
 *
 * It disarms itself after a few seconds, so a panel left open on a desk
 * does not have a loaded button in it.
 */
function paintSheetAdmin(track) {
  const host = byId('sheet-admin');
  if (!host) {
    return;
  }
  host.textContent = '';
  host.hidden = !signedIn();
  if (!signedIn()) {
    return;
  }
  host.append(el('div', 'kicker', str('app.admin')));
  const held = track.times || 0;
  host.append(el('p', null, held
    ? str('app.taking_this_off_the_board_takes', { plural: plural(held, 'posted time', 'posted times') })
    : str('app.taking_this_off_the_board_cannot')));

  const btn = el('button', 'btn danger small', str('app.take_off_the_board'));
  btn.type = 'button';
  let armed = 0;
  const disarm = () => {
    clearTimeout(armed);
    armed = 0;
    btn.classList.remove('armed');
    btn.textContent = str('app.take_off_the_board');
  };
  btn.addEventListener('click', async () => {
    if (!armed) {
      btn.classList.add('armed');
      btn.textContent = str('app.remove_for_good', { name: track.name });
      armed = setTimeout(disarm, 6000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    btn.disabled = true;
    btn.textContent = str('app.removing');
    try {
      await adminFetch(`api/tracks/${encodeURIComponent(track.id)}/remove`, { method: 'POST' });
      dropTrack(track.id);
    } catch (e) {
      btn.disabled = false;
      disarm();
      host.append(el('p', 'admin-error', e.message));
    }
  });
  host.append(btn);
}

/*
 * What the page does about a track that is no longer there: forget it, put
 * the reader back on the grid, and repaint everything that counted it. The
 * alternative is a reload, which throws away the search and the tag filter
 * somebody had set to find the track they just removed.
 */
function dropTrack(id) {
  state.courses = state.courses.filter((t) => t.id !== id);
  state.timesById.delete(id);
  paintStats();
  paintCraftCounts();
  paintAuthors();
  paintTags();
  paintGrid();
  paintRail();
  /* clearHash routes back to the grid and returns focus to whatever opened
   * the sheet, which is the card that no longer exists; route() closing the
   * sheet is what matters and a missing focus target is handled there. */
  clearHash();
}

function bindAdmin() {
  const open = byId('admin-open');
  const close = byId('admin-close');
  const form = byId('admin-signin');
  const out = byId('admin-signout');
  if (open) {
    open.addEventListener('click', () => {
      adminError('');
      openSheet(byId('admin-sheet'));
      paintAdmin();
      /* Straight into the field, because somebody who pressed Admin is
       * here to type. Only when there is something to type into. */
      const field = byId('admin-email');
      if (field && !byId('admin-signin').hidden) {
        field.focus();
      }
    });
  }
  if (close) {
    close.addEventListener('click', closeAdmin);
  }
  if (out) {
    out.addEventListener('click', () => {
      forgetAdmin();
      closeAdmin();
    });
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = byId('admin-email');
      const password = byId('admin-password');
      const submit = byId('admin-submit');
      const busy = byId('admin-busy');
      adminError('');
      submit.disabled = true;
      if (busy) {
        busy.hidden = false;
      }
      try {
        await signIn(email.value, password.value);
        /* The password does not stay in the DOM a moment longer than the
         * request needs it. */
        password.value = '';
      } catch (err) {
        adminError(err.message);
        password.select();
      } finally {
        submit.disabled = false;
        if (busy) {
          busy.hidden = true;
        }
      }
    });
  }
}

/*
 * Closing the panel goes back through route(), so a track sheet that was
 * open behind it comes back rather than the reader being dropped on the
 * grid. The admin panel has no hash of its own, which is why this is not
 * clearHash.
 */
function closeAdmin() {
  const panel = byId('admin-sheet');
  if (!panel || panel.hidden) {
    return;
  }
  panel.hidden = true;
  document.body.classList.remove('locked');
  setPageInert(false);
  route();
  const back = state.lastFocus;
  if (back && document.contains(back) && !byId('admin-sheet').contains(back)) {
    back.focus();
  } else {
    const open = byId('admin-open');
    if (open) {
      open.focus();
    }
  }
}

/* ------------------------------------------------------------------ */
/* The track sheet                                                    */
/* ------------------------------------------------------------------ */

/* Each pair goes in its own box, because a bare dt and dd in a grid flow
 * as two separate cells and a label ends up above somebody else's value. */
function factRow(list, label, value) {
  if (value == null || value === '') {
    return;
  }
  const cell = el('div');
  cell.append(el('dt', null, label), el('dd', null, String(value)));
  list.append(cell);
}

function paintShot(host, track) {
  host.textContent = '';
  host.append(planCanvas(track.plan, planLabel(track), { scaleBar: true, pad: 26 }));
  if (reduceMotion()) {
    return;
  }
  const frame = document.createElement('iframe');
  frame.className = 'orbit';
  frame.title = str('app.a_flight_through_the_track', { name: track.name });
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = orbitHref(state.config, track.id);
  const wait = el('div', 'shot-wait');
  wait.append(el('span', 'shot-dot'), el('span', null, str('app.flying_the_track')));
  host.append(wait, frame);
}

function paintBoard(host, track, times) {
  host.textContent = '';
  const head = el('div', 'board-head');
  head.append(el('h3', null, times.length ? str('app.every_time_posted') : str('app.the_board_is_open')));
  if (times.length) {
    head.append(el('span', 'count', plural(times.length, 'lap', 'laps')));
  }
  host.append(head);

  if (!times.length) {
    host.append(el('p', 'none', str('app.nobody_has_posted_a_lap_on', { name: track.name })));
    return;
  }

  const leader = times[0].lapMs;
  const slowest = times[times.length - 1].lapMs || leader;
  /*
   * THE THREE LAP COLUMN, and it only appears where it means something.
   *
   * RaceGOW is scored on three CONSECUTIVE laps where MultiGP's time trial
   * is scored on one, so a room's sheet carries both numbers. A field's does
   * not: no time on this board has ever been posted with one, and a column
   * of dashes is worse than no column. Even on a room it waits until at
   * least one pilot has actually put three clean laps together, because a
   * run that crashed on lap two has nothing to print there.
   */
  const wantsThree = classOf(track) === 'micro'
    && times.some((t) => Number.isFinite(t.threeMs));
  const columns = [['rank', ''], ['nm', 'Pilot'], ['time', 'Lap']];
  if (wantsThree) {
    columns.push([str('app.time_three'), str('app.three_laps')]);
  }
  columns.push(['gap', 'Gap'], ['when', 'Posted'], ['chase', '']);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [cls, label] of columns) {
    headRow.append(el('th', cls, label));
  }
  thead.append(headRow);
  table.append(thead);

  const body = document.createElement('tbody');
  times.forEach((row, i) => {
    const tr = el('tr', `r${i + 1}`);
    tr.append(el('td', 'rank', String(i + 1)));

    const name = el('td', 'nm');
    name.append(el('span', null, row.name));
    const bar = el('div', 'gap-bar');
    const fill = el('span');
    fill.style.width = `${Math.max(8, (row.lapMs / slowest) * 100)}%`;
    bar.append(fill);
    name.append(bar);
    tr.append(name);

    const time = el('td', 'time');
    time.append(timeNode(row.lapMs, 'tm'));
    tr.append(time);

    if (wantsThree) {
      const three = el('td', str('app.time_three'));
      if (Number.isFinite(row.threeMs)) {
        three.append(timeNode(row.threeMs, 'tm'));
      } else {
        /* A run that never put three clean laps together leaves the cell
         * EMPTY, the way the gap column already leaves the leader's. A zero
         * would be a time, and a dash would be a mark this page does not
         * otherwise make. */
        three.title = str('app.this_run_did_not_put_three');
      }
      tr.append(three);
    }

    const gap = el('td', 'gap');
    if (i > 0) {
      gap.append(timeNode(row.lapMs - leader, 'tm', '+'));
    }
    tr.append(gap);

    const when = el('td', 'when', formatAgo(row.postedUtc));
    when.title = formatWhen(row.postedUtc);
    tr.append(when);

    /* Times posted with a recorded lap can be chased in the simulator; the
     * rest hold an empty cell so the columns stay put. */
    const chase = el('td', 'chase');
    if (row.hasGhost && row.id) {
      chase.append(chaseLink(state.config, track.id, row));
    }
    tr.append(chase);
    body.append(tr);
  });
  table.append(body);
  host.append(table);
}

function paintHero(host, track, times) {
  host.textContent = '';
  const best = times.length ? times[0] : track.best;
  /* An empty hero is a row of dashes the size of a headline, so a track
   * with no record does not get one. The board below says it in words. */
  host.hidden = !best;
  if (!best) {
    return;
  }
  host.append(el('span', 'record-label', str('app.track_record')));
  host.append(timeNode(best.lapMs, 'record-time'));
  host.append(el('div', 'record-holder', best.name));
}

function copyButton(url) {
  const btn = el('button', 'text', str('app.copy_link'));
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = str('app.link_copied');
    } catch (e) {
      btn.textContent = url;
    }
    setTimeout(() => {
      btn.textContent = str('app.copy_link');
    }, 2200);
  });
  return btn;
}

async function paintSheet(track) {
  byId('sheet-kicker').textContent = track.times > 0
    ? `${plural(track.times, 'time', 'times')} posted`
    : str('app.open_track');
  byId('sheet-title').textContent = track.name;
  const by = byId('sheet-by');
  by.textContent = '';
  if (track.designer) {
    by.append(str('app.designed_by_2'));
    by.append(el('b', null, track.designer));
    by.append(track.series ? str('app.for_2', { series: track.series }) : '.');
    by.append(str('app.brought_over_by', { author: track.author }));
  } else {
    by.append(str('app.built_by'));
    by.append(el('b', null, track.author));
  }
  const published = formatWhen(track.publishedUtc);
  by.append(published ? str('app.published', { published }) : '.');

  paintShot(byId('sheet-shot'), track);

  const facts = byId('sheet-facts');
  facts.textContent = '';
  /* First, because it is what the track is FOR, and the gate count and the
   * field size are what it is made of. */
  if (tagsOf(track).length) {
    factRow(facts, str('app.built_for'), tagsOf(track).map(tagLabel).join(', '));
  }
  factRow(facts, 'Gates', plural(track.gates, 'gate', 'gates'));
  factRow(facts, 'Elements', track.elements);
  factRow(facts, classOf(track) === 'micro' ? 'Room' : 'Field', fieldSize(track));
  factRow(facts, str('app.flown_on'), craftLabel(track));
  factRow(facts, 'Updated', formatAgo(track.updatedUtc));
  if (track.hasLogo) {
    factRow(facts, 'Branding', str('app.sponsor_print'));
  }

  const actions = byId('sheet-actions');
  actions.textContent = '';
  const fly = el('a', 'btn primary', str('app.fly_this_track'));
  fly.href = flyHref(state.config, track.id);
  fly.target = SIM_WINDOW;
  const remix = el('a', 'text', str('app.remix_in_the_builder'));
  remix.href = remixHref(state.config, track.id);
  /* The builder is the simulator's tab, not a third one: the simulator
   * navigates to the builder in place, so they share the name. */
  remix.target = SIM_WINDOW;
  actions.append(fly, remix, copyButton(`${state.config.boardOrigin}/${courseHref(track.id)}`));

  paintSheetAdmin(track);

  const held = timesFor(track.id) || [];
  paintHero(byId('sheet-hero'), track, held);
  paintBoard(byId('sheet-board'), track, held);
  paintPlans(byId('sheet'));

  if (!timesFor(track.id) && (track.times || 0) > 0) {
    try {
      const times = await loadTimes(track.id);
      if (state.openId === track.id) {
        paintHero(byId('sheet-hero'), track, times);
        paintBoard(byId('sheet-board'), track, times);
      }
    } catch (e) {
      byId('sheet-board').append(el('p', 'none', e.message));
    }
  }
}

/* The page behind an open sheet is inert, so tabbing cannot walk out of
 * the dialog into a grid nobody can see. */
function setPageInert(on) {
  for (const node of [document.querySelector('.mast'), document.querySelector('.spine'), byId('tracks'), document.querySelector('footer')]) {
    if (node) {
      node.inert = on;
    }
  }
}

function sheetOpen() {
  return !byId('sheet').hidden || !byId('credits-sheet').hidden || !byId('admin-sheet').hidden;
}

function closeSheets() {
  /* The admin panel is in this list so that opening a track over it closes
   * it, rather than the two stacking. It is NOT opened by route(), which is
   * the difference between it and the other two: see closeAdmin. */
  for (const id of ['sheet', 'credits-sheet', 'admin-sheet']) {
    const node = byId(id);
    if (!node.hidden) {
      node.hidden = true;
    }
  }
  /* Stop the simulator that was running inside the sheet. */
  const shot = byId('sheet-shot');
  if (shot) {
    shot.textContent = '';
  }
  state.openId = null;
  document.body.classList.remove('locked');
  setPageInert(false);
}

function openSheet(node) {
  if (!sheetOpen()) {
    state.lastFocus = document.activeElement;
  }
  closeSheets();
  node.hidden = false;
  node.scrollTop = 0;
  document.body.classList.add('locked');
  setPageInert(true);
  const close = node.querySelector('.btn');
  if (close) {
    close.focus();
  }
}

function clearHash() {
  const back = state.lastFocus;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  route();
  if (back && document.contains(back)) {
    back.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Routing. A track is an address, so it can be linked and shared.    */
/* ------------------------------------------------------------------ */

/*
 * WHICH TAB IS SHOWING, and it is decided by the address rather than by a
 * click, so a pasted #stats lands on the statistics and a reload stays put.
 *
 * The aircraft switch belongs to the tracks tab alone: it chooses which
 * tracks are listed and means nothing beside a page of counters, so it is
 * hidden with the section it governs rather than standing above both.
 */
let shownTab = '';

function showTab(name) {
  const stats = name === 'stats';
  const changed = Boolean(shownTab) && shownTab !== name;
  shownTab = name;
  const tracks = byId('view-tracks');
  const board = byId('view-stats');
  const craft = byId('craftswitch');
  if (tracks) {
    tracks.hidden = stats;
  }
  if (board) {
    board.hidden = !stats;
  }
  if (craft) {
    craft.hidden = stats;
  }
  for (const [id, on] of [['tab-tracks', !stats], ['tab-stats', stats]]) {
    const tab = byId(id);
    if (!tab) {
      continue;
    }
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    /* One tab stop for the row, which is how a tablist is meant to work:
     * Tab reaches the chosen tab and the arrow keys move between them. */
    tab.tabIndex = on ? 0 : -1;
  }
  /*
   * A reader who followed the footer's link is standing at the foot of the
   * page while the section they asked for swaps in above them, out of
   * sight. Bring the row into view then, and only then: a click on a tab
   * that is already on screen must not move the page, and the first paint
   * of a pasted #stats must not scroll the masthead away.
   */
  if (changed) {
    const row = byId('tabs');
    const box = row ? row.getBoundingClientRect() : null;
    if (box && (box.top < 0 || box.bottom > window.innerHeight)) {
      row.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
  }
  showStats(stats);
}

function route() {
  const hash = location.hash;
  if (hash === '#stats') {
    closeSheets();
    showTab('stats');
    return;
  }
  showTab('tracks');
  if (hash === '#credits') {
    /* Old bookmarks, and the three Credits links before bindLinks ran,
     * used to open an overlay copy of the roll. Take this tab to the
     * simulator's credits page instead. */
    window.location.replace(creditsHref(state.config));
    return;
  }
  /*
   * #track= is what the address bar shows now, and #course= is what every
   * link shared before this change says. Both are read, one is written.
   *
   * The board's whole point is that a track is a URL somebody can send to
   * somebody else, so a rename that quietly broke the ones already sent
   * would be the worst possible way to fix a noun. The old spelling is
   * accepted for reading and then REWRITTEN in place, so a visitor arriving
   * on an old link lands on the right track and leaves with a link that
   * says track.
   */
  const found = hash.match(/^#(?:track|course)=(.+)$/);
  if (found) {
    let id = '';
    try {
      id = decodeURIComponent(found[1]);
    } catch (e) {
      id = found[1];
    }
    const track = courseById(id);
    if (!track) {
      closeSheets();
      return;
    }
    /* Arrived on the old spelling: put the canonical one in the address bar
     * without adding a history entry, so Back still goes where it went. */
    if (hash.startsWith('#course=')) {
      history.replaceState(null, '', courseHref(track.id));
    }
    openSheet(byId('sheet'));
    state.openId = id;
    paintSheet(track);
    return;
  }
  closeSheets();
}

/* ------------------------------------------------------------------ */
/* Page furniture                                                      */
/* ------------------------------------------------------------------ */

function watchSpine() {
  const mast = document.querySelector('.mast');
  const spine = document.querySelector('.spine');
  if (!mast || !spine) {
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      spine.classList.toggle('on', !entry.isIntersecting);
    }
  }, { threshold: 0 });
  io.observe(mast);
}

function bindLinks(config) {
  const sim = `${config.simOrigin}/`;
  const builder = `${config.simOrigin}/src/trackbuilder/index.html`;
  const credits = creditsHref(config);
  /* These used to navigate this tab, which left the visitor with a
   * simulator where the board had been and no way back but the back
   * button. They go to the simulator's tab now, the same one Fly this
   * track uses, so the board stays open behind it and a second click
   * does not make a second simulator. Credits is the same tab, on
   * the simulator's #credits page. */
  const set = (id, href) => {
    const n = byId(id);
    if (n) {
      n.href = href;
      n.target = SIM_WINDOW;
    }
  };
  set('sim-link', sim);
  set('foot-sim', sim);
  set('builder-link', builder);
  set('spine-build', builder);
  set('mast-credits', credits);
  set('spine-credits', credits);
  set('foot-credits', credits);
}

/*
 * THE MARK GOES HOME, and it is deliberately not part of bindLinks.
 *
 * bindLinks writes the simulator's tab name onto everything it touches,
 * because those links cross to the simulator and a pilot wants one of it.
 * This link crosses the other way, to the page the visitor came in through,
 * and it belongs in the tab they are standing in. It also owes nothing to
 * /api/config, so it is bound once and never corrected.
 */
function bindHome() {
  const href = landingHref();
  if (!href) {
    return;
  }
  for (const id of ['brand-home', 'spine-home']) {
    const n = byId(id);
    if (n) {
      n.href = href;
    }
  }
}

function bindCraftSwitch() {
  for (const [id, craft] of [['craft-full', 'full'], ['craft-micro', 'micro']]) {
    const btn = byId(id);
    if (btn) {
      btn.addEventListener('click', () => showCraft(craft));
    }
  }
}

function bindToolbar() {
  const find = byId('find');
  const sort = byId('sort');
  const by = byId('by');
  if (find) {
    find.addEventListener('input', () => {
      state.query = find.value;
      /* The tag counts are measured against everything the OTHER filters
       * leave standing, so they move when the search does. */
      paintTags();
      paintGrid();
    });
    find.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && find.value) {
        e.stopPropagation();
        find.value = '';
        state.query = '';
        paintTags();
        paintGrid();
      }
    });
  }
  if (sort) {
    sort.value = state.sort;
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      paintGrid();
    });
  }
  if (by) {
    by.addEventListener('change', () => {
      state.author = by.value;
      paintTags();
      paintGrid();
    });
  }
}

/*
 * The tag vocabulary, taken off the track list's own payload.
 *
 * It used to ride the freestyle board's request, which is gone, and the
 * board is the copy of record for which tags are legal so it cannot simply
 * be written down here. /api/tracks carries it now: one request, and the
 * list this page offers and the list the board accepts cannot drift.
 */
function readTags(payload) {
  if (!Array.isArray(payload.tags) || !payload.tags.length) {
    return;
  }
  TAGS = payload.tags;
  TAG_LABEL.clear();
  for (const tag of TAGS) {
    TAG_LABEL.set(tag.id, tag.label);
  }
}

function bindCredits() {
  const roll = byId('credits-roll');
  if (roll) {
    fillCredits(roll, { assetBase: 'credits' });
  }
  for (const id of ['credits-close', 'sheet-close']) {
    const btn = byId(id);
    if (btn) {
      btn.addEventListener('click', clearHash);
    }
  }
}

/* A card's iframe says when its first frame is up, so the plan underneath
 * can hand over rather than cut. */
function watchOrbit() {
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'fdfpv-orbit-ready') {
      return;
    }
    for (const frame of document.querySelectorAll('iframe.orbit')) {
      if (frame.contentWindow !== e.source) {
        continue;
      }
      frame.classList.add('ready');
      const wait = frame.parentElement && frame.parentElement.querySelector('.shot-wait');
      if (wait) {
        wait.hidden = true;
      }
    }
  });
}

/*
 * The arrow keys walk the tab row, which is what a tablist promises and the
 * one thing an anchor does not do on its own. Home and End as well, because
 * a two tab row still costs nothing to get right and a third tab would
 * arrive with this already working.
 */
function bindTabs() {
  const row = byId('tabs');
  if (!row) {
    return;
  }
  const tabs = [...row.querySelectorAll('[role="tab"]')];
  /*
   * THE TWO TABS USED TO JUMP DIFFERENTLY. #tracks is the address of <main>,
   * so the browser scrolled it to the top and took the masthead with it,
   * while #stats matches no element and moved nothing. A plain left click
   * now sets the address by hand and routes, with no scroll; every other
   * kind of click, a middle button, a modifier key, is left to the browser,
   * because those are somebody opening the tab in a new one and the href is
   * real for exactly that reason. pushState fires no hashchange, so route()
   * is called here; Back does fire one, because the entries differ in
   * fragment, and the listener handles that.
   */
  for (const tab of tabs) {
    tab.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      const href = tab.getAttribute('href') || '#';
      if (location.hash !== href) {
        history.pushState(null, '', href);
      }
      route();
    });
  }
  row.addEventListener('keydown', (e) => {
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) {
      return;
    }
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = (at + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (at - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = tabs.length - 1;
    }
    if (next < 0) {
      return;
    }
    e.preventDefault();
    /* Follow the link as well as move the focus. These are addresses, so
     * choosing one is a navigation and not a widget state. */
    tabs[next].focus();
    tabs[next].click();
  });
}

function watchKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      /* The admin panel first, and by its own path: it is the one dialog
       * with no address, so clearing a hash would close whatever is behind
       * it and leave the panel standing. */
      if (!byId('admin-sheet').hidden) {
        closeAdmin();
        return;
      }
      /* A tab address is not something Escape should undo: somebody
       * reading the statistics has not opened anything to close, and
       * clearing the hash would move them to the tracks under their eyes. */
      if (location.hash && location.hash !== '#stats' && location.hash !== '#tracks') {
        clearHash();
      }
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || sheetOpen()) {
        return;
      }
      const find = byId('find');
      if (find && !find.closest('[hidden]')) {
        e.preventDefault();
        find.focus();
        find.select();
      }
    }
  });
}

function watchResize() {
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintPlans(document), 140);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  /* This tab is the board, and there is only ever one of it: the
   * simulator's Leaderboard opens the board under this name, so a pilot
   * who checks the times between runs comes back to this tab instead of
   * stacking up another one. window.name survives navigation within this
   * origin, so the bugs page and a track hash keep the claim. */
  window.name = BOARD_WINDOW;
  window.addEventListener('hashchange', route);
  if (location.hash === '#credits') {
    route();
    return;
  }
  watchSpine();
  watchOrbit();
  watchKeys();
  watchResize();
  bindCredits();
  /*
   * BEFORE THE REQUESTS, and before the two early returns below it.
   *
   * The Admin button has to work on a board that is empty and on a board
   * whose list request failed, which are exactly the two states somebody
   * signs in to do something about. Binding it after the fetches would
   * leave a dead button on both. restoreAdmin is deliberately not awaited:
   * it is one request nobody is waiting for, and the tracks matter more.
   */
  bindAdmin();
  restoreAdmin();
  /*
   * THE STATISTICS TAB IS BOUND HERE FOR THE SAME REASON THE ADMIN BUTTON
   * IS: it has to work on a board with nothing published and on a board
   * whose list request just failed, and those are two of the states
   * somebody opens it in. Both of the early returns below are past this.
   *
   * pingVisit is the board's own arrival, counted once per browser per day
   * across all three pages, and it captures a sponsor slug out of the query
   * on the way past. It talks to nothing when the pilot has opted out or
   * their browser sends Global Privacy Control. It is deliberately not
   * awaited: nothing on this page waits for a counter.
   */
  mountStats(here('api/stats'));
  bindTabs();
  pingVisit('board', here('api/stats/events'));
  /*
   * And routed now, not only at the end. The two returns below leave on an
   * empty board and on a failed list, and a visitor who followed a #stats
   * link into either of those would have been shown the tracks tab with
   * nothing on it. route() runs again at the end, where the tracks exist
   * and a #track= link has something to open.
   */
  route();

  const list = byId('list');
  const notice = byId('notice');
  skeletons(list, 6);

  /*
   * The status matters. Reading the body and ignoring `r.ok` meant a 500
   * from the database, or a 502 from in front of it, parsed to an object
   * with no `tracks` in it and painted "Nothing published yet": the one screen
   * that tells a visitor to go and build the first track, shown while
   * every track on the board was sitting there unreachable. An error
   * belongs in the catch below, which already has a panel for it.
   */
  const getJson = async (url) => {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(body.error || str('app.the_board_answered', { status: r.status }));
    }
    return body;
  };

  /*
   * BIND THE LINKS BEFORE ASKING THE SERVER ANYTHING.
   *
   * Every cross-origin href in the HTML is a loopback address, written there
   * so the page still works from a checkout. bindLinks used to be the only
   * thing that replaced them and it ran inside the try below, after the
   * config request: one failed request and a public board kept them, so
   * Open the simulator, Build a track and Credits all pointed at a machine
   * the visitor is not sitting at. The guess is right on both layouts that
   * can be derived from this page's own address, so bind it now and let the
   * served config correct it if and when it arrives.
   */
  bindLinks(state.config);
  bindHome();

  /*
   * The config request is NOT fatal, and the tracks request is.
   *
   * They used to share one try, so a 500 on config threw the whole page away
   * including a board full of tracks that would have loaded. The only thing
   * config carries is simOrigin, which guessSimOrigin has already answered,
   * so losing it costs the links nothing on either derivable layout.
   */
  try {
    /* simOrigin from the board, because only the board knows it: it is the
     * one case a page standing at its own address cannot work out, a board
     * and a simulator on unrelated hosts. boardOrigin from this page,
     * because only this page does. See HERE_ORIGIN above. */
    const served = await getJson(here('api/config'));
    state.config = { ...state.config, ...served, boardOrigin: HERE_ORIGIN };
    bindLinks(state.config);
  } catch (e) {
    /* Deliberately quiet. Nothing a visitor can act on, the links are
     * already bound, and the tracks request below is about to say
     * something far more useful if the board is genuinely down. */
  }

  try {
    const payload = await getJson(here('api/tracks'));
    state.courses = payload.tracks || [];
    readTags(payload);
  } catch (e) {
    list.textContent = '';
    notice.append(el('div', 'status panel', e.message || str('app.this_page_could_not_be_loaded')));
    return;
  }

  paintStats();
  if (!state.courses.length) {
    list.textContent = '';
    const box = el('div', 'empty panel');
    box.append(el('h2', null, str('app.nothing_published_yet')));
    box.append(el('p', null, str('app.build_a_track_in_the_track')));
    const build = el('a', 'btn primary', str('app.build_a_track'));
    build.href = `${state.config.simOrigin}/src/trackbuilder/index.html`;
    build.target = SIM_WINDOW;
    box.append(build);
    notice.append(box);
    return;
  }

  byId('toolbar').hidden = false;
  bindToolbar();
  bindCraftSwitch();
  paintAuthors();
  /* showCraft paints the counts, the tags and the grid, so this is the one
   * call that has to happen and the three below it do not. It is here rather
   * than in bindCraftSwitch because the courses have to be in state first:
   * the counts are over them. */
  showCraft(readCraft(), { write: false });
  route();
  await hydrate();
}

start();
