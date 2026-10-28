// Run from workspace root: node artifacts/labtrax-desktop/scripts/build-tooth-atlas-exocad.cjs
// Source: attached_assets/0_OneDrive_1_10-22-2026_1792686657257.zip -> "Screenshot (3).png" (3840x2160, gray occlusal teeth).
// Output: artifacts/labtrax-desktop/public/tooth-atlas-<role>.png (8x4 cells of 104px) + tooth-atlas.provenance.json.
// LIMITS: crops are elliptical windows around each screenshot tooth (neighbour slivers possible); the printed number is
// inpainted out of the dark pixels near the tooth centre (may thin a central groove); tooth 2 (red/highlighted in the source)
// is a mirrored tooth 15; mirrored teeth 1..16 only exist as drawn. Role tints are baked from luminance so grooves/outlines stay dark.
const sharp = require("sharp"); const { execSync } = require("child_process"); const fs = require("fs"); const path = require("path");
const root = process.cwd(); const out = path.join(root, "artifacts/labtrax-desktop/public");
const zip = path.join(root, "attached_assets/0_OneDrive_1_10-22-2026_1792686657257.zip");
fs.mkdirSync("/tmp/exo", { recursive: true });
execSync(`unzip -o -j "${zip}" "Screenshot (3).png" -d /tmp/exo`);
const SRC = "/tmp/exo/Screenshot (3).png"; const K = 3.75, WIN = 40, CELL = 104; // display px -> src px
const C = {1:[524,283],2:null,3:[528,216],4:[533,189],5:[541,167],6:[555,147],7:[573,131],8:[599,126],9:[627,126],10:[651,131],11:[670,147],12:[685,167],13:[693,189],14:[697,216],15:[701,251],16:[701,283],17:[699,326],18:[695,360],19:[690,395],20:[683,427],21:[673,450],22:[659,469],23:[642,481],24:[624,486],25:[603,486],26:[583,481],27:[567,469],28:[552,450],29:[543,427],30:[535,396],31:[528,360],32:[526,326]};
const RAD = (n) => { const p = n <= 16 ? n : 33 - n; const q = p <= 8 ? p : 17 - p; return q <= 3 ? [19, 18] : q <= 5 ? [15, 15] : q === 6 ? [14, 16] : [14, 13]; };
const TINT = { unassigned: null, crown: [150, 40, 190], pontic: [112, 14, 46], veneer: [30, 140, 160], missing: [175, 178, 186] };
async function crop(n, raw, W) {
  const c = C[n]; const S = Math.round(WIN * K); const x0 = Math.round(c[0] * K - S / 2), y0 = Math.round(c[1] * K - S / 2);
  const px = new Uint8Array(S * S * 4); const rx = RAD(n)[0] * K * 1.3, ry = RAD(n)[1] * K * 1.3;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const s = ((y0 + y) * W + x0 + x) * 4, d = (y * S + x) * 4; for (let k = 0; k < 4; k++) px[d + k] = raw[s + k]; px[d + 3] = (((x - S / 2) / rx) ** 2 + ((y - S / 2) / ry) ** 2 <= 1) ? 255 : 0; }
  const lum = (i) => (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  // inpaint number
  const fills = []; const bx = 11 * K, by = 8 * K;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.abs(x - S / 2) < bx && Math.abs(y - S / 2) < by && lum(y * S + x) > 185 && lum(y * S + x) < 235) fills.push(lum(y * S + x));
  fills.sort((a, b) => a - b); const fl = fills.length ? fills[fills.length >> 1] : 205;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.abs(x - S / 2) < bx && Math.abs(y - S / 2) < by && (lum(y * S + x) < 170 || lum(y * S + x) > 232) && Math.hypot((x - S / 2) / 1.3, (y - S / 2)) < 8 * K) { const d = (y * S + x) * 4; px[d] = px[d + 1] = px[d + 2] = fl; }
  // connected-component segmentation: flood the light-gray fill from the tooth centre (dark outlines are barriers),
  // then grow 3px so the dark outline/grooves bordering that fill are retained, then fill enclosed holes.
  const T = 165, isFill = (i) => px[i * 4 + 3] > 0 && lum(i) >= T && Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) <= 238;
  const R = new Uint8Array(S * S), q = []; const c0 = (S >> 1) * S + (S >> 1);
  if (isFill(c0)) { R[c0] = 1; q.push(c0); }
  while (q.length) { const i = q.pop(), x = i % S, y = (i / S) | 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + a, yy = y + b; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue; const j = yy * S + xx; if (!R[j] && isFill(j)) { R[j] = 1; q.push(j); } } }
  for (let it = 0; it < 4; it++) { const add = []; for (let i = 0; i < S * S; i++) { if (R[i]) continue; const x = i % S, y = (i / S) | 0; if (px[i * 4 + 3] === 0 || Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) > 238) continue; if (lum(i) >= T && it > 0) continue; if ((x > 0 && R[i - 1]) || (x < S - 1 && R[i + 1]) || (y > 0 && R[i - S]) || (y < S - 1 && R[i + S])) add.push(i); } for (const i of add) R[i] = 1; }
  const out = new Uint8Array(S * S); const q2 = [];
  for (let i = 0; i < S * S; i++) { const x = i % S, y = (i / S) | 0; if ((x === 0 || y === 0 || x === S - 1 || y === S - 1) && !R[i]) { out[i] = 1; q2.push(i); } }
  while (q2.length) { const i = q2.pop(), x = i % S, y = (i / S) | 0; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + a, yy = y + b; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue; const j = yy * S + xx; if (!R[j] && !out[j]) { out[j] = 1; q2.push(j); } } }
  const cx = RAD(n)[0] * K * 1.08, cy = RAD(n)[1] * K * 1.08;
  for (let i = 0; i < S * S; i++) { const x = i % S, y = (i / S) | 0; px[i * 4 + 3] = out[i] || (((x - S / 2) / cx) ** 2 + ((y - S / 2) / cy) ** 2 > 1) ? 0 : 255; }
  return { px, S };
}
(async () => {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cells = {};
  for (let n = 1; n <= 32; n++) { if (n === 2) continue; cells[n] = await crop(n, data, info.width); }
  const m = cells[15]; const f = new Uint8Array(m.px.length);
  for (let y = 0; y < m.S; y++) for (let x = 0; x < m.S; x++) for (let k = 0; k < 4; k++) f[(y * m.S + x) * 4 + k] = m.px[(y * m.S + (m.S - 1 - x)) * 4 + k];
  cells[2] = { px: f, S: m.S };
  for (const role of Object.keys(TINT)) {
    const comps = [];
    for (let n = 1; n <= 32; n++) {
      const { px, S } = cells[n]; const o = Buffer.from(px); const t = TINT[role];
      if (t) for (let i = 0; i < S * S; i++) { const L = Math.min(1, (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3 / 210); for (let k = 0; k < 3; k++) o[i * 4 + k] = role === "missing" ? Math.round(t[k] * (0.55 + 0.45 * L)) : Math.round(t[k] * (0.25 + 0.75 * L) + (L > 0.9 ? 12 * (1 - 0) : 0)); if (role === "missing") o[i * 4 + 3] = Math.round(o[i * 4 + 3] * 0.6); }
      const buf = await sharp(o, { raw: { width: S, height: S, channels: 4 } }).resize(CELL, CELL).png().toBuffer();
      comps.push({ input: buf, left: ((n - 1) % 8) * CELL, top: Math.floor((n - 1) / 8) * CELL });
    }
    await sharp({ create: { width: CELL * 8, height: CELL * 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comps).png().toFile(path.join(out, `tooth-atlas-${role}.png`));
  }
  fs.writeFileSync(path.join(out, "tooth-atlas.provenance.json"), JSON.stringify({ source: "attached_assets/0_OneDrive_1_10-22-2026_1792686657257.zip :: Screenshot (3).png", generator: "scripts/build-tooth-atlas-exocad.cjs", window: `${WIN} display px (x${K})`, cell: CELL, mirrored: { 2: "15" }, roles: Object.keys(TINT), note: "number glyph inpainted; role tints baked from luminance" }, null, 2));
  console.log("done");
})();
