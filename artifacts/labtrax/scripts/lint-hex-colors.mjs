#!/usr/bin/env node
/**
 * Hex-literal guard for the LabTrax mobile app.
 *
 * The app uses a semantic design-token system (`constants/colors.ts` exposed via
 * `useTheme()`). Screen/component code must use `colors.*` tokens, NOT raw hex
 * literals, so both light and dark themes stay consistent.
 *
 * This guard scans `app/**` and `components/**` for quoted hex color literals and
 * fails on any that are not explicitly allowed. Run it with:
 *   pnpm --filter @workspace/labtrax run lint:hex
 *
 * Allowed exceptions (kept deliberately small):
 *  1. FILE_ALLOWLIST — files that legitimately cannot use theme tokens:
 *     - render BEFORE the ThemeProvider mounts (auth gate / error boundary), or
 *     - are intentionally fixed-dark media surfaces (full-screen image/3D viewers), or
 *     - carry a fixed third-party brand palette (Messenger).
 *  2. `#000` / `#000000` — pure-black shadow colors and modal scrims (theme-independent).
 *  3. Any line carrying a trailing `hex-allow` marker comment — for one-off fixed-dark
 *     accents (camera backdrops, dark gradients) that have no sensible semantic token.
 *     Each such line documents WHY next to the marker.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN_DIRS = ["app", "components"];

const FILE_ALLOWLIST = new Set([
  // Render before ThemeProvider (no `colors` available)
  "app/_layout.tsx",
  "components/LoginScreen.tsx",
  "components/LockScreen.tsx",
  "components/ErrorFallback.tsx",
  // Intentionally fixed-dark media surfaces (always dark regardless of theme)
  "components/ScanViewerModal.tsx",
  "components/StlViewerModal.tsx",
  // Fixed third-party brand palette (Facebook Messenger)
  "components/ChatButton.tsx",
]);

// Pure black shadow/scrim values are theme-independent and always allowed.
const ALWAYS_OK = new Set(["#000", "#000000"]);

const ALLOW_MARKER = "hex-allow";
const HEX_RE = /["'`]#[0-9a-fA-F]{3,8}["'`]/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];
for (const sub of SCAN_DIRS) {
  const base = join(ROOT, sub);
  let files;
  try {
    files = walk(base);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (FILE_ALLOWLIST.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(ALLOW_MARKER)) return;
      const matches = line.match(HEX_RE);
      if (!matches) return;
      for (const m of matches) {
        const hex = m.slice(1, -1).toLowerCase();
        if (ALWAYS_OK.has(hex)) continue;
        violations.push({ rel, line: i + 1, hex: m, text: line.trim() });
      }
    });
  }
}

if (violations.length) {
  console.error(`\n✖ Found ${violations.length} raw hex color literal(s) in app/** + components/**.`);
  console.error(`  Replace each with a semantic theme token (colors.* from useTheme()).`);
  console.error(`  Genuine fixed-dark/brand exceptions: add a trailing "${ALLOW_MARKER}" comment with a reason,`);
  console.error(`  or add the file to FILE_ALLOWLIST in scripts/lint-hex-colors.mjs.\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.hex}\n      ${v.text}`);
  }
  console.error("");
  process.exit(1);
}

console.log("✓ No disallowed raw hex color literals in app/** + components/**.");
