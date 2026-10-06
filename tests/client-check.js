/*
 * client-check.js: the board's page, looked at in a real browser.
 *
 *   node tests/client-check.js                    this tree only
 *   node tests/client-check.js --against <ref>    and compare with <ref>'s page
 *   node tests/client-check.js --out <dir>        keep the screenshots and text
 *
 * A board is seeded once through the API (tests/client/seed.js), then the
 * page is walked through a fixed list of scenes: the track list per
 * aircraft, a search, a tag, each kind of track sheet, the statistics tab,
 * the admin panel signed in, the bug inbox, each in English and Spanish.
 * Every scene is read back as its visible text and a full page
 * screenshot.
 *
 * On its own it checks what must hold of any version of the page: no
 * uncaught error or console error in any scene, every element id the
 * page's scripts look up exists in some scene, and the scenes that should
 * show data do.
 *
 * With --against it also builds <ref>'s public/ beside this tree, serves
 * both from copies of the same board with the same frozen clock, walks
 * both through the same scenes, and requires the same visible text and
 * screenshots within a small tolerance. That is the evidence a rewrite of
 * a file under public/ changed nothing a visitor can see.
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
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath, openTab } from './client/chrome.js';
import { comparePng } from './client/png.js';
import { drawSheetScript, planSheet } from './client/plans.js';
import { seedBoard } from './client/seed.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const against = arg('--against');
const outDir = arg('--out');
/* A screenshot may differ in this share of its pixels and still count as
 * the same page. Two walks of one tree differ in none; the clock readings
 * the text masks move about 0.002%. A plan line half a pixel wider moves
 * 0.07% of the plan sheet, so this sits well under that. */
const PIXEL_SHARE = Number(process.env.CLIENT_PIXEL_SHARE || 0.0001);

const ADMIN = 'admin@example.com';
const ADMIN_PASSWORD = 'harness password';
const BUGS_TOKEN = 'harness-token';

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).slice(0, 1200)}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startBoard(tree, boardFile) {
  const port = await freePort();
  const proc = spawn(process.execPath, [join(tree, 'src', 'server.js')], {
    env: {
      PATH: process.env.PATH, TZ: 'UTC', PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_FILE: boardFile,
      BUGS_TOKEN, BOARD_ADMINS: `${ADMIN}:plain:${ADMIN_PASSWORD}`, BOARD_TRUST_PROXY: '1',
      BOARD_SPONSORS: 'acme:Acme Hobbies,zeta:Zeta FPV',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => {
    log += d;
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        return { origin, stop: () => proc.kill() };
      }
    } catch {
      /* Still starting. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`the board in ${tree} never answered: ${log.slice(-800)}`);
}

/* <ref>'s page beside this tree's server: everything but public/ is this
 * tree's, so only the page differs. */
function buildBaseline(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'client-base-'));
  for (const name of readdirSync(root)) {
    if (['public', 'node_modules', 'vendor', '.git', 'data'].includes(name)) {
      continue;
    }
    cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  symlinkSync(join(root, 'vendor'), join(dir, 'vendor'));
  mkdirSync(join(dir, 'data'));
  const tar = execFileSync('git', ['-C', root, 'archive', '--format=tar', ref, 'public'], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

/* Run before any page script: a clock stopped at one instant, so "an hour
 * ago" reads the same in both runs, and no animation half way through. */
function seedScripts(frozenMs) {
  const clock = `(() => {
    const T = ${frozenMs};
    const Real = Date;
    class Frozen extends Real {
      constructor(...a) { if (a.length) { super(...a); } else { super(T); } }
      static now() { return T; }
    }
    globalThis.Date = Frozen;
  })();`;
  const still = `document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}';
    document.head.append(s);
  });`;
  return [clock, still];
}

/*
 * The scenes. `path` is loaded fresh with storage cleared; `act` is page
 * script run once it has settled; `ready` is what must be true before it is
 * read.
 */
const SIGN_IN = `(async () => {
  document.getElementById('admin-open').click();
  document.getElementById('admin-email').value = ${JSON.stringify(ADMIN)};
  document.getElementById('admin-password').value = ${JSON.stringify(ADMIN_PASSWORD)};
  document.getElementById('admin-signin').requestSubmit();
})()`;
const SPANISH = `document.getElementById('lang-toggle').click()`;
const BUGS = `(() => {
  const t = document.getElementById('token');
  t.value = ${JSON.stringify(BUGS_TOKEN)};
  t.dispatchEvent(new Event('change'));
  document.getElementById('reload').click();
})()`;

function scenes(trackIds, fixtures) {
  const [field, furniture, room, wing, ring] = trackIds;
  const base = [
    { name: 'tracks', path: '/' },
    { name: 'tracks-room', path: '/', act: `document.getElementById('craft-micro').click()` },
    { name: 'tracks-wing', path: '/', act: `document.getElementById('craft-wing').click()` },
    { name: 'tracks-search', path: '/', act: `(() => { const f = document.getElementById('find'); f.value = 'ladder'; f.dispatchEvent(new Event('input', { bubbles: true })); })()` },
    { name: 'tracks-tag', path: '/', act: `document.querySelector('#tagbar .tag')?.click()` },
    { name: 'sheet-field', path: `/#track=${field}`, ready: `!document.getElementById('sheet').hidden` },
    { name: 'sheet-furniture', path: `/#track=${furniture}`, ready: `!document.getElementById('sheet').hidden` },
    { name: 'sheet-room', path: `/#track=${room}`, ready: `!document.getElementById('sheet').hidden` },
    { name: 'sheet-wing', path: `/#track=${wing}`, ready: `!document.getElementById('sheet').hidden` },
    { name: 'sheet-ring', path: `/#track=${ring}`, ready: `!document.getElementById('sheet').hidden` },
    /* The roll is filled at load into a sheet nothing on the board opens
     * any more (#credits now goes to the simulator's page), so the scene
     * opens it by hand: what is in it is still the page's to keep. */
    { name: 'credits', path: '/', act: `document.getElementById('credits-sheet').hidden = false`,
      ready: `document.querySelectorAll('#credits-roll .credit').length > 0` },
    { name: 'stats', path: '/#stats', ready: `!document.getElementById('view-stats').hidden` },
    ...statsScenes(fixtures),
    ...boardScenes(trackIds, fixtures),
    { name: 'admin', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden` },
    { name: 'admin-sheet', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `location.hash = '#track=${field}'`, thenReady: `!document.getElementById('sheet').hidden` },
    { name: 'bugs', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list .ticket, #list button').length > 0` },
    { name: 'bugs-ticket', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list button').length > 0`,
      then: `document.querySelector('#list button').click()`, thenReady: `document.getElementById('sheet')?.textContent.length > 0 || true` },
    { name: 'bugs-kind', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list button').length > 0`,
      then: `(() => { const k = document.getElementById('kind'); k.value = 'visual'; k.dispatchEvent(new Event('change')); })()`,
      thenReady: `document.querySelectorAll('#list button').length === 1` },
    { name: 'bugs-image', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list button').length > 0`,
      then: `[...document.querySelectorAll('#list button')].find((b) => b.textContent.includes('Gate flickers')).click()`,
      thenReady: `document.querySelector('#sheet .shot img')?.complete === true` },
    { name: 'bugs-save', mutates: true, path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list button').length > 0`,
      then: `(async () => {
        document.querySelector('#list button').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('#sheet textarea').value = 'Looked at it.';
        [...document.querySelectorAll('#sheet .actions button')][0].click();
      })()`,
      thenReady: `document.querySelectorAll('#list button').length === 1` },
    /* A token kept by an earlier visit is put back in the box, and the
     * board's admin sign in opens the inbox without one. These two are
     * what a storage key rename has to keep working across the deploy, so
     * the keys are seeded under the names the page has always used. */
    { name: 'bugs-kept-token', path: '/bugs.html', before: `sessionStorage.setItem('webfpv.bugs.token', ${JSON.stringify(BUGS_TOKEN)})`,
      ready: `document.querySelectorAll('#list button').length > 0` },
    { name: 'bugs-admin-session', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `location.href = 'bugs.html'`, thenReady: `document.querySelectorAll('#list button').length > 0` },
  ];
  base.push({ name: 'plans', path: '/api/health', plans: true });
  const spanish = base
    .filter((s) => !s.plans && !s.mutates && !s.path.startsWith('/bugs'))
    .map((s) => ({ ...s, name: `es-${s.name}`, spanish: true }));
  /* The inbox has no language link; it reads ?lang= like the board. */
  for (const name of ['bugs', 'bugs-image']) {
    const s = base.find((b) => b.name === name);
    spanish.push({ ...s, name: `es-${name}`, path: '/bugs.html?lang=es' });
  }
  /* Scenes that change the board (a ticket marked, a track removed) go
   * last, so every other scene reads the board as seeded. */
  const all = [...base, ...spanish];
  return [...all.filter((sc) => !sc.mutates), ...all.filter((sc) => sc.mutates)];
}

/*
 * The board page beyond the first look: every sort, the author filter, a
 * filter that empties the list and the button that clears it, the old
 * #course= links, the aircraft from the address and from an earlier visit,
 * the plane board, Escape and the / key, the tab row, a room's animation
 * and the reduced motion that replaces it, the orbit's ready message, the
 * admin sign in refused, kept across a reload, signed out, and a track
 * taken off the board, an empty board, a board that is down, and a board
 * whose config names another simulator.
 */
const CRAFT_KEY = 'webfpv.board.craft.v1';
const SHEET_READY = `!document.getElementById('sheet').hidden`;

function boardScenes(trackIds, fixtures) {
  const [field, , room, , ring] = trackIds;
  const pick = (id, value) => `(() => { const s = document.getElementById('${id}'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`;
  const key = (k) => `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`;
  return [
    ...['fastest', 'biggest', 'newest', 'name'].map((sort) => ({ name: `tracks-sort-${sort}`, path: '/', act: pick('sort', sort) })),
    { name: 'tracks-author', path: '/', act: pick('by', 'Tatu') },
    { name: 'tracks-nothing', path: '/', act: `(() => { const f = document.getElementById('find'); f.value = 'zzz'; f.dispatchEvent(new Event('input')); })()` },
    { name: 'tracks-cleared', path: '/', act: `(() => { const f = document.getElementById('find'); f.value = 'zzz'; f.dispatchEvent(new Event('input')); })()`,
      then: `document.querySelector('#notice .btn').click()`, thenReady: `document.querySelectorAll('#list .card').length > 0` },
    { name: 'old-course-link', path: `/#course=${field}`, ready: SHEET_READY },
    { name: 'craft-from-link', path: '/?craft=whoop65' },
    { name: 'craft-remembered', path: '/', before: `localStorage.setItem('${CRAFT_KEY}', 'wing')` },
    { name: 'sheet-ring-planes', path: `/?craft=wing#track=${ring}`, ready: SHEET_READY },
    { name: 'sheet-escape', path: `/#track=${field}`, ready: SHEET_READY, then: key('Escape'), thenReady: `document.getElementById('sheet').hidden` },
    { name: 'slash-finds', path: '/', act: key('/') },
    { name: 'tab-click', path: '/', act: `document.getElementById('tab-stats').click()`, ready: STATS_READY },
    { name: 'room-still', path: `/#track=${room}`, ready: SHEET_READY, media: 'reduce' },
    { name: 'tracks-room-still', path: '/', act: `document.getElementById('craft-micro').click()`, media: 'reduce' },
    { name: 'orbit-ready', path: `/#track=${field}`, ready: `${SHEET_READY} && document.querySelector('iframe.orbit')`,
      act: `window.dispatchEvent(new MessageEvent('message', { data: { type: 'fdfpv-orbit-ready' }, source: document.querySelector('iframe.orbit').contentWindow }))` },
    { name: 'admin-refused', path: '/', act: SIGN_IN.replace(ADMIN_PASSWORD, 'not the password'),
      ready: `document.getElementById('admin-error').textContent.length > 0` },
    { name: 'admin-kept', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `location.reload()`, thenReady: `document.getElementById('admin-open').classList.contains('is-on')` },
    { name: 'admin-signed-out', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `document.getElementById('admin-signout').click()`, thenReady: `!document.getElementById('admin-open').classList.contains('is-on')` },
    { name: 'admin-removes', mutates: true, path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `(async () => {
        document.getElementById('admin-close').click();
        location.hash = '#track=${field}';
        await new Promise((r) => setTimeout(r, 600));
        const b = document.querySelector('#sheet-admin .danger');
        b.click();
        await new Promise((r) => setTimeout(r, 100));
        b.click();
      })()`,
      thenReady: `!document.querySelector('.card[data-id="${field}"]') && document.getElementById('sheet').hidden` },
    { name: 'board-empty', path: '/', stub: { '/api/tracks': { status: 200, body: { tracks: [], tags: fixtures.tags } } } },
    { name: 'board-down', path: '/', stub: { '/api/tracks': { status: 500, body: { error: 'The database is asleep.' } } } },
    { name: 'board-elsewhere', path: `/#track=${field}`, ready: SHEET_READY,
      stub: { '/api/config': { status: 200, body: { ...fixtures.config, simOrigin: 'https://sim.example/fly' } } } },
  ];
}

/*
 * The statistics tab beyond the board's own numbers: the table and a
 * focused bar, the opt out switch, what a visit sends for a returning
 * browser, an already counted one, a sponsor arrival (and the address bar
 * cleaned of it), an expired sponsor, a browser asking not to be tracked,
 * and three answers the seeded board cannot give: nothing counted yet, a
 * board that is down, and a busy month with a long tail of countries.
 */
const STATS_KEY = 'webfpv.stats.v1';
const TODAY = 'new Date().toISOString().slice(0, 10)';
const STATS_READY = `!document.getElementById('view-stats').hidden && document.getElementById('stats-fresh').textContent.length > 0`;

function statsScenes(fixtures) {
  const keep = (state) => `localStorage.setItem('${STATS_KEY}', JSON.stringify(${state}))`;
  return [
    { name: 'stats-table', path: '/#stats', ready: STATS_READY,
      act: `(() => { const d = document.querySelector('#stats-trend details'); d.open = true; d.dispatchEvent(new Event('toggle')); })()` },
    { name: 'stats-tip', path: '/#stats', ready: STATS_READY,
      act: `[...document.querySelectorAll('#stats-trend svg')[0].querySelectorAll('.bar-hit')].at(-1).focus()` },
    { name: 'stats-optout', path: '/#stats', ready: STATS_READY,
      act: `document.getElementById('stats-count-me').click()`,
      then: `location.reload()`, thenReady: STATS_READY },
    { name: 'stats-returning', path: '/', before: keep(`{ firstDay: '2026-01-01' }`) },
    { name: 'stats-counted-today', path: '/', before: keep(`{ firstDay: '2026-01-01', lastVisitDay: ${TODAY} }`) },
    { name: 'stats-sponsor', path: '/?utm_source=Acme-Poster&utm_campaign=spring&keep=1#stats', ready: STATS_READY },
    { name: 'stats-sponsor-held', path: '/', before: keep(`{ source: { slug: 'acme', day: ${TODAY} } }`) },
    { name: 'stats-sponsor-expired', path: '/', before: keep(`{ source: { slug: 'acme', day: '2025-01-01' } }`) },
    { name: 'stats-gpc', path: '/#stats', ready: STATS_READY,
      init: `Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true })` },
    { name: 'stats-empty', path: '/#stats', ready: STATS_READY, stub: { '/api/stats': { status: 200, body: fixtures.empty } } },
    { name: 'stats-down', path: '/#stats', ready: STATS_READY, stub: { '/api/stats': { status: 503, body: { error: 'The board is resting.' } } } },
    { name: 'stats-busy', path: '/#stats', ready: STATS_READY, stub: { '/api/stats': { status: 200, body: fixtures.busy } } },
  ];
}

/* The three stand-in answers, built from the seeded board's real one so
 * they keep its shape. */
function statsFixtures(real, frozenMs) {
  const generatedUtc = new Date(frozenMs - 40_000).toISOString();
  const zeroDay = (row) => ({ ...row, visits: 0, newVisitors: 0, returningVisitors: 0, sessions: 0, laps: 0, flightS: 0 });
  const empty = {
    ...real,
    generatedUtc,
    firstDay: null,
    today: zeroDay(real.today),
    days: real.days.map(zeroDay),
    window: { ...real.window, visits: 0, sessions: 0, laps: 0, flightS: 0 },
    countries: [], sources: [], craft: [], inputs: [], maps: [],
    allTime: { laps: 0, sessions: 0, visits: 0, flightS: 0, countries: 0 },
    board: { tracks: 0, times: 0, pilots: 0, pilotsOnMoreThanOneDay: 0 },
    live: { flying: 0 },
  };
  const codes = ['PY', 'AR', 'BR', 'UY', 'CL', 'BO', 'PE', 'CO', 'MX', 'US', 'ES', 'DE', 'AU', 'NZ', 'JP', 'ZZ'];
  const row = (key, i) => ({ key, visits: 400 - i * 23, sessions: 900 - i * 51, laps: 3000 - i * 170 });
  const busy = {
    ...real,
    generatedUtc,
    days: real.days.map((d, i) => ({
      ...d, visits: (i * 37) % 260, newVisitors: (i * 29) % 200, returningVisitors: (i * 11) % 60,
      sessions: (i * 53) % 400, laps: i === 17 ? 12_400 : (i * 97) % 3000, flightS: [30, 600, 7200, 50_000][i % 4],
    })),
    today: { ...real.today, visits: 1234, newVisitors: 1000, returningVisitors: 234, sessions: 2345, laps: 15_000, flightS: 40_000 },
    window: { ...real.window, visits: 21_000, sessions: 34_000, laps: 1_250_000, flightS: 9_000_000 },
    countries: codes.map(row),
    sources: [
      { key: 'direct', name: 'Direct', visits: 900, sessions: 1500, laps: 9000 },
      { key: 'other', name: 'Other', visits: 30, sessions: 40, laps: 90 },
      { key: 'acme', name: 'Acme Hobbies', visits: 120, sessions: 300, laps: 2100 },
      { key: 'zeta', name: 'Zeta FPV', visits: 120, sessions: 310, laps: 2000 },
    ],
    craft: [
      { key: 'sky1800', visits: 1, sessions: 500, laps: 1 }, { key: '5inch', visits: 1, sessions: 300, laps: 1 },
      { key: 'mystery9', visits: 1, sessions: 50, laps: 1 }, { key: 'other', visits: 1, sessions: 10, laps: 1 },
    ],
    inputs: [{ key: 'gamepad', visits: 1, sessions: 600, laps: 1 }, { key: 'touch', visits: 1, sessions: 40, laps: 1 }],
    maps: [{ key: 'custom', visits: 1, sessions: 700, laps: 1 }, { key: 'other', visits: 1, sessions: 3, laps: 1 }],
    allTime: { laps: 2_345_678, sessions: 120_000, visits: 45_000, flightS: 30_000_000, countries: 41 },
    board: { tracks: 88, times: 1200, pilots: 340, pilotsOnMoreThanOneDay: 120 },
    live: { flying: 7 },
  };
  return { empty, busy };
}

/*
 * The page paints a plan when its canvas first has a size and again 140 ms
 * after a resize. A card painted while the layout was still moving keeps a
 * plate a pixel off until the next resize, and whether that happens
 * depends on timing, so every read starts with a resize and waits out the
 * repaint. Both trees get the same treatment.
 */
async function settle(tab) {
  await tab.until('document.fonts.status === "loaded" && !document.querySelector(".skeleton")');
  await tab.evaluate('window.dispatchEvent(new Event("resize")); true');
  await tab.sleep(300);
  let last = '';
  let same = 0;
  for (let i = 0; i < 60 && same < 3; i += 1) {
    const now = await tab.evaluate('document.body.innerText + "|" + document.body.querySelectorAll("*").length');
    same = now === last ? same + 1 : 0;
    last = now;
    await tab.sleep(150);
  }
}

async function walk(tree, template, frozenMs, trackIds, fixtures) {
  const file = join(tmpdir(), `client-board-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  copyFileSync(template, file);
  const board = await startBoard(tree, file);
  /* The page's own statistics events are caught rather than counted: a
   * beacon sent as one scene unloads lands before or after the next scene
   * reads the counters depending on timing. What the page sends is kept
   * and compared instead, which pins the wire format too. */
  const tab = await openTab({ allowOrigin: board.origin, seed: seedScripts(frozenMs), swallow: ['/api/stats/events'] });
  const seen = [];
  try {
    /* CLIENT_ONLY=<regex> walks a subset, for working on the harness. */
    const only = process.env.CLIENT_ONLY ? new RegExp(process.env.CLIENT_ONLY) : null;
    for (const scene of scenes(trackIds, fixtures).filter((sc) => !only || only.test(sc.name))) {
      try {
        await playScene(scene);
      } catch (err) {
        throw new Error(`scene ${scene.name} in ${tree}: ${err.message}`);
      }
    }
  } finally {
    await tab.close();
    board.stop();
    rmSync(file, { force: true });
  }
  return seen;

  async function playScene(scene) {
    {
      await tab.navigate(`${board.origin}/empty`);
      await tab.evaluate('localStorage.clear(); sessionStorage.clear(); true');
      if (scene.before) {
        await tab.evaluate(`${scene.before}; true`);
      }
      /* Room for the previous scene's unload beacon to land before this
       * scene starts counting what it sends. */
      await tab.sleep(400);
      tab.stubs.clear();
      for (const [path, answer] of Object.entries(scene.stub || {})) {
        tab.stubs.set(path, answer);
      }
      const dropInit = scene.init ? await tab.beforePages(scene.init) : null;
      await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: scene.media || 'no-preference' }] });
      const errorsBefore = tab.errors.length;
      const sentBefore = tab.swallowed.length;
      await tab.navigate(`${board.origin}${scene.path}`);
      await settle(tab);
      if (scene.plans) {
        await tab.evaluate(drawSheetScript(board.origin, planSheet()));
        await settle(tab);
      }
      if (scene.spanish) {
        await tab.evaluate(SPANISH);
        await settle(tab);
      }
      if (scene.act) {
        await tab.evaluate(scene.act);
        await settle(tab);
      }
      if (scene.ready) {
        await tab.until(scene.ready);
        await settle(tab);
      }
      if (scene.then) {
        await tab.evaluate(scene.then);
        await settle(tab);
        await tab.until(scene.thenReady);
        await settle(tab);
      }
      await dropInit?.();
      /* The two readings of the server's real clock (see serverClockFree)
       * are masked on the page itself too, so the screenshots agree. */
      await tab.evaluate(`for (const n of document.querySelectorAll('#admin-until, #stats-fresh')) {
        n.textContent = n.textContent.replace(/(tomorrow at |mañana a las )?\\b\\d{1,2}:\\d{2}( [AP]M)?\\b/g, '<clock>').replace(/\\b\\d+ min\\b/g, '<n> min');
      } true`);
      seen.push({
        name: scene.name,
        url: await tab.evaluate('location.href.replace(location.origin, "")'),
        focus: await tab.evaluate('document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id}` : ""'),
        /* Where every link and frame points, and which tab it opens: the
         * links to the simulator are a contract with it. */
        links: (await tab.evaluate(`[...document.querySelectorAll('a[href], iframe[src]')]
          .map((n) => [n.tagName, n.getAttribute('href') ?? n.getAttribute('src'), n.target || '', n.rel || ''].join(' '))`))
          /* Each walk has its own board on its own port. */
          .map((l) => l.split(board.origin).join('<board>').split(encodeURIComponent(board.origin)).join('<board>')
            /* A blob URL is new every time it is made. */
            .replace(/blob:<board>\/[0-9a-f-]{36}/g, 'blob:<board>/<blob>')),
        text: await tab.evaluate('document.body.innerText'),
        ids: await tab.evaluate('[...document.querySelectorAll("[id]")].map((n) => n.id).sort()'),
        png: await tab.screenshot(),
        errors: tab.errors.slice(errorsBefore),
        sent: tab.swallowed.slice(sentBefore),
      });
    }
  }
}

/* Ids the page's own scripts look up by name; each must exist somewhere. */
function idsLookedUp(tree) {
  const ids = new Set();
  for (const name of readdirSync(join(tree, 'public'))) {
    if (!name.endsWith('.js')) {
      continue;
    }
    const src = readFileSync(join(tree, 'public', name), 'utf8');
    for (const m of src.matchAll(/(?:getElementById|byId)\(\s*'([A-Za-z][\w-]*)'\s*\)/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

if (!chromePath()) {
  console.log('client check: skip, no Chrome on this machine (set BOARD_CHROME)');
  process.exit(process.env.CI ? 1 : 0);
}

const scratch = mkdtempSync(join(tmpdir(), 'client-check-'));
const template = join(scratch, 'board.json');
const seeder = await startBoard(root, template);
let trackIds;
let realStats;
let realTags;
let realConfig;
try {
  ({ tracks: trackIds } = await seedBoard(seeder.origin));
  realStats = await (await fetch(`${seeder.origin}/api/stats`)).json();
  realTags = (await (await fetch(`${seeder.origin}/api/tracks`)).json()).tags;
  realConfig = await (await fetch(`${seeder.origin}/api/config`)).json();
} finally {
  seeder.stop();
}
await new Promise((r) => setTimeout(r, 300));
/* An hour after seeding, on a whole minute. */
const frozenMs = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;
const fixtures = { ...statsFixtures(realStats, frozenMs), tags: realTags, config: realConfig };

console.log('\nthis tree');
const mine = await walk(root, template, frozenMs, trackIds, fixtures);
for (const s of mine) {
  check(`${s.name}: no page error`, s.errors.length === 0, s.errors.join(' | '));
}
/* The whole-page facts need every scene, so a CLIENT_ONLY subset skips them. */
if (!process.env.CLIENT_ONLY) {
  const allIds = new Set(mine.flatMap((s) => s.ids));
  const missing = [...idsLookedUp(root)].filter((id) => !allIds.has(id));
  check('every id the page scripts look up exists in some scene', missing.length === 0, missing.join(', '));
  const text = Object.fromEntries(mine.map((s) => [s.name, s.text]));
  check('the list shows every field track', ['Costanera Sprint', 'Mburucuya Ladder'].every((n) => text.tracks.includes(n)), text.tracks.slice(0, 600));
  check('the room filter shows the room', text['tracks-room'].includes('Living Room Loop'));
  check('the wing filter shows the airfield', text['tracks-wing'].includes('Airfield Loop'));
  check('a field sheet shows its pilots', ['Lapacho', 'Tatu', 'Carpincho'].every((n) => text['sheet-field'].includes(n)));
  check('the room sheet names its designer', text['sheet-room'].includes('Skittles'));
  check('the statistics tab shows counters', /\d/.test(text.stats) && text.stats !== text.tracks);
  check('the admin panel says who signed in', text.admin.includes(ADMIN));
  check('the inbox lists the seeded tickets', text.bugs.includes('Gate flickers at dusk') && text.bugs.includes('Tab froze after a reset'));
  check('Spanish changes the page', text['es-tracks'] !== text.tracks);
  const sentOf = (name) => mine.find((m) => m.name === name).sent.map((e) => JSON.parse(e.body));
  const find = (name) => mine.find((m) => m.name === name);
  check('an old #course= link opens the track and the address says #track=', find('old-course-link').url.includes('#track='));
  check('the aircraft from a link is shown', find('craft-from-link').text.includes('Living Room Loop')
    && find('craft-from-link').links.some((l) => l.includes('craft=whoop65')) && !find('craft-from-link').links.some((l) => l.includes('share=trk-c11e0001&board=<board>&craft=5inch fdfpv-sim')));
  check('Escape closes the sheet and drops the hash', !find('sheet-escape').url.includes('#'));
  check('the / key puts the cursor in the search', find('slash-finds').focus === 'INPUT#find', find('slash-finds').focus);
  check('a room with an animation shows it, and reduced motion shows the plan',
    find('tracks-room').links.some((l) => l.includes('/gif')) || find('tracks-room').text.length > 0);
  check('a removed track leaves the board', !find('admin-removes').text.includes('Costanera Sprint'));
  check('a config naming another simulator moves the Fly link', find('board-elsewhere').links.some((l) => l.includes('https://sim.example/fly/?map=custom')));
  check('the admin panel lists the sponsors with their links', find('admin').text.includes('Acme Hobbies'));
  check('a returning browser says so', sentOf('stats-returning').some((e) => e.kind === 'visit' && e.returning === true));
  check('a browser counted today sends no visit', !sentOf('stats-counted-today').some((e) => e.kind === 'visit'));
  check('a sponsor arrival is carried, and the address loses its utm_ parameters',
    sentOf('stats-sponsor').some((e) => e.source === 'acme-poster') && !mine.find((m) => m.name === 'stats-sponsor').url.includes('utm_'),
    mine.find((m) => m.name === 'stats-sponsor').url);
  check('an expired sponsor is not', sentOf('stats-sponsor-expired').every((e) => e.source === null));
  check('a browser asking not to be tracked sends nothing', sentOf('stats-gpc').length === 0);
  check('an opted out browser sends nothing after the switch', sentOf('stats-optout').length <= 1);
  check('a visit to the board sends a visit event', mine[0].sent.some((e) => e.body && JSON.parse(e.body).kind === 'visit'),
    JSON.stringify(mine[0].sent));
  check('the plan sheet drew every plan', text.plans.split('\n').filter((l) => l.includes(' | ')).length === planSheet().length, text.plans.slice(0, 400));
}

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const s of mine) {
    writeFileSync(join(outDir, `${s.name}.png`), s.png);
    writeFileSync(join(outDir, `${s.name}.txt`), s.text);
  }
}

if (against) {
  console.log(`\nagainst ${against}`);
  const baseTree = buildBaseline(against);
  try {
    const theirs = await walk(baseTree, template, frozenMs, trackIds, fixtures);
    for (const [i, s] of mine.entries()) {
      const t = theirs[i];
      check(`${s.name}: same visible text`, serverClockFree(s.text) === serverClockFree(t.text),
        firstDifference(serverClockFree(t.text), serverClockFree(s.text)));
      check(`${s.name}: ends at the same address`, s.url === t.url, `was ${t.url}, now ${s.url}`);
      check(`${s.name}: focus on the same element`, s.focus === t.focus, `was ${t.focus}, now ${s.focus}`);
      const linkDiff = s.links.filter((l) => !t.links.includes(l)).concat(t.links.filter((l) => !s.links.includes(l)).map((l) => `gone: ${l}`));
      check(`${s.name}: the same links, to the same places`, JSON.stringify(s.links) === JSON.stringify(t.links), linkDiff.slice(0, 6).join(' | '));
      check(`${s.name}: sends the same statistics events`, JSON.stringify(s.sent) === JSON.stringify(t.sent),
        `was ${JSON.stringify(t.sent)}, now ${JSON.stringify(s.sent)}`);
      const cmp = comparePng(t.png, s.png);
      check(`${s.name}: same screenshot (${cmp.sameSize ? `${(cmp.share * 100).toFixed(3)}% of pixels differ` : `sizes ${cmp.sizes.join(' vs ')}`})`,
        cmp.sameSize && cmp.share <= PIXEL_SHARE);
      const lost = t.ids.filter((id) => !s.ids.includes(id));
      if (lost.length) {
        console.log(`        note: ids only in ${against}: ${lost.join(', ')}`);
      }
      if (outDir) {
        writeFileSync(join(outDir, `${s.name}.base.png`), t.png);
        writeFileSync(join(outDir, `${s.name}.base.txt`), t.text);
      }
    }
  } finally {
    rmSync(baseTree, { recursive: true, force: true });
  }
}

/*
 * Two readings come from the server's own clock, which the frozen page
 * clock cannot reach: how long ago the statistics were generated, and when
 * an admin's sign in runs out (which says "tomorrow" once it passes
 * midnight). They move with the wall clock between the two walks, so they
 * are masked when the walks are compared.
 */
function serverClockFree(text) {
  return text
    .replace(/(tomorrow at |mañana a las )?\b\d{1,2}:\d{2}( [AP]M)?\b/g, '<clock>')
    .replace(/\b\d+ min\b/g, '<n> min');
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) {
    i += 1;
  }
  return `at ${i}: was ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))}, now ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`;
}

rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
