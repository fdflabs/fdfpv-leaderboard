/*
 * scripts-selftest.js: the tools under scripts/ judged by what they do.
 *
 * A lint that passes on the repository proves nothing about itself: it
 * would pass just the same if it scanned no files at all. So each lint is
 * copied into a scratch directory laid out like this repository, with a
 * few files written to break it in known places and a few written to look
 * like a breach without being one, and its exit code and the places it
 * names are compared with what a reader would say.
 *
 * The lints find the root they scan from their own location, which is
 * what makes a copy in a scratch tree scan the scratch tree.
 *
 * The seed script is run against a real server on a loopback port with a
 * scratch file store, and the board it leaves behind is read back over the
 * same API the page uses.
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
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n${detail}` : ''}`);
  }
}

/* Runs scripts/<lint> from a scratch root holding `files` ({path: text}). */
function runIn(lint, files) {
  const root = mkdtempSync(join(tmpdir(), 'scripts-selftest-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(here, lint), join(root, 'scripts', lint));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const r = spawnSync(process.execPath, [join(root, 'scripts', lint)], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* The `path:line` places a noun lint report names, in the order printed. */
function places(out) {
  return [...out.matchAll(/^ {2}(\S+?):(\d+) {2}/gm)].map((m) => `${m[1]}:${m[2]}`);
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

async function waitFor(url) {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      /* Not listening yet: the server is still loading the simulator's modules. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never answered`);
}

const GPL = '/* This program is under the GNU General Public License, version 3. */\n';

console.log('\nnoun lint');
{
  const clean = runIn('noun-lint.js', {
    'public/a.js': [
      GPL,
      "const cls = 'screen screen-courses';",
      "// a comment may say course",
      "/* and so may a block: course, courses */",
      "const k = 'board.course.v1';",
      'const t = `${card.course.track.id}`;',
      "const w = 'Coursework and recourse are other words';",
      "const plain = 'courses';",
      '',
    ].join('\n'),
    'public/page.html': [
      '<!doctype html>',
      '<!-- a course in a comment -->',
      '<style>.course-card { color: red; }</style>',
      '<div class="course-card" id="courses">A track</div>',
      "<script type=\"module\">const id = 'course-list';</script>",
      '',
    ].join('\n'),
    'src/selftest.js': "check('a course is checked', true);\n",
    'vendor/x.js': "const s = 'A vendored course';\n",
    'tests/x.js': "const s = 'A tested course';\n",
    'data/x.js': "const s = 'A stored course';\n",
    'tmp/x.js': "const s = 'A scratch course';\n",
    'public/note.txt': 'Not a script, so not a course.\n',
  });
  check('a tree with no player visible course passes', clean.code === 0, clean.out);
  check('it says how many files it scanned', /noun lint: 2 file\(s\) scanned/.test(clean.out), clean.out);
  check('and says PASS', /\nPASS, the player only ever sees a track/.test(clean.out), clean.out);

  const dirty = runIn('noun-lint.js', {
    'public/a.js': [
      GPL,
      "const a = 'A gated course';",
      'const b = `Fly the ${name} course`;',
      "const c = 'it\\'s a course';",
      "const d = 'Courses';",
      "const e = \"Three courses, one board\";",
      '',
    ].join('\n'),
    'src/b.js': "\nconst msg = 'That course is gone.';\n",
    'public/page.html': [
      '<!doctype html>',
      '<p>Our course</p>',
      '<button title="Open the course">Go</button>',
      '<img alt="A course plan" src="x.png">',
      '<input placeholder="Course name">',
      '<meta content="Every course on the board">',
      '<span aria-label="Course list"></span>',
      '',
    ].join('\n'),
    'public/inline.html': [
      '<!doctype html>',
      '<p>Fine</p>',
      "<script>const s = 'A scripted course';</script>",
      '',
    ].join('\n'),
  });
  check('a tree with player visible courses fails', dirty.code === 1, dirty.out);
  const got = places(dirty.out);
  const want = [
    'public/a.js:3', 'public/a.js:4', 'public/a.js:5', 'public/a.js:6', 'public/a.js:7',
    'public/page.html:2', 'public/page.html:3', 'public/page.html:4', 'public/page.html:5',
    'public/page.html:6', 'public/page.html:7',
    'src/b.js:2',
  ];
  for (const w of want) {
    check(`it names ${w}`, got.includes(w), dirty.out);
  }
  check('an inline script in a page is read as script', got.some((p) => p.startsWith('public/inline.html:')), dirty.out);
  check('and nothing else is named', got.length === want.length + 1, dirty.out);
  check('it counts what it found', /\nFAIL, 13 player-visible "course"/.test(dirty.out), dirty.out);
}

console.log('\nlicence lint');
{
  const filler = `/* ${'x'.repeat(3100)} */\n`;
  const ok = runIn('licence-lint.js', {
    'src/a.js': GPL,
    'public/b.mjs': GPL,
    'public/c.html': '<!doctype html>\n<!-- GNU General Public License -->\n',
    'public/d.css': GPL,
    'schema.sql': '-- GNU General Public License\n',
    'render.yaml': '# GNU General Public License\n',
    '.github/workflows/checks.yml': '# GNU General Public License\n',
    'package.json': '{}\n',
    'README.md': 'no header here, and none is wanted\n',
    'node_modules/x/index.js': 'nothing\n',
    'data/board.js': 'nothing\n',
    'src/data/nested.js': 'nothing, any directory named data is skipped\n',
    'vendor/fdfpv/a.js': 'nothing\n',
    'public/credits/logo.svg': '<svg/>\n',
    'public/credits/x.css': 'nothing\n',
  });
  check('a tree where every file carries the notice passes', ok.code === 0, ok.out);
  check('it counts the files that can carry one', /licence-lint: 8 shipped file\(s\)/.test(ok.out), ok.out);
  check('and says so', /all 8 carry the GPLv3 notice in their first 3000 characters/.test(ok.out), ok.out);

  const bad = runIn('licence-lint.js', {
    'src/a.js': GPL,
    'src/bare.js': 'export const x = 1;\n',
    'public/late.html': `<!doctype html>\n<!-- ${'y'.repeat(3100)} -->\n<!-- GNU General Public License -->\n`,
    'schema.sql': 'create table t (id int);\n',
    'docker-compose.yml': 'services: {}\n',
    'public/late.js': `${filler}${GPL}`,
    'public/credits.js': 'outside public/credits, so checked\n',
  });
  check('a tree with files missing the notice fails', bad.code === 1, bad.out);
  const fails = [...bad.out.matchAll(/^FAIL {2}(\S+)$/gm)].map((m) => m[1]).sort();
  const wantFails = ['docker-compose.yml', 'public/credits.js', 'public/late.html', 'public/late.js', 'schema.sql', 'src/bare.js'];
  check('it names exactly the files without one, a notice past 3000 characters counting as none',
    JSON.stringify(fails) === JSON.stringify(wantFails), bad.out);
  check('it counts them', /\n6 file\(s\) without the GPLv3 notice/.test(bad.out), bad.out);
}

console.log('\nseed');
{
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'seed-selftest-'));
  const server = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_FILE: join(dir, 'board.json') },
    stdio: 'ignore',
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitFor(`${origin}/api/health`);
    const seeded = spawnSync(process.execPath, [join(here, 'seed.js')], {
      env: { ...process.env, BOARD_ORIGIN: origin },
      encoding: 'utf8',
    });
    check('seed exits 0 against an empty board', seeded.status === 0, seeded.stdout + seeded.stderr);
    const { tracks } = await (await fetch(`${origin}/api/tracks`)).json();
    check('it leaves at least two tracks on the board', tracks.length >= 2, JSON.stringify(tracks).slice(0, 400));
    check('every one carries its logo, which the page draws on the card', tracks.every((t) => t.hasLogo));
    for (const t of tracks) {
      const doc = await (await fetch(`${origin}/api/tracks/${t.id}/document`)).json();
      check(`${t.id} hands its document back with the logo in it`, Boolean(doc.document?.branding?.logo));
    }
    check('it says what it published, one line per track',
      tracks.every((t) => seeded.stdout.includes(t.id)), seeded.stdout);
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
