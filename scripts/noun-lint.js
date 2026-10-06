/*
 * noun-lint.js: a player reads "track", and never "course".
 *
 * The thing a player builds, publishes and races is one object, and the
 * product used to call it by two names, sometimes in one sentence. The
 * rename is done; this is what stops the old word creeping back in with
 * the next screen somebody writes.
 *
 * Only text a player can read is checked: string literals in scripts, and
 * in pages the text between tags and the attributes a browser renders or
 * reads aloud. Identifiers, class names, storage keys and routes are left
 * alone, because renaming a stored key would orphan what is already in a
 * browser, and nobody but us reads a selector. Comments are left alone
 * too, so a comment can explain why a key is still spelled the old way.
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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* Not the product: other people's code, scratch, stored data, and test
 * suites, whose wording describes code rather than speaking to a player. */
const IGNORED_DIRS = new Set(['.git', '.loop', 'node_modules', 'vendor', 'dist', 'tests', 'tmp', 'data']);

/*
 * A sighting that is argued to be fine, as { file, text, why }. Empty on
 * the board. It exists so that an exception, when one is needed, is
 * written down with its reason instead of being made by weakening the
 * pattern below.
 */
const EXCEPTIONS = [];

const BANNED = /(?<![A-Za-z0-9_])[Cc]ourses?(?![A-Za-z0-9_])/;

/* The attributes whose values reach a reader: shown, spoken or indexed. */
const READ_ATTRIBUTES = ['alt', 'aria-label', 'content', 'placeholder', 'title'];

/*
 * Comments and string literals of a script, in source order, as one
 * alternation: whichever starts first wins, so an apostrophe inside a
 * comment never opens a string and a slash pair inside a string never
 * opens a comment.
 */
const SCRIPT_TOKEN = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g;

function linesBefore(text, offset) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    n += 1;
  }
  return n;
}

/* Every string literal in `code`, with the line it opens on. `firstLine`
 * is where `code` itself starts in its file. */
function stringLiterals(code, firstLine = 1) {
  const found = [];
  for (const m of code.matchAll(SCRIPT_TOKEN)) {
    if (m[0][0] === '/') {
      continue;
    }
    found.push({ text: m[0].slice(1, -1), line: firstLine + linesBefore(code, m.index) - 1 });
  }
  return found;
}

/*
 * What a ${...} holds is code. `${card.course.id}` shows a player nothing
 * of the word, and a lint that cried wolf over property names would soon
 * be switched off.
 */
function withoutPlaceholders(text) {
  return text.replace(/\$\{[^}]*\}/g, '');
}

/* A class list, a route, a key or a selector: every word lower case and
 * made of the characters those are made of. `screen screen-courses` is
 * machinery; `A gated course` is a sentence. */
function isMachinery(text) {
  return text.split(/\s+/).filter(Boolean).every((word) => /^[a-z0-9\-_./#?=&:]+$/.test(word));
}

function speaksTheWord(literal) {
  const visible = withoutPlaceholders(literal);
  return BANNED.test(visible) && !isMachinery(visible);
}

function excused(file, text) {
  return EXCEPTIONS.some((e) => e.file === file && text.includes(e.text));
}

function oneLine(text, max) {
  return text.trim().replace(/\s+/g, ' ').slice(0, max);
}

function scriptFindings(file, code) {
  return stringLiterals(code)
    .filter((lit) => speaksTheWord(lit.text) && !excused(file, lit.text))
    .map((lit) => ({ file, line: lit.line, text: oneLine(lit.text, 90) }));
}

/*
 * A page: comments, styles and scripts are blanked to the same number of
 * lines so what is left is what renders, and line numbers still match the
 * file. A script's literals are then read as any other script's.
 */
function pageFindings(file, html) {
  const blank = (chunk) => chunk.replace(/[^\n]/g, '');
  const findings = [];
  for (const m of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const bodyLine = linesBefore(html, m.index + m[1].length);
    for (const lit of stringLiterals(m[2], bodyLine)) {
      if (speaksTheWord(lit.text)) {
        findings.push({ file, line: lit.line, text: `inline script: ${oneLine(withoutPlaceholders(lit.text), 80)}` });
      }
    }
  }
  const rendered = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank);
  for (const m of rendered.matchAll(/>([^<]+)</g)) {
    if (BANNED.test(m[1])) {
      findings.push({ file, line: linesBefore(rendered, m.index), text: oneLine(m[1], 90) });
    }
  }
  const attr = new RegExp(`(${READ_ATTRIBUTES.join('|')})="([^"]*)"`, 'g');
  for (const m of rendered.matchAll(attr)) {
    if (BANNED.test(m[2])) {
      findings.push({ file, line: linesBefore(rendered, m.index), text: `${m[1]}="${m[2].slice(0, 70)}"` });
    }
  }
  return findings;
}

async function productFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...await productFiles(path));
      }
    } else if (/\.(js|html)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/* This file spells the word on purpose, and a selftest's check names
 * describe code to whoever runs it. */
function isScanned(file) {
  return file !== 'scripts/noun-lint.js' && !file.endsWith('selftest.js');
}

const files = (await productFiles(root)).map((p) => relative(root, p)).filter(isScanned).sort();
const findings = [];
for (const file of files) {
  const text = await readFile(join(root, file), 'utf8');
  findings.push(...(file.endsWith('.html') ? pageFindings(file, text) : scriptFindings(file, text)));
}

console.log(`noun lint: ${files.length} file(s) scanned for a player-visible "course"`);
if (findings.length === 0) {
  console.log(`  allowed, with reasons in this file: ${EXCEPTIONS.length}`);
  console.log('\nPASS, the player only ever sees a track');
  process.exit(0);
}
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  ${f.text}`);
}
console.log(`\nFAIL, ${findings.length} player-visible "course"`);
console.log('The player sees one noun. Use track, or add an argued exception to EXCEPTIONS.');
process.exit(1);
