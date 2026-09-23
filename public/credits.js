/*
 * credits.js: who made this, who flew it, and whose work it stands on.
 *
 * Built as a DOM tree so the simulator overlay and the public board can
 * share the same roll. The live address is the simulator at #credits.
 * This file is the overlay fallback if that page cannot be reached.
 *
 * WHY A PILOT ROW SAYS NOTHING ABOUT THE PILOT. It carries a name, a
 * slot and a link out, and that is all. Anything written under one of
 * these names is somebody describing a person who is not in the room to
 * be asked, and no line of it is worth as much as the name being spelled
 * right and the link going to the right place.
 *
 * WHY THE CARD IS THE HIT TARGET BUT THE NAME IS THE LINK. A pilot card
 * is one thing about one person, so a click anywhere on it should land
 * on their channel. Wrapping the whole card in an <a> would make the
 * accessible name of that link the whole card rather than the name on
 * it. So the heading holds the anchor and the anchor's ::after is
 * stretched over the card.
 * The project cards below could not be wrapped anyway: their copy
 * already carries links, and an <a> inside an <a> is not a document.
 *
 * Marks live in credits/. The four
 * project marks are the official ones: Betaflight's dark wordmark,
 * TrackDraw's dark-background colour mark, Grok's 2025 wordmark,
 * Claude's starburst. The faces are the channels' own pictures, at the
 * size YouTube serves them. All of them are used only to name the work.
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

import { str } from './strings/index.js';

/*
 * The beta roll. Slot numbers are a start list's: the order they turned
 * up, not a ranking.
 *
 * Jannes has no channel to link. His row carries the same slot and the
 * same weight as the other three, with initials where a face would be,
 * because the roll is a record of who flew it and not a list of who
 * posts about it.
 */
/*
 * THE RACEGOW5 ROOMS AND WHO BUILT THEM.
 *
 * Eight tracks in `scripts/racegow-lattice.js`, read off the official
 * animations and brought over by one person. Six other people designed
 * them, and a pilot flying one should be able to find out who. The names
 * here are the `credit.designer` fields of the shipped presets and
 * `scripts/micro-check.js` fails if this list and those presets disagree,
 * so it cannot go stale when a ninth arrives.
 */
const RACEGOW = [
  { designer: 'AyyyKayyy', tracks: [str('credits.track_8')] },
  { designer: str('credits.cumber_and_hotspur'), tracks: [str('credits.track_5')] },
  { designer: 'Skittles', tracks: [str('credits.track_1'), str('credits.track_2')] },
  { designer: str('credits.the_lego_dans'), tracks: [str('credits.track_3'), str('credits.track_4')] },
  { designer: 'MrE', tracks: [str('credits.track_6')] },
  { designer: 'FPVBean', tracks: [str('credits.track_7')] },
];

export const RACEGOW_CREDITS = RACEGOW;

const PILOTS = [
  {
    slot: '01',
    name: 'Asylum',
    face: 'asylum.jpg',
    channel: 'https://www.youtube.com/@AsylumFpv',
    handle: 'youtube.com/@AsylumFpv',
  },
  {
    slot: '02',
    name: 'Jannes',
    face: null,
    channel: null,
    handle: null,
  },
  {
    slot: '03',
    name: 'LeStar',
    face: 'lestar.jpg',
    channel: 'https://www.youtube.com/@lestarfpv',
    handle: 'youtube.com/@lestarfpv',
  },
  {
    slot: '04',
    name: 'CrapShack',
    face: 'crapshack.jpg',
    channel: 'https://www.youtube.com/@Z_CrapShack',
    handle: 'youtube.com/@Z_CrapShack',
  },
];

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

function link(href, text) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/*
 * A project's official mark. A <span> and not a <div> because the mark
 * is the card's heading now, and a div inside an <h4> is not a document.
 *
 * A mark that spells the name is the label, so it takes role=img and the
 * name. A mark that sits beside the name in type is decorative, and
 * labelling it as well would have the card announce itself twice.
 */
function logo(src, alt, well, decorative) {
  const box = el('span', well === 'light' ? 'credit-logo light' : 'credit-logo');
  if (decorative) {
    box.setAttribute('aria-hidden', 'true');
  } else {
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', alt);
  }
  /*
   * Inline the SVG instead of <img src>. The local static server has no
   * MIME table for images unless it is restarted, and Chrome will not
   * paint an SVG <img> served as application/octet-stream. fetch() still
   * reads the bytes, and an inline <svg> does not care about the type.
   */
  fetch(src)
    .then((r) => {
      if (!r.ok) {
        throw new Error(String(r.status));
      }
      return r.text();
    })
    .then((text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
        throw new Error('bad svg');
      }
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('aria-hidden', 'true');
      box.append(svg);
    })
    .catch(() => {
      box.append(el('span', 'credit-logo-fallback', alt));
    });
  return box;
}

function initials(name) {
  const parts = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
  const letters = parts.length > 1
    ? parts.map((p) => p[0]).join('').slice(0, 2)
    : name.slice(0, 2);
  return letters.toUpperCase();
}

/*
 * A channel picture in a square plate. The name is already the heading
 * beside it, so the plate is decorative and stays out of the accessible
 * tree: a screen reader that reads the picture as well would announce
 * every pilot twice. A picture that fails to load falls back to the
 * initials plate, which is also what Jannes gets, so a missing file
 * never leaves a hole where a person should be.
 */
function face(src, name) {
  const box = el('span', 'credit-face');
  box.setAttribute('aria-hidden', 'true');
  if (!src) {
    box.classList.add('is-blank');
    box.append(el('span', 'credit-face-mark', initials(name)));
    return box;
  }
  const img = new Image(240, 240);
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.remove();
    box.classList.add('is-blank');
    box.append(el('span', 'credit-face-mark', initials(name)));
  });
  box.append(img);
  return box;
}

/* The small mono line that says where the link goes. The play triangle
   in front of it is drawn in CSS, so nothing here borrows a trademark to
   say the word video. */
function handleLine(text) {
  return el('span', 'credit-handle', text);
}

/*
 * A project card: the mark across the top, and copy under it.
 *
 * THE MARK IS THE HEADING. Betaflight's wordmark says Betaflight, so a
 * card that showed the wordmark and then wrote the name underneath said
 * it twice, which is what the roll used to do. The mark carries the
 * link and `alt` carries the accessible name, so a screen reader still
 * hears one title and a broken fetch still shows one, in the fallback.
 *
 * `wordmark: false` is for a mark that is a symbol rather than a name.
 * Claude's starburst is a lovely thing and it does not spell anything,
 * so that card gets the symbol and the word beside it. Three lines of
 * flag beats a heading that only some readers can read.
 *
 * WHY THIS CARD IS NOT A LINK THE WAY A PERSON CARD IS. Its copy
 * already carries two or three links of its own, and a hit target
 * stretched over the card would swallow every one of them.
 */
function projectCard({ src, alt, well, title, href, body, wordmark = true }) {
  const n = el('article', 'credit project');
  const h = el('h4', 'credit-title');
  const parts = [logo(src, alt || title, well, !wordmark)];
  if (!wordmark) {
    parts.push(el('span', 'credit-title-text', title));
  }
  if (href) {
    const a = link(href, null);
    a.append(...parts);
    h.append(a);
  } else {
    h.append(...parts);
  }
  n.append(h);
  const copy = el('div', 'credit-copy');
  if (typeof body === 'string') {
    copy.append(el('p', null, body));
  } else if (body) {
    copy.append(body);
  }
  n.append(copy);
  return n;
}

/*
 * A person card: face and slot number down the left, name and link down
 * the right, and the whole card is the hit target when there is a
 * channel to open. `nameNode` lets the maker keep the andAgainFPV
 * wordmark as its own heading instead of plain text, and `note` is the
 * maker's line about what was built. A pilot row passes neither.
 */
function personCard({ cls, src, slot, name, nameNode, note, channel, handle }) {
  const n = el('article', cls ? `credit person ${cls}` : 'credit person');
  const stack = el('div', 'credit-stack');
  stack.append(face(src, name));
  if (slot) {
    const num = el('span', 'credit-slot', slot);
    num.setAttribute('aria-hidden', 'true');
    stack.append(num);
  }
  n.append(stack);

  const copy = el('div', 'credit-copy');
  const h = el('h4', null, null);
  const label = nameNode || document.createTextNode(name);
  if (channel) {
    const a = link(channel, null);
    a.append(label);
    h.append(a);
    n.classList.add('is-link');
  } else {
    h.append(label);
  }
  copy.append(h);
  if (note) {
    copy.append(el('p', null, note));
  }
  if (handle) {
    copy.append(handleLine(handle));
  }
  n.append(copy);
  return n;
}

function section(kicker, heading) {
  const n = el('section', 'credit-block');
  const k = el('div', 'credit-kicker');
  k.append(el('span', null, kicker));
  n.append(k);
  if (heading) {
    n.append(el('h3', null, heading));
  }
  return n;
}

/**
 * Fill `host` with the credits roll. assetBase is the directory that
 * holds the marks and the faces, with no trailing slash.
 */
export function fillCredits(host, { assetBase = 'assets/credits' } = {}) {
  const src = (name) => new URL(`${assetBase}/${name}`, document.baseURI).href;
  host.textContent = '';

  const lede = el('p', 'credits-lede', str('credits.a_browser_fpv_racing_simulator_the'));
  host.append(lede);

  const made = section(str('credits.made_by'), '');
  const makerMark = el('span', 'maker-mark');
  makerMark.append(document.createTextNode(str('credits.andagain')), el('span', 'fpv', 'FPV'));
  made.append(personCard({
    cls: 'maker',
    src: src('andagain.jpg'),
    name: 'andAgainFPV',
    nameNode: makerMark,
    note: str('credits.built_this_simulator_the_track_builder'),
    channel: 'https://www.youtube.com/@andAgainFPV',
    handle: 'youtube.com/@andAgainFPV',
  }));
  host.append(made);

  const pilots = section(str('credits.beta_test_pilots'), str('credits.they_flew_it_until_it_felt'));
  const row = el('div', 'credit-row pilots');
  for (const p of PILOTS) {
    row.append(personCard({
      cls: 'pilot',
      src: p.face ? src(p.face) : null,
      slot: p.slot,
      name: p.name,
      channel: p.channel,
      handle: p.handle,
    }));
  }
  pilots.append(row);
  host.append(pilots);

  const controller = section(str('credits.the_controller'), '');
  const bfBody = el('p');
  bfBody.append(
    document.createTextNode(str('credits.the_rates_the_pid_loop_the')),
    link('https://github.com/betaflight/betaflight', 'Betaflight'),
    document.createTextNode(str('credits.is_gplv3_so_this_is_too')),
  );
  controller.append(projectCard({
    src: src('betaflight.svg'),
    alt: 'Betaflight',
    title: 'Betaflight',
    href: 'https://betaflight.com',
    body: bfBody,
  }));
  host.append(controller);

  const tracks = section(str('credits.the_track_language'), '');
  const tdBody = el('p');
  tdBody.append(
    document.createTextNode(str('credits.the_track_builder_is_inspired_by')),
    link('https://trackdraw.app/', str('credits.track_draw')),
    document.createTextNode(str('credits.from_the_dutch_drone_gods_at')),
    link('https://dutchdronesquad.nl/', str('credits.dutch_drone_squad')),
    document.createTextNode(str('credits.real_field_scale_real_obstacles_a')),
  );
  tracks.append(projectCard({
    src: src('trackdraw.svg'),
    alt: 'TrackDraw',
    title: str('credits.track_draw'),
    href: 'https://trackdraw.app/',
    body: tdBody,
  }));
  host.append(tracks);

  /*
   * The rooms themselves, by name, under the person who built each one.
   * A track is somebody's afternoon with a pipe cutter; the reconstruction
   * is not the design.
   */
  const rooms = section(str('credits.the_racegow5_rooms'), str('credits.eight_tracks_six_builders_read_off'));
  const roomList = el('div', 'credit-rooms');
  for (const r of RACEGOW) {
    const line = el('p', 'credit-room');
    line.append(el('b', null, r.designer));
    line.append(document.createTextNode(str('credits.text', { v1: r.tracks.join(', ') })));
    roomList.append(line);
  }
  const roomNote = el('p', 'credit-room-note');
  roomNote.append(document.createTextNode(str('credits.series_and_animations_by')));
  roomNote.append(link('https://racegow.com/tracks', 'RaceGOW'));
  roomNote.append(document.createTextNode(str('credits.brought_into_this_simulator_by_andagainfpv')));
  roomList.append(roomNote);
  rooms.append(roomList);
  host.append(rooms);

  const horde = section(str('credits.the_horde'), str('credits.written_with_grok_built_with_claude'));
  const ai = el('div', 'credit-row pair');
  const grokBody = el('p');
  grokBody.append(
    document.createTextNode(str('credits.xai_s_grok_a_lot_of')),
  );
  const claudeBody = el('p');
  claudeBody.append(
    document.createTextNode(str('credits.anthropic_s_claude_the_other_half')),
  );
  ai.append(
    projectCard({
      src: src('grok.svg'),
      alt: 'Grok',
      well: 'light',
      title: str('credits.grok'),
      href: 'https://grok.com',
      body: grokBody,
    }),
    projectCard({
      src: src('claude.svg'),
      alt: 'Claude',
      title: str('credits.claude'),
      wordmark: false,
      href: 'https://claude.ai',
      body: claudeBody,
    }),
  );
  horde.append(ai);
  host.append(horde);

  const legal = el('p', 'credits-legal');
  legal.append(
    document.createTextNode(str('credits.betaflight_track_draw_grok_claude_dutch')),
    link('https://www.gnu.org/licenses/gpl-3.0.html', 'GPLv3'),
    document.createTextNode('.'),
  );
  host.append(legal);
}
