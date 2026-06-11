import { describe, it, expect } from "vitest";
import {
  scanContent,
  FORBIDDEN,
  FILE_DISABLE_MARKER,
  LINE_ALLOW_MARKER,
} from "../lint-mobile-legacy-paths.js";

const FAKE_FILE = "artifacts/labtrax/lib/some-new-file.ts";

describe("lint-mobile-legacy-paths — scanContent", () => {
  describe("clean code passes", () => {
    it("returns no violations for completely clean content", () => {
      const content = `
import { useCallback } from "react";

export function doSomething() {
  return fetch("/api/cases/abc-uuid");
}
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });

    it("returns no violations for an empty file", () => {
      expect(scanContent("", FAKE_FILE)).toHaveLength(0);
    });
  });

  describe("file-level disable marker suppresses all violations", () => {
    it("skips every pattern when file-level marker is present", () => {
      const content = `// ${FILE_DISABLE_MARKER}
const url = "/api/legacy/cases";
const x = pendingSyncCount;
const y = stuckSyncItems;
const z = unionActivityLog();
const t = lab_cases;
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });

    it("works when the marker appears mid-file (e.g. in a block comment)", () => {
      const content = `
/*
 * ${FILE_DISABLE_MARKER}
 */
const bad = pendingSyncCount;
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });
  });

  describe("per-line allow marker suppresses single line", () => {
    it("allows a forbidden pattern on a line with the allow marker", () => {
      const content = `const url = "/api/legacy/cases"; // ${LINE_ALLOW_MARKER}
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });

    it("does not suppress other lines in the same file", () => {
      const content = `const a = "/api/legacy/cases"; // ${LINE_ALLOW_MARKER}
const b = pendingSyncCount;
`;
      const violations = scanContent(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].patternId).toBe("pending-sync-count");
    });
  });

  describe("comment lines are skipped", () => {
    it("ignores // comment lines", () => {
      const content = `// const bad = pendingSyncCount;
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });

    it("ignores * comment lines (inside JSDoc / block comments)", () => {
      const content = ` * pendingSyncCount is mentioned here
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });

    it("ignores /* comment lines", () => {
      const content = `/* pendingSyncCount stuckSyncItems lab_cases */
`;
      expect(scanContent(content, FAKE_FILE)).toHaveLength(0);
    });
  });

  describe("each forbidden pattern is independently detected", () => {
    for (const pattern of FORBIDDEN) {
      it(`detects [${pattern.id}]`, () => {
        const sampleLine =
          pattern.id === "api-legacy-cases"
            ? `const url = "/api/legacy/cases/sync";`
            : pattern.id === "lab-cases-table"
            ? `const q = db.select().from(lab_cases);`
            : pattern.id === "pending-sync-count"
            ? `const n = pendingSyncCount;`
            : pattern.id === "stuck-sync-items"
            ? `const items = stuckSyncItems;`
            : `const r = unionActivityLog(caseId);`;

        const violations = scanContent(sampleLine + "\n", FAKE_FILE);
        expect(violations.length).toBeGreaterThanOrEqual(1);
        const hit = violations.find((v) => v.patternId === pattern.id);
        expect(hit).toBeDefined();
        expect(hit!.file).toBe(FAKE_FILE);
        expect(hit!.line).toBe(1);
        expect(hit!.reason).toContain(
          pattern.id === "api-legacy-cases"
            ? "/api/legacy/cases"
            : pattern.id === "lab-cases-table"
            ? "lab_cases"
            : pattern.id === "pending-sync-count"
            ? "pendingSyncCount"
            : pattern.id === "stuck-sync-items"
            ? "stuckSyncItems"
            : "unionActivityLog"
        );
      });
    }
  });

  describe("multiple patterns in the same file are all reported", () => {
    it("reports one violation per matching non-comment line", () => {
      const content = `
const url = "/api/legacy/cases";
const count = pendingSyncCount;
const items = stuckSyncItems;
`;
      const violations = scanContent(content, FAKE_FILE);
      expect(violations).toHaveLength(3);
      const ids = violations.map((v) => v.patternId);
      expect(ids).toContain("api-legacy-cases");
      expect(ids).toContain("pending-sync-count");
      expect(ids).toContain("stuck-sync-items");
    });
  });

  describe("line numbers are accurate", () => {
    it("reports the correct 1-based line number", () => {
      const content = `
// clean line
const x = pendingSyncCount;
`;
      const violations = scanContent(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(3);
    });
  });

  describe("proof: adding a new legacy reference to a new file is caught", () => {
    it("catches pendingSyncCount in new-feature code that is NOT grandfathered", () => {
      const newFeatureCode = `
import { useApp } from "@/lib/app-context";

export function MyNewComponent() {
  const { pendingSyncCount } = useApp();
  return pendingSyncCount > 0 ? "busy" : "idle";
}
`;
      const violations = scanContent(newFeatureCode, FAKE_FILE);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].patternId).toBe("pending-sync-count");
    });

    it("catches stuckSyncItems in new-feature code that is NOT grandfathered", () => {
      const newFeatureCode = `
import { useApp } from "@/lib/app-context";

export function MyNewComponent() {
  const { stuckSyncItems } = useApp();
  return stuckSyncItems.length;
}
`;
      const violations = scanContent(newFeatureCode, FAKE_FILE);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].patternId).toBe("stuck-sync-items");
    });
  });
});
