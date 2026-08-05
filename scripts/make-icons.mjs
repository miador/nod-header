#!/usr/bin/env node
/**
 * Nod Header brand mark — vector source and toolbar PNGs from one description.
 *
 * Usage: node scripts/make-icons.mjs [--out=DIR]
 *
 * Zero dependencies: the PNGs are encoded by hand (IHDR / IDAT / IEND, filter-0
 * scanlines through node:zlib) and rasterised by supersampling a flattened
 * outline, so the geometry below is the single source of truth for every size
 * and for icon.svg.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── geometry ───────────────────────────────────────────────────────────────
// Coordinates live in the 61x70 viewBox of the #i-mark symbol in
// src/popup/popup.html, which is the reference for the mark. Nothing here is
// tied to a pixel size; a transform maps this space onto each canvas.

export const VIEW = { w: 61, h: 70 };

/**
 * Shield with a flat top and a rounded point at the bottom. Every 'A' segment
 * in this mark is an SVG arc with rx = ry and flags 0 0 0, so one radius is
 * enough to describe it.
 */
const SHIELD = [
  ['M', 30.5, 0.9],
  ['L', 6.1, 8.2],
  ['A', 5.2, 2.4, 13.2],
  ['L', 2.4, 35.6],
  ['C', 2.4, 51.2, 14.6, 62.7, 28.8, 68.7],
  ['A', 4.5, 32.2, 68.7],
  ['C', 46.4, 62.7, 58.6, 51.2, 58.6, 35.6],
  ['L', 58.6, 13.2],
  ['A', 5.2, 54.9, 8.2],
  ['Z'],
];

/**
 * Three white bars, matching the #i-mark symbol in popup.html and options.html
 * exactly. The short bar is a shade left of the other two, as in the reference
 * design, so it is not centred on the shield axis.
 */
const BARS = [
  { x: 15.5, y: 19.5, w: 30, h: 5.4, r: 2.7 },
  { x: 15.5, y: 31.5, w: 30, h: 5.4, r: 2.7 },
  { x: 19.5, y: 44.5, w: 20, h: 5.4, r: 2.7 },
];

/** Diagonal fill, matching the popup sprite's linearGradient. */
const STOPS = [
  { at: 0, rgb: [0x57, 0xa3, 0xfe] },
  { at: 0.55, rgb: [0x2c, 0x7c, 0xf6] },
  { at: 1, rgb: [0x1a, 0x66, 0xe6] },
];

export const ICON_SIZES = [16, 32, 48, 128];

/** Kept small so the mark still reads at 16px. */
const MARGIN = 0.04;
const SAMPLES = 8;

// ── path flattening ────────────────────────────────────────────────────────

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * SVG endpoint parameterisation to a circular arc (spec F.6.5, rx = ry).
 * Both flags are 0 for every arc in this mark, which fixes the centre to the
 * far side of the chord and the sweep to the short way round.
 */
function arcParams(p0, p1, r) {
  const hx = (p0.x - p1.x) / 2;
  const hy = (p0.y - p1.y) / 2;
  const len = hx * hx + hy * hy;
  const radius = Math.max(r, Math.sqrt(len));
  const k = Math.sqrt(Math.max(0, (radius * radius - len) / len));
  const cx = (p0.x + p1.x) / 2 - k * hy;
  const cy = (p0.y + p1.y) / 2 + k * hx;
  const from = Math.atan2(p0.y - cy, p0.x - cx);
  let to = Math.atan2(p1.y - cy, p1.x - cx);
  while (to > from) to -= Math.PI * 2;
  return { cx, cy, r: radius, from, to };
}

function arcPoints(poly, cx, cy, r, from, to, steps) {
  for (let i = 1; i <= steps; i += 1) {
    const a = from + (to - from) * (i / steps);
    poly.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
}

/** A polygon needs three points to enclose anything. Anything less is dropped. */
function closePoly(st) {
  if (st.poly && st.poly.length > 2) st.polys.push(st.poly);
}

/** One path segment, flattened onto the polygon being built. */
function addSegment(st, seg, steps) {
  const op = seg[0];
  if (op === 'M') {
    closePoly(st);
    st.cur = { x: seg[1], y: seg[2] };
    st.first = st.cur;
    st.poly = [st.cur];
  } else if (op === 'L') {
    st.cur = { x: seg[1], y: seg[2] };
    st.poly.push(st.cur);
  } else if (op === 'C') {
    const p1 = { x: seg[1], y: seg[2] };
    const p2 = { x: seg[3], y: seg[4] };
    const p3 = { x: seg[5], y: seg[6] };
    const n = steps(dist(st.cur, p1) + dist(p1, p2) + dist(p2, p3), 8);
    for (let i = 1; i <= n; i += 1) st.poly.push(cubicAt(st.cur, p1, p2, p3, i / n));
    st.cur = p3;
  } else if (op === 'A') {
    const p1 = { x: seg[2], y: seg[3] };
    const a = arcParams(st.cur, p1, seg[1]);
    arcPoints(st.poly, a.cx, a.cy, a.r, a.from, a.to, steps(a.r * Math.abs(a.to - a.from), 6));
    st.cur = p1;
  } else if (op === 'Z') {
    closePoly(st);
    st.poly = null;
    st.cur = st.first;
  }
}

/** Closed polygons in view units. `scale` only sets how fine the flattening is. */
function flattenPath(segs, scale) {
  const steps = (length, min) => Math.min(256, Math.max(min, Math.ceil(length * scale / 1.5)));
  const st = { polys: [], poly: null, cur: { x: 0, y: 0 }, first: { x: 0, y: 0 } };
  for (const seg of segs) addSegment(st, seg, steps);
  closePoly(st);
  return st.polys;
}

function roundRectPoly(bar, scale) {
  const r = Math.min(bar.r, bar.w / 2, bar.h / 2);
  const n = Math.min(64, Math.max(4, Math.ceil(r * scale)));
  const x2 = bar.x + bar.w;
  const y2 = bar.y + bar.h;
  const poly = [{ x: bar.x + r, y: bar.y }, { x: x2 - r, y: bar.y }];
  const half = Math.PI / 2;
  arcPoints(poly, x2 - r, bar.y + r, r, -half, 0, n);
  poly.push({ x: x2, y: y2 - r });
  arcPoints(poly, x2 - r, y2 - r, r, 0, half, n);
  poly.push({ x: bar.x + r, y: y2 });
  arcPoints(poly, bar.x + r, y2 - r, r, half, Math.PI, n);
  poly.push({ x: bar.x, y: bar.y + r });
  arcPoints(poly, bar.x + r, bar.y + r, r, Math.PI, Math.PI * 1.5, n);
  return poly;
}

// ── rasteriser ─────────────────────────────────────────────────────────────

function bboxOf(polys) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < x1) x1 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x;
      if (p.y > y2) y2 = p.y;
    }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const mapPolys = (polys, tf) => polys.map((poly) => poly.map(tf));

/** Where the polygon edges cross the scanline at `y`, collected into `xs`. */
function crossings(polys, y, xs) {
  xs.length = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
  }
  return xs;
}

/** The samples between each pair of crossings, added to one row of coverage. */
function fillSpans(cov, xs, row, cols, weight) {
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const from = Math.max(0, Math.ceil(xs[i] * SAMPLES - 0.5));
    const to = Math.min(cols, Math.ceil(xs[i + 1] * SAMPLES - 0.5));
    for (let sx = from; sx < to; sx += 1) cov[row + Math.floor(sx / SAMPLES)] += weight;
  }
}

/** Even-odd scanline fill, SAMPLES x SAMPLES per pixel, into 0..1 coverage. */
function rasterize(polys, size) {
  const cov = new Float64Array(size * size);
  const weight = 1 / (SAMPLES * SAMPLES);
  const rows = size * SAMPLES;
  const cols = size * SAMPLES;
  const xs = [];

  for (let sy = 0; sy < rows; sy += 1) {
    const y = (sy + 0.5) / SAMPLES;
    crossings(polys, y, xs);
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    fillSpans(cov, xs, Math.floor(sy / SAMPLES) * size, cols, weight);
  }
  return cov;
}

function gradientColor(t) {
  const u = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i += 1) {
    const a = STOPS[i - 1];
    const b = STOPS[i];
    if (u <= b.at) {
      const f = b.at === a.at ? 0 : (u - a.at) / (b.at - a.at);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return STOPS.at(-1).rgb.slice();
}

/** RGBA bytes for one square canvas. */
function renderMark(size) {
  const scale = size / VIEW.h;
  const shieldView = flattenPath(SHIELD, scale * SAMPLES);
  const barsView = BARS.map((bar) => roundRectPoly(bar, scale * SAMPLES));

  const box = bboxOf(shieldView);
  const margin = size * MARGIN;
  const s = (size - margin * 2) / Math.max(box.w, box.h);
  const ox = (size - box.w * s) / 2 - box.x * s;
  const oy = (size - box.h * s) / 2 - box.y * s;
  const tf = (p) => ({ x: p.x * s + ox, y: p.y * s + oy });

  const shield = rasterize(mapPolys(shieldView, tf), size);
  const bars = rasterize(mapPolys(barsView, tf), size);

  // Gradient runs along the shield's own box, as objectBoundingBox does in SVG.
  const gx = box.x * s + ox;
  const gy = box.y * s + oy;
  const gw = box.w * s;
  const gh = box.h * s;

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const alpha = Math.min(1, shield[i]);
      if (alpha <= 0) continue;
      const t = ((x + 0.5 - gx) / gw + (y + 0.5 - gy) / gh) / 2;
      const rgb = gradientColor(t);
      const bar = Math.min(1, bars[i] / alpha);
      const o = i * 4;
      out[o] = Math.round(rgb[0] + (255 - rgb[0]) * bar);
      out[o + 1] = Math.round(rgb[1] + (255 - rgb[1]) * bar);
      out[o + 2] = Math.round(rgb[2] + (255 - rgb[2]) * bar);
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ── PNG encoder ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Shared with the zip writer in build.mjs — same polynomial, same table. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const element of bytes) c = CRC_TABLE[(c ^ element) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0, none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── SVG source ─────────────────────────────────────────────────────────────

const num = (n) => String(Number(n.toFixed(3)));

function pathData(segs) {
  return segs.map((seg) => {
    if (seg[0] === 'A') return `A${num(seg[1])} ${num(seg[1])} 0 0 0 ${num(seg[2])} ${num(seg[3])}`;
    if (seg[0] === 'Z') return 'Z';
    return seg[0] + seg.slice(1).map(num).join(' ');
  }).join(' ');
}

export function svgSource() {
  const stops = STOPS
    .map((s) => `      <stop offset="${num(s.at)}" stop-color="#${s.rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}"/>`)
    .join('\n');
  const bars = BARS
    .map((b) => `  <rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" rx="${num(b.r)}" fill="#fff"/>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" width="${VIEW.w}" height="${VIEW.h}" role="img" aria-label="Nod Header">
  <title>Nod Header</title>
  <defs>
    <linearGradient id="fx-shield-grad" x1="0" y1="0" x2="1" y2="1">
${stops}
    </linearGradient>
  </defs>
  <path fill="url(#fx-shield-grad)" d="${pathData(SHIELD)}"/>
${bars}
</svg>
`;
}

// ── entry point ────────────────────────────────────────────────────────────

export const iconName = (size) => `icon-${size}.png`;

/** Writes icon.svg and every PNG size into `dir`. Returns the file names. */
export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'icon.svg'), svgSource());
  const written = ['icon.svg'];
  for (const size of ICON_SIZES) {
    const name = iconName(size);
    writeFileSync(join(dir, name), encodePng(size, renderMark(size)));
    written.push(name);
  }
  return written;
}

function main(argv) {
  const outArg = argv.find((a) => a.startsWith('--out='));
  const dir = outArg
    ? outArg.slice(6)
    : join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'assets');
  const written = writeIcons(dir);
  console.log(`Nod Header icons -> ${dir}`);
  for (const name of written) console.log(`  ${name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
