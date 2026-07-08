import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * React Native's global `fetch` has NO streaming response body: on a real
 * device `resp.body` is `null` even on a 200 response, so any
 * `resp.body.getReader()` consumer silently breaks. The failure is invisible
 * to every test surface — web preview, vitest, and the server all work —
 * because only the on-device RN fetch lacks streaming. This already caused a
 * production outage in the AI assistant's SSE stream.
 *
 * The fix is that every streamed response MUST come from `expo/fetch`
 * (WinterCG-compliant, streams on iOS/Android). This test scans the mobile
 * app source and fails CI if any `.getReader()` consumer is fed by global
 * fetch (or anything other than the `expo/fetch` import) so a future
 * refactor back to bare fetch fails here instead of breaking devices.
 */

const MOBILE_ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "components"];
const SKIP_DIRS = new Set(["__tests__", "__mocks__", "node_modules"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line + block comments so commented-out code can't trip the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

interface Consumer {
  file: string;
  receiver: string;
  /** character offset of the `.getReader(` occurrence within the stripped source */
  index: number;
}

function findConsumers(): { consumers: Consumer[]; sources: Map<string, string> } {
  const consumers: Consumer[] = [];
  const sources = new Map<string, string>();
  for (const dirName of SCAN_DIRS) {
    const dir = join(MOBILE_ROOT, dirName);
    let files: string[];
    try {
      files = collectSourceFiles(dir);
    } catch {
      continue; // directory doesn't exist
    }
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (!src.includes(".getReader(")) continue;
      const rel = relative(MOBILE_ROOT, file);
      sources.set(rel, src);
      // Every occurrence must be the simple `<identifier>.body.getReader()`
      // form so we can statically trace where the response came from.
      for (const occ of src.matchAll(/[\w$.)\]]*\.getReader\(/g)) {
        const m = occ[0].match(/^([A-Za-z_$][\w$]*)\.body\.getReader\($/);
        if (!m) {
          throw new Error(
            `${rel}: found a streaming consumer "${occ[0]})" that is not the ` +
              `simple "<var>.body.getReader()" form. Assign the response of an ` +
              `expo/fetch call to a variable first (e.g. "const resp = await ` +
              `expoFetch(...)") so this firewall can verify it streams on devices.`,
          );
        }
        consumers.push({ file: rel, receiver: m[1], index: occ.index! });
      }
    }
  }
  return { consumers, sources };
}

/** Returns the local name that `expo/fetch`'s fetch is imported as, or null. */
function expoFetchAlias(src: string): string | null {
  const aliased = src.match(
    /import\s*\{[^}]*\bfetch\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}\s*from\s*["']expo\/fetch["']/,
  );
  if (aliased) return aliased[1];
  const direct = src.match(/import\s*\{[^}]*\bfetch\b(?!\s+as)[^}]*\}\s*from\s*["']expo\/fetch["']/);
  if (direct) return "fetch";
  return null;
}

/**
 * The call expression feeding `name` at the point of the getReader call:
 * the nearest assignment `name = [await] callee(...)` that precedes
 * `beforeIndex` in the source. Returns null if none is found.
 */
function feedingCallee(
  src: string,
  name: string,
  beforeIndex: number,
): string | null {
  const re = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?\\b${name}\\s*(?::[^=;]+)?=(?![=>])\\s*(?:await\\s+)?([A-Za-z_$][\\w$.]*)\\s*\\(`,
    "g",
  );
  let nearest: string | null = null;
  for (const m of src.matchAll(re)) {
    if (m.index! >= beforeIndex) break;
    nearest = m[1];
  }
  return nearest;
}

describe("streaming fetch guard (RN global fetch cannot stream) — regression firewall", () => {
  const { consumers, sources } = findConsumers();

  it("still covers the AI assistant SSE stream (guard is not vacuous)", () => {
    expect(
      consumers.some((c) => c.file === join("app", "ai-assistant.tsx")),
      "app/ai-assistant.tsx no longer contains a .body.getReader() consumer. " +
        "If AI chat streaming was intentionally removed or moved, update this " +
        "firewall to cover the new streaming consumer.",
    ).toBe(true);
  });

  it("every .getReader() consumer gets its response from expo/fetch, not global fetch", () => {
    for (const { file, receiver, index } of consumers) {
      const src = sources.get(file)!;

      const alias = expoFetchAlias(src);
      expect(
        alias,
        `${file}: calls ${receiver}.body.getReader() but never imports fetch ` +
          `from "expo/fetch". React Native's global fetch has no streaming ` +
          `body — resp.body is null on real devices even though web preview ` +
          `and vitest pass. Import { fetch as expoFetch } from "expo/fetch" ` +
          `and use it for this request.`,
      ).not.toBeNull();

      const callee = feedingCallee(src, receiver, index);
      expect(
        callee,
        `${file}: could not find any assignment of "${receiver}" from a call ` +
          `expression before its .body.getReader() call, so this firewall ` +
          `cannot verify the stream works on devices. Assign it directly from ` +
          `the expo/fetch import (e.g. "${receiver} = await ${alias}(...)").`,
      ).not.toBeNull();

      expect(
        callee,
        `${file}: "${receiver}" (whose body is streamed via getReader) is ` +
          `fed by "${callee}(...)" — it must come from the expo/fetch ` +
          `import ("${alias}") because React Native's global fetch has no ` +
          `streaming response body. This exact swap caused an on-device-only ` +
          `outage before; web preview, vitest and the server all keep working ` +
          `while real devices break.`,
      ).toBe(alias);
    }
  });
});
