/*
 * events.js: Flight Club's weekly event, the rules without the storage
 * (the simulator's docs/FLIGHTCLUB-PROGRESSION.md section 4).
 *
 * A WEEK runs from Monday 00:00 UTC to the next. Its course is picked the
 * first time anybody asks in that week, from the published courses that
 * carry medal times (the simulator's src/game/medals.js), by rotation:
 * sorted by id, the week's number since 1970 modulo how many there are.
 * The pick is stored with the gold time it had then (src/store.js
 * fixEvent), so a course published, republished or removed mid-week
 * changes nothing about the week's event.
 *
 * THE STANDINGS are each pilot's best lap on that course posted inside the
 * week, on the board its medals were set on (quads, or the plane board
 * when `wing`). A pilot is their key; a lap posted without one counts
 * under its name. TIERS are what the economy pays (the simulator's
 * docs/ECONOMY.md section 3): 'finish' for any lap in the week, then the
 * medal it reached. A tier is absolute, never a placing, so it is final
 * the moment the lap is posted and never moves.
 *
 * medalsOf and medalFor KEEP IN STEP with the simulator's
 * src/game/medals.js (cleanMedals, medalFor): the same ratios, the same
 * rounding. They are copied rather than imported until vendor/fdfpv is
 * pinned past the commit that adds them.
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

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/* 1970-01-05 was a Monday: weeks are counted from there. */
const FIRST_MONDAY_MS = 4 * DAY_MS;
const LAP_MAX_MS = 3_600_000;
export const TIERS = ['finish', 'bronze', 'silver', 'gold'];
/* How far back the tiers route looks: a pilot who has not synced for two
 * months is still paid for every event in them. */
export const TIER_WEEKS = 8;

const pad = (n) => String(n).padStart(2, '0');

/* The ISO week a moment falls in: its id ('2026-w41'), its Monday 00:00
 * UTC and the next, and its number since 1970 (the rotation's index). */
export function weekOf(ms) {
  const index = Math.floor((ms - FIRST_MONDAY_MS) / WEEK_MS);
  const start = FIRST_MONDAY_MS + index * WEEK_MS;
  /* The ISO year is the year of the week's Thursday. */
  const thursday = new Date(start + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const n = Math.floor((thursday.getTime() - jan1) / WEEK_MS) + 1;
  return {
    week: `${year}-w${pad(n)}`,
    index,
    startsUtc: new Date(start).toISOString(),
    endsUtc: new Date(start + WEEK_MS).toISOString(),
  };
}

export function medalsOf(document) {
  const raw = document && document.medals;
  const n = Number(raw && raw.goldMs);
  if (!Number.isInteger(n) || n < 1 || n > LAP_MAX_MS) {
    return null;
  }
  return raw.wing === true ? { goldMs: n, wing: true } : { goldMs: n };
}

/* 'gold', 'silver', 'bronze' or null for a lap against gold. */
export function medalFor(goldMs, lapMs) {
  if (lapMs <= goldMs) {
    return 'gold';
  }
  if (lapMs <= Math.ceil(goldMs * 1.15)) {
    return 'silver';
  }
  return lapMs <= Math.ceil(goldMs * 1.35) ? 'bronze' : null;
}

/* The week's course from the candidates, each { id, name, map, medals },
 * or null when no course carries medals. */
export function pickCourse(candidates, index) {
  const list = candidates.filter((c) => c && c.medals).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return list.length ? list[((index % list.length) + list.length) % list.length] : null;
}

/* The event a week's pick makes, as stored. Its id is what the economy
 * keys a grant on: [a-z0-9-], at most 40 characters. */
export function eventFrom(week, course) {
  return {
    id: `${week.week}-${course.id}`.toLowerCase(),
    week: week.week,
    trackId: course.id,
    name: course.name,
    map: course.map || null,
    goldMs: course.medals.goldMs,
    wing: Boolean(course.medals.wing),
    startsUtc: week.startsUtc,
    endsUtc: week.endsUtc,
  };
}

const inWindow = (event, t) => {
  const at = Date.parse(t.postedUtc);
  return at >= Date.parse(event.startsUtc) && at < Date.parse(event.endsUtc);
};
const pilotOf = (t) => (t.key ? `k:${t.key}` : `n:${String(t.name || '').trim().toLowerCase()}`);

/* Each pilot's best lap in the week, fastest first, earlier first on a
 * tie; `times` are the course's, each { name, key, lapMs, postedUtc,
 * craft }. Keys stay on the rows for tierOf; the route drops them. */
export function standings(event, times) {
  const best = new Map();
  for (const t of times) {
    if (!inWindow(event, t) || Boolean(t.craft) !== event.wing) {
      continue;
    }
    const who = pilotOf(t);
    const held = best.get(who);
    if (!held || t.lapMs < held.lapMs || (t.lapMs === held.lapMs && t.postedUtc < held.postedUtc)) {
      best.set(who, t);
    }
  }
  return [...best.values()]
    .sort((a, b) => a.lapMs - b.lapMs || String(a.postedUtc).localeCompare(String(b.postedUtc)))
    .map((t) => ({
      name: t.name, key: t.key || null, lapMs: t.lapMs, medal: medalFor(event.goldMs, t.lapMs),
    }));
}

/* The tier a pilot key reached in an event, or null for no lap. */
export function tierOf(event, times, key) {
  const mine = standings(event, times).find((r) => r.key === key);
  return mine ? (mine.medal || 'finish') : null;
}

/* A public row: no pilot key. */
export const publicRow = ({ key, ...row }) => row;
