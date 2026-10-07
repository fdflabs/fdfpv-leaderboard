/*
 * credits.js: the credits roll, built as DOM so the simulator's overlay
 * and this board can share it. The live roll is the simulator's #credits
 * page; this is the board's copy of it.
 *
 * A pilot's card holds a name, a slot and a link, and nothing written
 * about the person: none of them is here to be asked, and spelling the
 * name right and linking the right channel is worth more than any line.
 * A person card is one click target, made by stretching the heading's
 * link over the card, so the link's accessible name stays the person's
 * name. A project card is not, because its copy carries links of its own.
 *
 * The marks in credits/ are the projects' official ones and the faces are
 * the channels' own pictures; both are here only to name the work.
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

/*
 * The eight RaceGOW5 rooms by the people who designed them (one person
 * brought them all over; the reconstruction is not the design). These are
 * the `credit.designer` fields of the simulator's presets, which its
 * scripts/micro-check.js holds this list to.
 */
export const RACEGOW_CREDITS = [
  { designer: 'AyyyKayyy', tracks: [str('credits.track_8')] },
  { designer: str('credits.cumber_and_hotspur'), tracks: [str('credits.track_5')] },
  { designer: 'Skittles', tracks: [str('credits.track_1'), str('credits.track_2')] },
  { designer: str('credits.the_lego_dans'), tracks: [str('credits.track_3'), str('credits.track_4')] },
  { designer: 'MrE', tracks: [str('credits.track_6')] },
  { designer: 'FPVBean', tracks: [str('credits.track_7')] },
];

/* The beta roll, in the order they turned up, which is not a ranking.
 * Jannes has no channel and gets initials where a face would be, with the
 * same weight: this records who flew it, not who posts about it. */
const BETA_PILOTS = [
  ['01', 'Asylum', 'asylum.jpg', '@AsylumFpv'],
  ['02', 'Jannes', null, null],
  ['03', 'LeStar', 'lestar.jpg', '@lestarfpv'],
  ['04', 'CrapShack', 'crapshack.jpg', '@Z_CrapShack'],
];

/* An element: `cls` may be null, children are nodes or strings. */
function node(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  n.append(...children.filter((c) => c != null));
  return n;
}

function outLink(href, ...children) {
  const a = node('a', null, ...children);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/* Two letters for a face plate: one per word where the name has several
 * (CamelCase counts as words), else the name's first two. */
function initialsOf(name) {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
  const letters = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 2) : name.slice(0, 2);
  return letters.toUpperCase();
}

/*
 * A project's mark. It is fetched and inlined rather than used as <img>,
 * because a local static server without an image MIME table serves SVG as
 * octet-stream and Chrome will not paint that in an <img>. A mark that
 * spells the name is the heading's label; one that does not is decorative.
 */
function mark(url, name, light, decorative) {
  const box = node('span', light ? 'credit-logo light' : 'credit-logo');
  if (decorative) {
    box.setAttribute('aria-hidden', 'true');
  } else {
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', name);
  }
  const fallback = () => box.append(node('span', 'credit-logo-fallback', name));
  fetch(url)
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then((text) => {
      const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = parsed.documentElement;
      if (svg?.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
        throw new Error('not an svg');
      }
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('aria-hidden', 'true');
      box.append(svg);
    })
    .catch(fallback);
  return box;
}

/* A face plate, decorative because the name beside it is the heading. A
 * missing or broken picture becomes the initials plate. */
function facePlate(url, name) {
  const box = node('span', 'credit-face');
  box.setAttribute('aria-hidden', 'true');
  const blank = () => {
    box.classList.add('is-blank');
    box.append(node('span', 'credit-face-mark', initialsOf(name)));
  };
  if (!url) {
    blank();
    return box;
  }
  const img = new Image(240, 240);
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.remove();
    blank();
  });
  box.append(img);
  return box;
}

/* A project: its mark is the heading (and the link), copy underneath. A
 * mark that is a symbol rather than a name gets the name in type too. */
function projectCard({ url, name, light = false, title, href, copy, spells = true }) {
  const heading = [mark(url, name, light, !spells)];
  if (!spells) {
    heading.push(node('span', 'credit-title-text', title));
  }
  return node('article', 'credit project',
    node('h4', 'credit-title', ...(href ? [outLink(href, ...heading)] : heading)),
    node('div', 'credit-copy', copy));
}

/* A person: face and slot on the left, name and handle on the right,
 * the whole card a link when there is a channel. */
function personCard({ kind, face, slot, name, channel, handle }) {
  const card = node('article', `credit person ${kind}`);
  const slotTag = slot ? node('span', 'credit-slot', slot) : null;
  slotTag?.setAttribute('aria-hidden', 'true');
  card.append(node('div', 'credit-stack', facePlate(face, name), slotTag));
  const title = document.createTextNode(name);
  if (channel) {
    card.classList.add('is-link');
  }
  card.append(node('div', 'credit-copy',
    node('h4', null, channel ? outLink(channel, title) : title),
    handle ? node('span', 'credit-handle', handle) : null));
  return card;
}

function block(kicker, heading, ...content) {
  return node('section', 'credit-block',
    node('div', 'credit-kicker', node('span', null, kicker)),
    heading ? node('h3', null, heading) : null,
    ...content);
}

/* A paragraph of string-table text with links between the pieces. */
function para(...pieces) {
  return node('p', null, ...pieces);
}

/**
 * Fill `host` with the roll. `assetBase` is the directory holding the marks
 * and faces, without a trailing slash.
 */
export function fillCredits(host, { assetBase = 'assets/credits' } = {}) {
  const asset = (file) => new URL(`${assetBase}/${file}`, document.baseURI).href;
  const youtube = (handle) => `https://www.youtube.com/${handle}`;
  host.textContent = '';

  host.append(
    node('p', 'credits-lede', str('credits.fdfpv_by'), outLink('https://fdflabs.com', 'fdflabs.com')),
    node('p', 'credits-lede', str('credits.a_browser_fpv_racing_simulator_the')),
  );

  host.append(block(str('credits.beta_test_pilots'), str('credits.they_flew_it_until_it_felt'),
    node('div', 'credit-row pilots', ...BETA_PILOTS.map(([slot, name, face, handle]) => personCard({
      kind: 'pilot',
      face: face ? asset(face) : null,
      slot,
      name,
      channel: handle ? youtube(handle) : null,
      handle: handle ? `youtube.com/${handle}` : null,
    })))));

  host.append(block(str('credits.the_controller'), '', projectCard({
    url: asset('betaflight.svg'),
    name: 'Betaflight',
    title: 'Betaflight',
    href: 'https://betaflight.com',
    copy: para(str('credits.the_rates_the_pid_loop_the'),
      outLink('https://github.com/betaflight/betaflight', 'Betaflight'), str('credits.is_gplv3_so_this_is_too')),
  })));

  host.append(block(str('credits.the_track_language'), '', projectCard({
    url: asset('trackdraw.svg'),
    name: 'TrackDraw',
    title: str('credits.track_draw'),
    href: 'https://trackdraw.app/',
    copy: para(str('credits.the_track_builder_is_inspired_by'),
      outLink('https://trackdraw.app/', str('credits.track_draw')), str('credits.from_the_dutch_drone_gods_at'),
      outLink('https://dutchdronesquad.nl/', str('credits.dutch_drone_squad')), str('credits.real_field_scale_real_obstacles_a')),
  })));

  const rooms = RACEGOW_CREDITS.map((r) => node('p', 'credit-room',
    node('b', null, r.designer), str('credits.text', { v1: r.tracks.join(', ') })));
  host.append(block(str('credits.the_racegow5_rooms'), str('credits.eight_tracks_six_builders_read_off'),
    node('div', 'credit-rooms', ...rooms, node('p', 'credit-room-note', str('credits.series_and_animations_by'),
      outLink('https://racegow.com/tracks', 'RaceGOW'), '.'))));

  host.append(block(str('credits.the_horde'), str('credits.written_with_grok_built_with_claude'),
    node('div', 'credit-row pair',
      projectCard({
        url: asset('grok.svg'), name: 'Grok', light: true, title: str('credits.grok'), href: 'https://grok.com',
        copy: para(str('credits.xai_s_grok_a_lot_of')),
      }),
      projectCard({
        url: asset('claude.svg'), name: 'Claude', title: str('credits.claude'), spells: false, href: 'https://claude.ai',
        copy: para(str('credits.anthropic_s_claude_the_other_half')),
      }))));

  host.append(node('p', 'credits-legal', str('credits.betaflight_track_draw_grok_claude_dutch'),
    outLink('https://www.gnu.org/licenses/gpl-3.0.html', 'GPLv3'), '.'));
}
