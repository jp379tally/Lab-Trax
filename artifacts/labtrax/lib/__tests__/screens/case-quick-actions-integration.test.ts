import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd());
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("case quick-action screen wiring", () => {
  const surfaces = [
    "app/(tabs)/index.tsx",
    "app/(tabs)/dashboard.tsx",
    "components/CaseLookupSheet.tsx",
    "app/case/[id].tsx",
    "app/finance/doctor-cases.tsx",
  ];

  it("keeps the controller and guarded release navigation on every mobile surface", async () => {
    for (const path of surfaces) {
      const text = source(path);
      expect(text, path).toContain("CaseQuickActionSheet");
      expect(text, path).toContain("useLongPressGuard");
      expect(text, path).toContain("isActiveCaseRecord");
      expect(text, path).toContain("onLongPress");
    }
  });

  it("does not reintroduce Cases bulk-selection controls", async () => {
    const cases = source("app/(tabs)/index.tsx");
    expect(cases).not.toContain("bulk-locate-btn");
    expect(cases).not.toContain("selectionMode");
    expect(cases).not.toContain("selectedCaseIds");
  });
});