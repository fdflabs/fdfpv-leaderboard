/*
 * strings: every word the pilot reads, by key.
 *
 * The copy used to be inline, two thousand literals across the shell, so
 * a second language meant a second shell. Now a screen asks t('key') and
 * the table for the current locale answers; a placeholder like {name} in
 * the text is filled from the vars. en.js is the copy of record and the
 * fallback: a key missing from another locale reads in English rather
 * than as a hole, and a key missing from en.js is a bug and throws, so a
 * typo cannot ship as blank text.
 *
 * The locale comes from ?lang= on the address, then localStorage, then
 * the browser's own language, then en. Only en is bundled; another locale
 * is loaded on demand from its own file beside en.js. What stays out of
 * the table on purpose: the wordmark, trick proper names, Betaflight field
 * names, and signage baked into the world.
 *
 * This file is part of the FDFPV leaderboard.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import en from './en.js';

export const LANG_KEY = 'webfpv.lang';
/* Shared with the simulator on purpose: one choice of language for both. */
export const LOCALES = ['en', 'es'];
export const LOCALE_NAMES = { en: 'English', es: 'Español' };

const tables = { en };
let locale = 'en';

/* The page is small and its modules build copy as they load, so Spanish is
 * loaded here, before anyone imports this, and the locale chosen at once. */
try {
  tables.es = (await import('./es.js')).default;
} catch (e) {
}

export function currentLocale() {
  return locale;
}

export function str(key, vars) {
  let text = tables[locale] ? tables[locale][key] : undefined;
  if (text === undefined) {
    text = en[key];
  }
  if (text === undefined) {
    throw new Error(`no string for ${key}`);
  }
  if (!vars) {
    return text;
  }
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/* key.one and key.other, with {n} filled in. */
export function plural(key, n, vars) {
  return str(n === 1 ? `${key}.one` : `${key}.other`, { n, ...(vars || {}) });
}

export function setLocale(id) {
  locale = tables[id] ? id : 'en';
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  } catch (e) {
  }
  return locale;
}

/* Loads a locale's table beside en.js and makes it current. Unknown or
 * unloadable locales fall back to en without throwing. */
export async function useLocale(id) {
  const want = String(id || 'en').toLowerCase().split('-')[0];
  if (want !== 'en' && !tables[want] && LOCALES.includes(want)) {
    try {
      const mod = await import(`./${want}.js`);
      tables[want] = mod.default;
    } catch (e) {
    }
  }
  return setLocale(want);
}

export function rememberLocale(id) {
  try {
    localStorage.setItem(LANG_KEY, id);
  } catch (e) {
  }
}

/* The locale a page should start in. */
export function preferredLocale() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (fromUrl) {
      return fromUrl;
    }
  } catch (e) {
  }
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored) {
      return stored;
    }
  } catch (e) {
  }
  try {
    return navigator.language || 'en';
  } catch (e) {
    return 'en';
  }
}

setLocale(String(preferredLocale() || 'en').toLowerCase().split('-')[0]);
