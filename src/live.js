/*
 * live.js: pilots on the same track see each other, through a relay.
 *
 * A WebSocket per pilot on /api/live/:trackId, a room per board track id,
 * all in memory. A client sends 24 byte frames (its clock and one ghost
 * sample, see the simulator's src/share/ghostdata.js); the relay prepends
 * the sender's peer id and hands the frame to everyone else in the room,
 * never parsing it beyond its length. Text frames are JSON control:
 * welcome (your id, and who is here), join and leave. Nothing is stored,
 * nothing is validated about poses, and when the last pilot leaves the
 * room is gone.
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

import { WebSocketServer } from 'ws';

import { normaliseName } from './validate.js';

export const LIVE_FRAME_BYTES = 24;
export const LIVE_MAX_PEERS = 16;
/* Frames above this rate are dropped, not relayed: the ghost rate is 30. */
const MAX_FRAMES_PER_SECOND = 60;

const TRACK_RE = /^trk-[0-9a-f]{8}$/;

export function liveRoute(pathname) {
  const m = pathname.match(/^\/api\/live\/(trk-[0-9a-f]{8})$/);
  return m && TRACK_RE.test(m[1]) ? m[1] : null;
}

export function attachLive(server, store) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const rooms = new Map(); /* trackId -> Map<peerId, { ws, name }> */
  const nextId = new Map(); /* trackId -> next peer id */

  function roster(room) {
    return [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
  }

  function broadcast(room, except, data) {
    for (const [id, p] of room) {
      if (id !== except && p.ws.readyState === p.ws.OPEN) {
        p.ws.send(data);
      }
    }
  }

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      socket.destroy();
      return;
    }
    const trackId = liveRoute(url.pathname);
    if (!trackId) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const published = await store.getDocument(trackId);
    if (!published) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const name = normaliseName(url.searchParams.get('name') || '') || 'Pilot';
    wss.handleUpgrade(req, socket, head, (ws) => {
      let room = rooms.get(trackId);
      if (!room) {
        room = new Map();
        rooms.set(trackId, room);
      }
      if (room.size >= LIVE_MAX_PEERS) {
        ws.close(1013, 'room full');
        return;
      }
      const id = ((nextId.get(trackId) || 0) % 65535) + 1;
      nextId.set(trackId, id);
      room.set(id, { ws, name });
      ws.send(JSON.stringify({ type: 'welcome', id, peers: roster(room).filter((p) => p.id !== id) }));
      broadcast(room, id, JSON.stringify({ type: 'join', id, name }));

      let windowStart = Date.now();
      let inWindow = 0;
      ws.on('message', (data, isBinary) => {
        if (!isBinary || data.length !== LIVE_FRAME_BYTES) {
          return;
        }
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          inWindow = 0;
        }
        inWindow += 1;
        if (inWindow > MAX_FRAMES_PER_SECOND) {
          return;
        }
        const out = Buffer.allocUnsafe(2 + LIVE_FRAME_BYTES);
        out.writeUInt16LE(id, 0);
        data.copy(out, 2);
        broadcast(room, id, out);
      });
      ws.on('close', () => {
        room.delete(id);
        if (room.size === 0) {
          rooms.delete(trackId);
        } else {
          broadcast(room, id, JSON.stringify({ type: 'leave', id }));
        }
      });
      ws.on('error', () => {});
    });
  });

  return { rooms };
}
