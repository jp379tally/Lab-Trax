import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Source-parity guard: the mobile case workflow stages and history-event
// terminology MUST track the desktop client. We read the desktop source as
// plain text (never importing its React modules — they pull in the whole web
// app, which the spec forbids us from touching) and compare against the mobile
// definitions. If desktop renames a station or changes the "Location Changed"
// event label, this test fails so the mobile client is updated in lockstep.

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP_CASES = resolve(here, "../../../labtrax-desktop/src/pages/cases.tsx");
const MOBILE_CASE = resolve(here, "../../app/case/[id].tsx");

interface ValueLabel {
  value: string;
  label: string;
}

// Pull the `[ ... ]` body of a named value/label literal and extract every
// `{ value: "x", label: "Y" }` pair in source order. Type annotations like
// `{ value: string; label: string }` never match (no quotes around the value).
function parseValueLabelArray(source: string, marker: string): ValueLabel[] {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("];", open);
  const body = source.slice(open, close);
  const out: ValueLabel[] = [];
  const re = /\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const [, value, label] = m;
    if (value !== undefined && label !== undefined) out.push({ value, label });
  }
  return out;
}

// Capture the string `formatEventType` returns for a "status_changed" event.
// The matching `)` then `return` skips the explanatory comments above the code.
function statusChangedLabel(source: string): string | null {
  const m = source.match(/"status_changed"\s*\)\s*return\s*"([^"]+)"/);
  return m && m[1] !== undefined ? m[1] : null;
}

describe("terminology parity: mobile case stages mirror desktop", () => {
  const desktop = readFileSync(DESKTOP_CASES, "utf8");
  const mobile = readFileSync(MOBILE_CASE, "utf8");

  it("mobile STATUS_OPTIONS equals desktop STATUS_FILTERS (minus the 'all' filter)", () => {
    const desktopStages = parseValueLabelArray(desktop, "STATUS_FILTERS").filter(
      (s) => s.value !== "all",
    );
    const mobileStages = parseValueLabelArray(mobile, "STATUS_OPTIONS");

    expect(desktopStages.length).toBeGreaterThan(0);
    expect(mobileStages.length).toBeGreaterThan(0);
    expect(mobileStages).toEqual(desktopStages);
  });

  it("both clients surface a 'status_changed' history event with the same label", () => {
    const desktopLabel = statusChangedLabel(desktop);
    const mobileLabel = statusChangedLabel(mobile);
    expect(desktopLabel).toBe("Location Changed");
    expect(mobileLabel).toBe(desktopLabel);
  });
});
