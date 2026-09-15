/**
 * Generate the Open Graph share image.
 *
 * WHY HAND-ROLLED
 * ---------------
 * An og:image that 404s is worse than having none, and adding a rasteriser
 * (sharp, resvg) to render one static asset is a heavy dependency for a build
 * step that runs once. Node has zlib built in, so a minimal PNG encoder plus a
 * block wordmark covers it in a couple of hundred lines with no dependencies at
 * all.
 *
 * The design is deliberately typographic and geometric rather than photographic:
 * a wordmark, an accent rule and a stylised price series. Block letterforms are
 * defined as bitmaps, which is why only "STRIKE" is rendered as text — a full
 * font would be far more code for no benefit on a single image.
 *
 *   node tools/make-og-image.mjs
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* PNG encoding                                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode an RGB pixel buffer (width*height*3) as a PNG. */
function encodePng(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

function makeCanvas(width, height) {
  const px = Buffer.alloc(width * height * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const get = (x, y) => {
    const i = (y * width + x) * 3;
    return [px[i], px[i + 1], px[i + 2]];
  };

  /** Alpha-blend a colour over the canvas. */
  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height || a <= 0) return;
    if (a >= 1) return set(x, y, r, g, b);
    const [or, og, ob] = get(x, y);
    set(
      x, y,
      Math.round(or + (r - or) * a),
      Math.round(og + (g - og) * a),
      Math.round(ob + (b - ob) * a)
    );
  };

  const fillRect = (x0, y0, w, h, r, g, b, a = 1) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) blend(x, y, r, g, b, a);
  };

  /** Rounded rectangle, corners approximated by a per-row inset. */
  const fillRoundRect = (x0, y0, w, h, rad, r, g, b, a = 1) => {
    for (let y = 0; y < h; y++) {
      const dy = y < rad ? rad - y : y >= h - rad ? y - (h - rad - 1) : 0;
      const inset = dy > 0 ? Math.round(rad - Math.sqrt(Math.max(0, rad * rad - dy * dy))) : 0;
      for (let x = inset; x < w - inset; x++) blend(x0 + x, y0 + y, r, g, b, a);
    }
  };

  const linearGradient = (from, to) => {
    for (let y = 0; y < height; y++) {
      const t = y / (height - 1);
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      for (let x = 0; x < width; x++) set(x, y, r, g, b);
    }
  };

  /** Soft radial glow, used to lift the top-right corner. */
  const radialGlow = (cx, cy, radius, r, g, b, peak) => {
    for (let y = Math.max(0, cy - radius); y < Math.min(height, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x < Math.min(width, cx + radius); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const t = 1 - d / radius;
        blend(x, y, r, g, b, t * t * peak);
      }
    }
  };

  return { px, width, height, set, get, blend, fillRect, fillRoundRect, linearGradient, radialGlow };
}

/* ------------------------------------------------------------------ */
/* Block wordmark — only the glyphs the wordmark needs                 */
/* ------------------------------------------------------------------ */

const GLYPHS = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
};

function drawWordmark(c, text, x0, y0, scale, r, g, b) {
  let x = x0;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < glyph.length; gy++) {
        for (let gx = 0; gx < glyph[gy].length; gx++) {
          if (glyph[gy][gx] === "1") {
            c.fillRect(x + gx * scale, y0 + gy * scale, scale, scale, r, g, b);
          }
        }
      }
    }
    x += 6 * scale; // 5 wide + 1 gap
  }
  return x - scale;
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

const W = 1200;
const H = 630;

const c = makeCanvas(W, H);

// Background: deep navy gradient, matching the app's dark theme tokens.
c.linearGradient([10, 15, 30], [17, 24, 39]);
c.radialGlow(980, 120, 620, 0, 194, 255, 0.22);
c.radialGlow(180, 560, 520, 0, 119, 182, 0.18);

// Accent rule along the top edge.
c.fillRect(0, 0, W, 6, 0, 194, 255);

// Stylised price series: bars rising then spiking, echoing the product's subject.
const bars = [0.30, 0.42, 0.34, 0.52, 0.46, 0.62, 0.55, 0.74, 0.68, 1.0, 0.58, 0.44];
const chartX = 96;
const chartBase = 470;
const chartMaxH = 190;
const barW = 34;
const gap = 22;
bars.forEach((v, i) => {
  const h = Math.round(v * chartMaxH);
  const isSpike = v === 1.0;
  const x = chartX + i * (barW + gap);
  if (isSpike) {
    c.fillRoundRect(x, chartBase - h, barW, h, 10, 255, 176, 32, 1);
  } else {
    c.fillRoundRect(x, chartBase - h, barW, h, 10, 0, 194, 255, 0.30 + v * 0.45);
  }
});

// Wordmark.
const markEnd = drawWordmark(c, "STRIKE", 96, 150, 18, 248, 250, 252);

// Underline tying the wordmark together.
c.fillRect(96, 300, markEnd - 96, 5, 0, 194, 255);

// Baseline under the bars.
c.fillRect(96, chartBase + 14, W - 96 * 2, 2, 71, 85, 105);

const out = encodePng(W, H, c.px);
const dest = path.resolve(process.cwd(), "web", "public", "og-image.png");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);

console.log(`Wrote ${path.relative(process.cwd(), dest)}  ${W}x${H}  ${(out.length / 1024).toFixed(1)} KB`);
console.log(`PNG signature ok: ${out.slice(0, 8).toString("hex") === "89504e470d0a1a0a"}`);
