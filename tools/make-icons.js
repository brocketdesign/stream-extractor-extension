/**
 * Generates the extension icons: a red rounded square with a white play
 * triangle. Written by hand as raw PNG chunks so the repo needs no image
 * tooling or dependencies. Run: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Rounded-square mask + centred play triangle, both anti-aliased by 3x3
// supersampling so the small sizes stay legible.
function icon(x, y, size) {
  const r = size * 0.22;
  let inside = 0, tri = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const cx = Math.min(Math.max(px, r), size - r);
      const cy = Math.min(Math.max(py, r), size - r);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) inside++;

      // Triangle with vertices (.36,.28) (.36,.72) (.72,.50), in unit space.
      const ux = px / size, uy = py / size;
      if (ux >= 0.36 && ux <= 0.72) {
        const half = 0.22 * (1 - (ux - 0.36) / 0.36);
        if (Math.abs(uy - 0.5) <= half) tri++;
      }
    }
  }
  const alpha = Math.round((inside / 9) * 255);
  if (!alpha) return [0, 0, 0, 0];
  const t = tri / 9;
  const mix = (bg, fg) => Math.round(bg * (1 - t) + fg * t);
  return [mix(0xc0, 0xff), mix(0x39, 0xff), mix(0x2b, 0xff), alpha];
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, icon));
  console.log('wrote', path.relative(process.cwd(), file), fs.statSync(file).size, 'bytes');
}
