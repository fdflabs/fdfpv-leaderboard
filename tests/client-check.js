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

function scenes(trackIds) {
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
    { name: 'stats', path: '/#stats', ready: `!document.getElementById('view-stats').hidden` },
    { name: 'admin', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden` },
    { name: 'admin-sheet', path: '/', act: SIGN_IN, ready: `!document.getElementById('admin-signed').hidden`,
      then: `location.hash = '#track=${field}'`, thenReady: `!document.getElementById('sheet').hidden` },
    { name: 'bugs', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list .ticket, #list button').length > 0` },
    { name: 'bugs-ticket', path: '/bugs.html', act: BUGS, ready: `document.querySelectorAll('#list button').length > 0`,
      then: `document.querySelector('#list button').click()`, thenReady: `document.getElementById('sheet')?.textContent.length > 0 || true` },
  ];
  base.push({ name: 'plans', path: '/api/health', plans: true });
  const spanish = base
    .filter((s) => !s.plans && !s.path.startsWith('/bugs'))
    .map((s) => ({ ...s, name: `es-${s.name}`, spanish: true }));
  return [...base, ...spanish];
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

async function walk(tree, template, frozenMs, trackIds) {
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
    for (const scene of scenes(trackIds)) {
      await tab.navigate(`${board.origin}/empty`);
      await tab.evaluate('localStorage.clear(); sessionStorage.clear(); true');
      /* Room for the previous scene's unload beacon to land before this
       * scene starts counting what it sends. */
      await tab.sleep(400);
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
      seen.push({
        name: scene.name,
        text: await tab.evaluate('document.body.innerText'),
        ids: await tab.evaluate('[...document.querySelectorAll("[id]")].map((n) => n.id).sort()'),
        png: await tab.screenshot(),
        errors: tab.errors.slice(errorsBefore),
        sent: tab.swallowed.slice(sentBefore),
      });
    }
  } finally {
    await tab.close();
    board.stop();
    rmSync(file, { force: true });
  }
  return seen;
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
try {
  ({ tracks: trackIds } = await seedBoard(seeder.origin));
} finally {
  seeder.stop();
}
await new Promise((r) => setTimeout(r, 300));
/* An hour after seeding, on a whole minute. */
const frozenMs = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;

console.log('\nthis tree');
const mine = await walk(root, template, frozenMs, trackIds);
for (const s of mine) {
  check(`${s.name}: no page error`, s.errors.length === 0, s.errors.join(' | '));
}
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
check('a visit to the board sends a visit event', mine[0].sent.some((e) => e.body && JSON.parse(e.body).kind === 'visit'),
  JSON.stringify(mine[0].sent));
check('the plan sheet drew every plan', text.plans.split('\n').filter((l) => l.includes(' | ')).length === planSheet().length, text.plans.slice(0, 400));

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
    const theirs = await walk(baseTree, template, frozenMs, trackIds);
    for (const [i, s] of mine.entries()) {
      const t = theirs[i];
      check(`${s.name}: same visible text`, serverClockFree(s.text) === serverClockFree(t.text),
        firstDifference(serverClockFree(t.text), serverClockFree(s.text)));
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
 * an admin's sign in runs out. They move with the wall clock between the
 * two walks, so they are masked when the walks are compared.
 */
function serverClockFree(text) {
  return text.replace(/\b\d{1,2}:\d{2}( [AP]M)?\b/g, '<clock>').replace(/\b\d+ min\b/g, '<n> min');
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
