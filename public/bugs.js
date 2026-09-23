/*
 * bugs.js: the human inbox for tester tickets.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 */

import { str } from './strings/index.js';

/* Static sentences in the markup carry data-str keys; filled here so the
 * page stays greppable and the copy lives in one table. */
for (const node of document.querySelectorAll('[data-str]')) {
  node.textContent = str(node.dataset.str);
}

const TOKEN_KEY = 'webfpv.bugs.token';

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

/*
 * Where this page lives. Same reason as app.js: the inbox is served at /bugs
 * on Render and at /board/bugs on fdfpv.example, and a fetch of '/api/bugs' from
 * the second one leaves the board's namespace. './' against the document's own
 * address is its directory, which is /board/ there and / here.
 */
const HERE = new URL('./', document.baseURI);

function here(path) {
  return new URL(path, HERE).href;
}

function token() {
  return document.getElementById('token').value.trim();
}

/*
 * THE SIGN IN FROM THE BOARD COUNTS HERE TOO.
 *
 * An admin of the board reads this inbox without a second secret: see
 * bugsAuthorized in src/server.js. This page and the board are the same
 * origin, so the token the Admin panel kept is already in this tab's
 * sessionStorage and there is nothing to pass between them.
 *
 * The typed token still wins when there is one, because somebody who has
 * gone to the trouble of pasting a token in the box means to use it.
 */
const ADMIN_KEY = 'webfpv.board.admin.v1';

function adminToken() {
  try {
    return sessionStorage.getItem(ADMIN_KEY) || '';
  } catch (e) {
    /* Private mode. The box is still there. */
    return '';
  }
}

function headers() {
  const t = token() || adminToken();
  const h = { 'content-type': 'application/json' };
  if (t) {
    h.authorization = str('bugs.bearer', { t });
  }
  return h;
}

async function readJson(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }
  if (!res.ok) {
    throw new Error((body && body.error) || text || str('app.the_board_answered', { status: res.status }));
  }
  return body;
}

function when(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return String(iso);
  }
  return d.toLocaleString();
}

const state = { bugs: [], current: null };

/*
 * A feel report is feedback, not a defect, and the inbox says so. Every
 * other kind reads as itself; only feel gets renamed, because "feel" on a
 * list row reads like a typo where "feedback" reads like what it is.
 */
function kindLabel(kind) {
  return kind === 'feel' ? 'feedback' : kind;
}

function paintList() {
  const host = document.getElementById('list');
  host.textContent = '';
  if (!state.bugs.length) {
    host.append(el('div', 'empty', str('bugs.no_tickets_in_this_filter')));
    return;
  }
  for (const b of state.bugs) {
    const row = el('button', state.current && state.current.id === b.id ? str('bugs.ticket_on') : 'ticket');
    row.type = 'button';
    row.append(el('div', 'id', b.id));
    row.append(el('div', 'title', b.title));
    const meta = el('div', 'meta');
    meta.append(el('span', b.kind === 'feel' ? 'kind feel' : 'kind', kindLabel(b.kind)));
    meta.append(document.createTextNode(str('bugs.text', { reporter: b.reporter, v2: b.map ? ` · ${b.map}` : '' })));
    row.append(meta);
    row.addEventListener('click', () => openTicket(b.id));
    host.append(row);
  }
}

function block(title, body) {
  const wrap = el('div', 'block');
  wrap.append(el('h3', null, title));
  const p = el('p');
  p.textContent = body || '(none)';
  wrap.append(p);
  return wrap;
}

function paintSheet() {
  const host = document.getElementById('sheet');
  host.textContent = '';
  const t = state.current;
  if (!t) {
    host.append(el('div', 'empty', str('bugs.pick_a_ticket')));
    return;
  }
  const badges = el('div', 'badges');
  badges.append(el('span', `badge ${t.status}`, t.status.replace('_', ' ')));
  badges.append(el('span', t.kind === 'feel' ? 'badge feel' : 'badge', kindLabel(t.kind)));
  if (t.map) {
    badges.append(el('span', 'badge', t.map));
  }
  host.append(el('div', 'kicker', t.id));
  host.append(el('h2', null, t.title));
  host.append(badges);
  host.append(el('p', 'meta', str('bugs.text_2', { reporter: t.reporter, when: when(t.submittedUtc) })));
  host.append(block(str('bugs.what_happened'), t.what));
  host.append(block('Expected', t.expected));
  host.append(block('Steps', t.steps));
  host.append(block('Resolution', t.resolution));
  const ctx = el('div', 'block');
  ctx.append(el('h3', null, str('bugs.context')));
  const pre = el('pre', 'ctx', JSON.stringify(t.context || {}, null, 2));
  ctx.append(pre);
  host.append(ctx);
  const resolution = document.createElement('textarea');
  resolution.placeholder = str('bugs.what_you_did_for_the_next');
  resolution.value = t.resolution || '';
  const actions = el('div', 'actions');
  const statuses = [
    ['in_progress', str('bugs.in_progress')],
    ['fixed', 'Fixed'],
    ['wontfix', str('bugs.won_t_fix')],
    ['duplicate', 'Duplicate'],
    ['open', 'Reopen'],
  ];
  for (const [id, label] of statuses) {
    const b = el('button', id === 'fixed' ? 'primary' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => saveTicket(id, resolution.value));
    actions.append(b);
  }
  host.append(el('h3', null, str('bugs.update')));
  host.append(resolution);
  host.append(actions);
}

async function loadList() {
  const err = document.getElementById('err');
  err.textContent = '';
  const status = document.getElementById('status').value;
  const kind = document.getElementById('kind').value;
  try {
    const qs = new URLSearchParams();
    if (status) {
      qs.set('status', status);
    }
    if (kind) {
      qs.set('kind', kind);
    }
    const res = await fetch(here(`api/bugs?${qs.toString()}`), { headers: headers() });
    const body = await readJson(res);
    state.bugs = body.bugs || [];
    if (state.current && !state.bugs.some((b) => b.id === state.current.id)) {
      state.current = null;
    }
    paintList();
    paintSheet();
  } catch (e) {
    err.textContent = e.message || String(e);
    state.bugs = [];
    paintList();
  }
}

async function openTicket(id) {
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const res = await fetch(here(`api/bugs/${encodeURIComponent(id)}`), { headers: headers() });
    state.current = await readJson(res);
    paintList();
    paintSheet();
  } catch (e) {
    err.textContent = e.message || String(e);
  }
}

async function saveTicket(status, resolution) {
  const err = document.getElementById('err');
  err.textContent = '';
  if (!state.current) {
    return;
  }
  try {
    const res = await fetch(here(`api/bugs/${encodeURIComponent(state.current.id)}`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ status, resolution }),
    });
    state.current = await readJson(res);
    await loadList();
    paintSheet();
  } catch (e) {
    err.textContent = e.message || String(e);
  }
}

function restoreToken() {
  try {
    const stored = sessionStorage.getItem(TOKEN_KEY) || '';
    if (stored) {
      document.getElementById('token').value = stored;
    }
  } catch (e) {
    /* Private mode. */
  }
}

function rememberToken() {
  try {
    const value = token();
    if (value) {
      sessionStorage.setItem(TOKEN_KEY, value);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) {
    /* Private mode. */
  }
}

restoreToken();
document.getElementById('reload').addEventListener('click', () => {
  rememberToken();
  loadList();
});
document.getElementById('status').addEventListener('change', () => {
  rememberToken();
  loadList();
});
document.getElementById('kind').addEventListener('change', () => {
  rememberToken();
  loadList();
});
document.getElementById('token').addEventListener('change', rememberToken);
loadList();
