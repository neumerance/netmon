#!/usr/bin/env node
// Generates installer/netmon.ico: the NetMon logo (three connected nodes on the accent colour, the same glyph as
// web/public/favicon.svg and the TopBar logo) rendered at 16-256 px. Pure Node, no dependencies:
// shapes are drawn with signed-distance anti-aliasing, sizes up to 48 px are stored as 32-bit BMP icon images and
// 64-256 px as PNG (the usual layout for a Windows .ico).
//
//   node installer/make-icon.mjs [out.ico]
//
// The generated file is committed; re-run this only when the logo changes.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'netmon.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Geometry in the favicon's 32x32 viewBox.
const ACCENT = [0x6e, 0x7b, 0xf2]; // --color-accent (dark theme), as in web/public/favicon.svg
const RECT_RADIUS = 7;
const NODES = [[16, 9], [9.5, 21.5], [22.5, 21.5]];
const NODE_RADIUS = 3;
const LINE_HALF_WIDTH = 1.1; // stroke-width 2.2, round caps
const LINES = [[NODES[0], NODES[1]], [NODES[0], NODES[2]], [NODES[1], NODES[2]]];

function sdRoundRect(x, y) {
  const qx = Math.abs(x - 16) - (16 - RECT_RADIUS);
  const qy = Math.abs(y - 16) - (16 - RECT_RADIUS);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RECT_RADIUS;
}

function sdSegment(x, y, [ax, ay], [bx, by]) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t);
}

function sdGlyph(x, y) {
  let d = Infinity;
  for (const [cx, cy] of NODES) d = Math.min(d, Math.hypot(x - cx, y - cy) - NODE_RADIUS);
  for (const [a, b] of LINES) d = Math.min(d, sdSegment(x, y, a, b) - LINE_HALF_WIDTH);
  return d;
}

/** RGBA pixels (top-down) for one size. */
function render(size) {
  const unitsPerPx = 32 / size;
  const cover = (d) => Math.max(0, Math.min(1, 0.5 - d / unitsPerPx));
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * unitsPerPx;
      const y = (j + 0.5) * unitsPerPx;
      const bgA = cover(sdRoundRect(x, y));
      const fgA = cover(sdGlyph(x, y)) * bgA;
      const o = (j * size + i) * 4;
      if (bgA <= 0) continue;
      // White glyph over the accent square; colour un-premultiplied by the square's coverage.
      const mix = fgA / bgA;
      px[o] = Math.round(ACCENT[0] + (255 - ACCENT[0]) * mix);
      px[o + 1] = Math.round(ACCENT[1] + (255 - ACCENT[1]) * mix);
      px[o + 2] = Math.round(ACCENT[2] + (255 - ACCENT[2]) * mix);
      px[o + 3] = Math.round(bgA * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 32-bit BGRA DIB with an (all-zero) AND mask, as stored inside .ico files. */
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4; // bottom-up
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const andMask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, xor, andMask]);
}

const images = SIZES.map((size) => {
  const rgba = render(size);
  return { size, data: size >= 64 ? png(size, rgba) : dib(size, rgba) };
});

const dir = Buffer.alloc(6 + 16 * images.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // icon
dir.writeUInt16LE(images.length, 4);
let offset = dir.length;
images.forEach(({ size, data }, i) => {
  const e = 6 + i * 16;
  dir[e] = size >= 256 ? 0 : size;
  dir[e + 1] = size >= 256 ? 0 : size;
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bpp
  dir.writeUInt32LE(data.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += data.length;
});

fs.writeFileSync(OUT, Buffer.concat([dir, ...images.map((im) => im.data)]));
console.log(`wrote ${OUT} (${SIZES.join(', ')} px, ${offset} bytes)`);

// Optional preview of the 256 px image: NETMON_ICON_PREVIEW=preview.png node installer/make-icon.mjs
if (process.env.NETMON_ICON_PREVIEW) fs.writeFileSync(process.env.NETMON_ICON_PREVIEW, png(256, render(256)));
