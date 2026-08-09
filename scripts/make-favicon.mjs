#!/usr/bin/env node
// Draws 27B's tab icon, and writes both files the browser might ask for.
//
// The mark is the plan drawing the app itself puts beside every result, reduced
// until it still reads at 16 px: a building footprint, a standoff, and the eye
// at the end of it. Nothing else fits, and a "27B" wordmark at this size is a
// grey smudge.
//
// It is generated rather than hand-drawn so the two files cannot disagree: the
// grids below are the only description of the mark, the SVG and the ICO are
// both emitted from them, and re-running this is the way to change it.
//
// Each size is drawn at its own resolution rather than downsampled from one
// master, because a 1 px hairline scaled from 32 to 16 becomes two rows of
// grey. Run:  node apps/27b/scripts/make-favicon.mjs
//
// PNG here is ~40 lines of zlib and CRC because Node ships both; an image
// library for one 32x32 icon would be the larger dependency by several orders
// of magnitude. ICO carries PNG payloads directly (supported since Windows
// Vista), so the same bytes serve both entries.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");

/** The app's own ground and ink (src/index.css --bg and --text). */
const GROUND = [0x0b, 0x0b, 0x0c, 0xff];
const INK = [0xee, 0xf0, 0xf3, 0xff];
/** The declared project accent (config/site.ts), on the eye only. */
const EYE = [0x5d, 0x7a, 0x91, 0xff];

/**
 * The mark at each size, in whole pixels: an open footprint, a standoff running
 * out of its east face, and the camera at the end of it.
 */
const GRIDS = {
  16: {
    footprint: { x: 2, y: 3, w: 8, h: 10, stroke: 1 },
    ray: { x0: 10, x1: 12, y: 8, stroke: 1 },
    eye: { x: 13, y: 7, w: 2, h: 2 },
  },
  32: {
    footprint: { x: 4, y: 6, w: 16, h: 20, stroke: 2 },
    ray: { x0: 20, x1: 25, y: 15, stroke: 2 },
    eye: { x: 26, y: 14, w: 4, h: 4 },
  },
};

function draw(size) {
  const g = GRIDS[size];
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    px.set(c, (y * size + x) * 4);
  };
  const fill = (x, y, w, h, c) => {
    for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) set(i, j, c);
  };

  fill(0, 0, size, size, GROUND);

  // Footprint: an outline, because the plan drawing draws it as one.
  const { x, y, w, h, stroke } = g.footprint;
  fill(x, y, w, stroke, INK);
  fill(x, y + h - stroke, w, stroke, INK);
  fill(x, y, stroke, h, INK);
  fill(x + w - stroke, y, stroke, h, INK);

  fill(g.ray.x0, g.ray.y, g.ray.x1 - g.ray.x0, g.ray.stroke, INK);
  fill(g.eye.x, g.eye.y, g.eye.w, g.eye.h, EYE);

  return px;
}

// ---- PNG ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline, filter type 0 — the image is flat colour, so
  // nothing more elaborate would compress it further.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO ------------------------------------------------------------------

function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    dir[at] = e.size === 256 ? 0 : e.size;
    dir[at + 1] = e.size === 256 ? 0 : e.size;
    dir[at + 2] = 0; // palette size: none
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32BE(0, at + 8);
    dir.writeUInt32LE(e.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---- SVG ------------------------------------------------------------------

function svg() {
  const g = GRIDS[32];
  const hex = (c) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  const r = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  const { x, y, w, h, stroke } = g.footprint;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">`,
    r(0, 0, 32, 32, hex(GROUND)),
    r(x, y, w, stroke, hex(INK)),
    r(x, y + h - stroke, w, stroke, hex(INK)),
    r(x, y, stroke, h, hex(INK)),
    r(x + w - stroke, y, stroke, h, hex(INK)),
    r(g.ray.x0, g.ray.y, g.ray.x1 - g.ray.x0, g.ray.stroke, hex(INK)),
    r(g.eye.x, g.eye.y, g.eye.w, g.eye.h, hex(EYE)),
    `</svg>`,
  ].join("");
}

mkdirSync(PUBLIC, { recursive: true });
writeFileSync(
  join(PUBLIC, "favicon.ico"),
  ico([16, 32].map((size) => ({ size, data: png(size, draw(size)) }))),
);
writeFileSync(join(PUBLIC, "favicon.svg"), svg() + "\n");
console.error(`wrote ${join(PUBLIC, "favicon.ico")} and favicon.svg`);
