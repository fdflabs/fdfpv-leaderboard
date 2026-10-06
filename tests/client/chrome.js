/*
 * chrome.js: one headless Chrome tab, driven over the DevTools protocol.
 *
 * The board has no browser dependency and should not grow one for a test,
 * so this speaks CDP over Node's own WebSocket: launch Chrome with a
 * debugging port, attach to one tab, and offer the five things the client
 * check needs (navigate, evaluate, wait, screenshot, close). Every request
 * outside the board's own origin is blocked, so a run never reaches the
 * simulator on this machine or anything on the internet and two runs see
 * the same page.
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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.BOARD_CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function chromePath() {
  return CANDIDATES.find((p) => p && existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * `allowOrigin` is the only origin requests may reach. `seed` is script
 * source run before any page script on every navigation (the frozen clock).
 * A request whose path is in `swallow` is answered 204 here and never
 * reaches the board; its method, path and body are kept in `swallowed`.
 * A path in `stubs` is answered with the JSON set there.
 */
export async function openTab({ allowOrigin, seed = [], width = 1280, height = 900, swallow = [] }) {
  const binary = chromePath();
  if (!binary) {
    throw new Error('no Chrome found; set BOARD_CHROME');
  }
  const profile = await mkdtemp(join(tmpdir(), 'board-chrome-'));
  const proc = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    '--font-render-hinting=none', `--window-size=${width},${height}`, '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chrome gave no DevTools address: ${log.slice(-800)}`)), 30000);
    proc.on('error', reject);
    proc.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true });
  });
  const waiting = new Map();
  const handlers = [];
  let nextId = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const pending = waiting.get(msg.id);
    if (pending) {
      waiting.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    for (const h of handlers) {
      h(msg);
    }
  });
  let session;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1;
    waiting.set(nextId, { resolve, reject, method });
    ws.send(JSON.stringify({ id: nextId, method, params, ...(session ? { sessionId: session } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

  /* Page errors are evidence; a blocked request is the harness working. */
  const errors = [];
  const swallowed = [];
  /* Path to { status, body }: answered here with that JSON instead of by
   * the board, for a scene that needs an answer the board cannot give. */
  const stubs = new Map();
  handlers.push(async (msg) => {
    if (msg.sessionId !== session) {
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`uncaught: ${d.exception?.description || d.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = msg.params;
      const path = request.url.startsWith(allowOrigin) ? new URL(request.url).pathname : null;
      if (path && stubs.has(path)) {
        const { status, body } = stubs.get(path);
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: status,
          responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
        }).catch(() => {});
        return;
      }
      if (path && swallow.includes(path)) {
        swallowed.push({ method: request.method, path, body: request.postData ?? null });
        await send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [] }).catch(() => {});
        return;
      }
      const mine = path !== null;
      await send(mine ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        mine ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  for (const source of seed) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async function until(expression, ms = 15000) {
    const end = Date.now() + ms;
    while (!(await evaluate(expression).catch(() => false))) {
      if (Date.now() > end) {
        throw new Error(`timed out waiting for ${expression}`);
      }
      await sleep(50);
    }
  }

  async function navigate(url) {
    await send('Page.navigate', { url });
    await until('document.readyState === "complete"');
  }

  /*
   * The whole page, not the viewport. Chrome rasterises what is off screen
   * lazily, and a capture beyond the viewport can catch a card whose canvas
   * has not been painted yet, so the viewport is grown to the page for the
   * capture (the page sees a resize and repaints its plans), then put back.
   */
  async function screenshot() {
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    const tall = Math.min(Math.ceil(cssContentSize.height), 8000);
    await send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(height, tall), deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: tall, scale: 1 } });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    return Buffer.from(data, 'base64');
  }

  async function close() {
    ws.close();
    const gone = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
    proc.kill();
    await gone;
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  /* Script run before page scripts on the next navigations, until the
   * returned function is called. */
  async function beforePages(source) {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source });
    return () => send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }

  return { send, evaluate, until, navigate, screenshot, close, errors, swallowed, stubs, beforePages, sleep };
}
