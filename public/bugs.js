/*
 * bugs.js: the inbox where a person reads tester tickets and marks them.
 *
 * Agents use the JSON API; this is the same store for a human. The page
 * is served at /bugs on a board of its own and at /board/bugs on the VM,
 * so every request is resolved against the page's own directory, never
 * the site root.
 *
 * A board admin who signed in on the board page reads the inbox without a
 * second secret (bugsAuthorized in src/server.js): the two pages share an
 * origin, so the sign in is already in this tab's sessionStorage. A token
 * typed into the box wins, because whoever pasted it means to use it.
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
import { ADMIN_TOKEN_KEY, BUGS_TOKEN_KEY, moveRenamedKeys } from './keys.js';

moveRenamedKeys(() => sessionStorage);

/* The markup's fixed sentences carry data-str keys; the copy lives in the
 * string table. */
for (const holder of document.querySelectorAll('[data-str]')) {
  holder.textContent = str(holder.dataset.str);
}

const $ = (id) => document.getElementById(id);
const pageDir = new URL('./', document.baseURI);
const api = (path) => new URL(path, pageDir).href;

/* An element with an optional class and children (nodes or text). */
function make(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  n.append(...children);
  return n;
}

/* sessionStorage, which a private window may refuse; then there is simply
 * nothing kept and the box still works. */
const session = {
  get(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },
  put(key, value) {
    try {
      if (value) {
        sessionStorage.setItem(key, value);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch {
      /* Refused; nothing to keep. */
    }
  },
};

const typedToken = () => $('token').value.trim();

function requestHeaders() {
  const token = typedToken() || session.get(ADMIN_TOKEN_KEY);
  return token
    ? { 'content-type': 'application/json', authorization: str('bugs.bearer', { t: token }) }
    : { 'content-type': 'application/json' };
}

/* The JSON body, or an Error carrying the board's own sentence. */
async function answerOf(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body?.error || text || str('app.the_board_answered', { status: response.status }));
  }
  return body;
}

async function call(path, init = {}) {
  return answerOf(await fetch(api(path), { ...init, headers: requestHeaders() }));
}

function localTime(iso) {
  if (!iso) {
    return '';
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? String(iso) : at.toLocaleString();
}

/* Flight feel reports are filed with kind `feel` and read as feedback. */
const kindName = (kind) => (kind === 'feel' ? 'feedback' : kind);

const inbox = { tickets: [], open: null };

function showError(err) {
  $('err').textContent = err ? err.message || String(err) : '';
}

function drawList() {
  const list = $('list');
  list.textContent = '';
  if (inbox.tickets.length === 0) {
    list.append(make('div', 'empty', str('bugs.no_tickets_in_this_filter')));
    return;
  }
  for (const t of inbox.tickets) {
    const row = make('button', 'ticket',
      make('div', 'id', t.id),
      make('div', 'title', t.title),
      make('div', 'meta',
        make('span', t.kind === 'feel' ? 'kind feel' : 'kind', kindName(t.kind)),
        str('bugs.text', { reporter: t.reporter, v2: t.map ? ` · ${t.map}` : '' })));
    row.type = 'button';
    /* A class name, not copy: it once came from the string table and the
     * Spanish table spelled it "ticket en", which no rule matches. */
    row.classList.toggle('on', inbox.open?.id === t.id);
    row.addEventListener('click', () => openTicket(t.id));
    list.append(row);
  }
}

function section(title, text) {
  const p = make('p');
  p.textContent = text || '(none)';
  return make('div', 'block', make('h3', null, title), p);
}

/*
 * Screenshots come with the bearer header, which a bare <img src> cannot
 * send, so each is fetched and shown from a blob URL. The URLs are freed
 * when the sheet is redrawn.
 */
let blobUrls = [];

function freeBlobs() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}

function screenshot(t, img) {
  const label = str('bugs.image_n', { n: img.n });
  const link = make('a', 'shot', make('span', 'shot-label', label));
  link.target = '_blank';
  link.title = label;
  fetch(api(`api/bugs/${encodeURIComponent(t.id)}/images/${img.n}`), { headers: requestHeaders() })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(str('app.the_board_answered', { status: res.status })))))
    .then((blob) => {
      if (inbox.open !== t) {
        return;
      }
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      link.href = url;
      const pic = document.createElement('img');
      pic.src = url;
      pic.alt = label;
      link.prepend(pic);
    })
    .catch((err) => link.append(make('span', 'shot-err', err.message || String(err))));
  return link;
}

const NEXT_STATUSES = () => [
  ['in_progress', str('bugs.in_progress')],
  ['fixed', 'Fixed'],
  ['wontfix', str('bugs.won_t_fix')],
  ['duplicate', 'Duplicate'],
  ['open', 'Reopen'],
];

function drawSheet() {
  const sheet = $('sheet');
  sheet.textContent = '';
  freeBlobs();
  const t = inbox.open;
  if (!t) {
    sheet.append(make('div', 'empty', str('bugs.pick_a_ticket')));
    return;
  }
  const badges = make('div', 'badges',
    make('span', `badge ${t.status}`, t.status.replace('_', ' ')),
    make('span', t.kind === 'feel' ? 'badge feel' : 'badge', kindName(t.kind)));
  if (t.map) {
    badges.append(make('span', 'badge', t.map));
  }
  sheet.append(
    make('div', 'kicker', t.id),
    make('h2', null, t.title),
    badges,
    make('p', 'meta', str('bugs.text_2', { reporter: t.reporter, when: localTime(t.submittedUtc) })),
    section(str('bugs.what_happened'), t.what),
    section('Expected', t.expected),
    section('Steps', t.steps),
    section('Resolution', t.resolution),
  );
  if (t.images?.length) {
    sheet.append(make('div', 'block', make('h3', null, str('bugs.images')),
      make('div', 'shots', ...t.images.map((img) => screenshot(t, img)))));
  }
  sheet.append(make('div', 'block', make('h3', null, str('bugs.context')),
    make('pre', 'ctx', JSON.stringify(t.context || {}, null, 2))));
  const note = document.createElement('textarea');
  note.placeholder = str('bugs.what_you_did_for_the_next');
  note.value = t.resolution || '';
  const actions = make('div', 'actions');
  for (const [status, label] of NEXT_STATUSES()) {
    const button = make('button', status === 'fixed' ? 'primary' : '', label);
    button.type = 'button';
    button.addEventListener('click', () => mark(status, note.value));
    actions.append(button);
  }
  sheet.append(make('h3', null, str('bugs.update')), note, actions);
}

async function loadList() {
  showError(null);
  const query = new URLSearchParams();
  for (const id of ['status', 'kind']) {
    if ($(id).value) {
      query.set(id, $(id).value);
    }
  }
  try {
    inbox.tickets = (await call(`api/bugs?${query}`)).bugs || [];
    if (inbox.open && !inbox.tickets.some((t) => t.id === inbox.open.id)) {
      inbox.open = null;
    }
    drawList();
    drawSheet();
  } catch (err) {
    showError(err);
    inbox.tickets = [];
    drawList();
  }
}

async function openTicket(id) {
  showError(null);
  try {
    inbox.open = await call(`api/bugs/${encodeURIComponent(id)}`);
    drawList();
    drawSheet();
  } catch (err) {
    showError(err);
  }
}

async function mark(status, resolution) {
  showError(null);
  if (!inbox.open) {
    return;
  }
  try {
    inbox.open = await call(`api/bugs/${encodeURIComponent(inbox.open.id)}`, {
      method: 'POST',
      body: JSON.stringify({ status, resolution }),
    });
    await loadList();
    drawSheet();
  } catch (err) {
    showError(err);
  }
}

const keepToken = () => session.put(BUGS_TOKEN_KEY, typedToken());

const kept = session.get(BUGS_TOKEN_KEY);
if (kept) {
  $('token').value = kept;
}
$('reload').addEventListener('click', () => {
  keepToken();
  loadList();
});
for (const id of ['status', 'kind']) {
  $(id).addEventListener('change', () => {
    keepToken();
    loadList();
  });
}
$('token').addEventListener('change', keepToken);
loadList();
