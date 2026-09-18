import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Render the PWA icons from the same mark as `src/app/icon.svg`: a dark rounded square
 * and a volt chevron. A tiny PNG encoder (zlib is built in) keeps the repository free of
 * an image toolchain; the output is deterministic, so a re-run changes nothing.
 * `pnpm --filter @sideout/web render-icons` writes `public/icons/*.png`.
 */
const BG = [0x08, 0x09, 0x0b] as const;
const VOLT = [0xd7, 0xff, 0x3e] as const;

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** Distance from a point to a segment. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The chevron of icon.svg in a 64-unit box: (18,40) → (32,20) → (46,40), stroke 6, round caps. */
function chevronCoverage(u: number, v: number, scale: number): number {
  const d = Math.min(segmentDistance(u, v, 18, 40, 32, 20), segmentDistance(u, v, 32, 20, 46, 40));
  const edge = 3 - d;
  return Math.max(0, Math.min(1, edge * scale + 0.5));
}

function roundedSquare(u: number, v: number, radius: number, scale: number): number {
  const cx = Math.max(radius, Math.min(64 - radius, u));
  const cy = Math.max(radius, Math.min(64 - radius, v));
  const edge = radius - Math.hypot(u - cx, v - cy);
  return Math.max(0, Math.min(1, edge * scale + 0.5));
}

function render(size: number, maskable: boolean): Uint8Array {
  const scale = size / 64;
  // Maskable icons keep the mark inside the safe zone: the chevron shrinks toward the centre and the background fills the tile.
  const inset = maskable ? 0.72 : 1;
  return png(size, (x, y) => {
    const u = (x + 0.5) / scale;
    const v = (y + 0.5) / scale;
    const mu = 32 + (u - 32) / inset;
    const mv = 32 + (v - 32) / inset;
    const shape = maskable ? 1 : roundedSquare(u, v, 12, scale);
    const mark = chevronCoverage(mu, mv, scale);
    const r = Math.round(BG[0] + (VOLT[0] - BG[0]) * mark);
    const g = Math.round(BG[1] + (VOLT[1] - BG[1]) * mark);
    const b = Math.round(BG[2] + (VOLT[2] - BG[2]) * mark);
    return [r, g, b, Math.round(255 * shape)] as const;
  });
}

const out = path.resolve(import.meta.dirname, '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
] as const) {
  writeFileSync(path.join(out, name), render(size, maskable));
}
