/*
 * png.js: read the PNGs Chrome writes, and compare two of them.
 *
 * Only what a Chrome screenshot uses: 8 bit RGB or RGBA, not interlaced.
 * Anything else throws rather than being misread.
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
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colour];
      if (depth !== 8 || !channels || interlace) {
        throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      }
    } else if (type === 'IDAT') {
      data.push(body);
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4, 255);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let pred = 0;
      if (filter === 1) {
        pred = a;
      } else if (filter === 2) {
        pred = b;
      } else if (filter === 3) {
        pred = (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      line[i] = (src[i] + pred) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      line.copy(out, (y * width + x) * 4, x * channels, x * channels + Math.min(channels, 4));
    }
    line.copy(prev);
  }
  return { width, height, pixels: out };
}

/*
 * How far apart two screenshots are: the share of pixels where any channel
 * differs by more than `slack`. Different sizes are reported as such,
 * because a page that grew or shrank is a difference however it looks.
 */
export function comparePng(a, b, slack = 24) {
  const x = decodePng(a);
  const y = decodePng(b);
  if (x.width !== y.width || x.height !== y.height) {
    return { sameSize: false, sizes: [`${x.width}x${x.height}`, `${y.width}x${y.height}`], share: 1 };
  }
  let off = 0;
  for (let i = 0; i < x.pixels.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      if (Math.abs(x.pixels[i + k] - y.pixels[i + k]) > slack) {
        off += 1;
        break;
      }
    }
  }
  return { sameSize: true, share: off / (x.width * x.height), pixels: off };
}
