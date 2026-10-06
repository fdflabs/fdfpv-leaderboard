/*
 * origins.js: where the simulator and the front door live, worked out from
 * the page's own address before the server has said anything.
 *
 * /api/config is the authority and overrides these answers when it comes
 * back. They exist because the links in the HTML are loopback addresses,
 * and if that one request fails (database down, a 502, offline) every link
 * on a public board would otherwise point at 127.0.0.1 with nothing to
 * say so. A link to the simulator should never depend on the board being
 * reachable.
 *
 * The page's address is an argument rather than read from `window`, so
 * tests/client-golden.js can ask in Node.
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

/* The simulator's GitHub Pages site, which is also the published front
 * door: no separate landing site is deployed. The simulator's
 * src/share/board.js holds the same two constants; they must agree. */
export const PRODUCTION_SIM_ORIGIN = 'https://fdflabs.github.io/fdfpv';
export const PRODUCTION_LANDING_ORIGIN = PRODUCTION_SIM_ORIGIN;

/* A checkout serves the landing page on 8080 and the simulator on 8000,
 * as the simulator's DEPLOY.md lays out. */
export const LOCAL_LANDING_PORT = 8080;
const LOCAL_SIM_PORT = 8000;

/* '' is what a file:// page reports as its hostname. */
const LOCAL_NAMES = ['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

export function isLoopback(hostname) {
  return LOCAL_NAMES.includes(hostname == null ? '' : String(hostname));
}

/* The same host on a local port, keeping https only when the page has it. */
function localOrigin(location, port) {
  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${location.hostname || '127.0.0.1'}:${port}`;
}

/*
 * The production board is mounted at /board on the owner's VM behind
 * Caddy (deploy/vm in the simulator's repository). `here` is the page's
 * directory, so the board at /board/ and its bug page answer alike.
 */
function mountedAtBoard(here) {
  const dir = String(here?.pathname || '/').replace(/\/+$/, '');
  return dir.endsWith('/board');
}

/*
 * The simulator, when the address says: on a checkout it is the local
 * port, under the /board mount it is the production site. Any other host
 * gets null, and the caller leaves those links alone until /api/config
 * answers, because a confident wrong link is worse than a late right one.
 */
export function guessSimOrigin(location, here) {
  if (!location || !here) {
    return null;
  }
  if (isLoopback(location.hostname)) {
    return localOrigin(location, LOCAL_SIM_PORT);
  }
  return mountedAtBoard(here) ? PRODUCTION_SIM_ORIGIN : null;
}

/*
 * The front door, which always has an answer: there is one published
 * landing address and no config field for it, so anything but a checkout
 * is the production one. A fork changes PRODUCTION_LANDING_ORIGIN.
 */
export function landingOrigin(location) {
  if (location && isLoopback(location.hostname)) {
    return localOrigin(location, LOCAL_LANDING_PORT);
  }
  return PRODUCTION_LANDING_ORIGIN;
}
