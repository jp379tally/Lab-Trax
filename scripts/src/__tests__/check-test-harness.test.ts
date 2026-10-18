import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLECT_PROJECT,
  REPO_ROOT,
  REQUIRED_HARNESS_FILES,
  discoverHarnessFiles,
  extractSetupFiles,
  inspectHarnessFile,
  parseHarnessSource,
  summarizeCollectOutput,
} from "../check-test-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const CLEAN_SETUP = `import { vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    },
  };
});
`;

describe("check-test-harness — the real merge clobber is caught", () => {
  /**
   * This fixture is the verbatim region a merge left behind in the mobile
   * harness: the async-storage mock's body was replaced with lines belonging
   * to an unrelated API-client mock, leaving an `await` outside any async
   * function. Every mobile test file failed to transform and nothing flagged
   * it. If this assertion ever stops failing on that content, the fence has
   * stopped guarding the thing it exists for.
   */
  it("reports a parse error for the clobbered async-storage mock", () => {
    const clobbered = readFileSync(
      join(FIXTURES, "clobbered-mobile-harness.ts.txt"),
      "utf8",
    );
    const issues = parseHarnessSource(clobbered, "vitest.setup.ts");

    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].kind).toBe("parse");
    expect(issues[0].file).toBe("vitest.setup.ts");
    expect(issues[0].line).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/^TS\d+: /);
  });

  it("accepts the same mock once it is repaired", () => {
    expect(parseHarnessSource(CLEAN_SETUP, "vitest.setup.ts")).toEqual([]);
  });
});

describe("check-test-harness — parse check", () => {
  it("catches committed merge-conflict markers", () => {
    const conflicted = `import { vi } from "vitest";
<<<<<<< HEAD
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
=======
vi.mock("expo-router", () => ({ router: vi.fn() }));
>>>>>>> other-branch
`;
    expect(parseHarnessSource(conflicted, "vitest.setup.ts").length).toBeGreaterThan(0);
  });

  it("catches a truncated file whose braces never close", () => {
    const truncated = `import { vi } from "vitest";

vi.mock("expo-router", () => {
  return {
    useRouter: vi.fn(),
`;
    expect(parseHarnessSource(truncated, "vitest.setup.ts").length).toBeGreaterThan(0);
  });

  it("parses TSX harness content, including JSX", () => {
    const tsx = `import React from "react";

export const passthrough = ({ children }: { children?: React.ReactNode }) => (
  <>{children}</>
);
`;
    expect(parseHarnessSource(tsx, "setup.tsx")).toEqual([]);
  });

  it("does not type-check — an unresolved import is not a harness failure", () => {
    const unresolved = `import { thing } from "./module-that-does-not-exist";

export const value: string = thing;
`;
    expect(parseHarnessSource(unresolved, "vitest.setup.ts")).toEqual([]);
  });
});

describe("check-test-harness — file-level checks", () => {
  it("fails loudly when a harness file is missing rather than skipping it", () => {
    const dir = tempDir();
    const issues = inspectHarnessFile(
      join(dir, "vitest.setup.ts"),
      "artifacts/labtrax/vitest.setup.ts",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("missing");
    expect(issues[0].file).toBe("artifacts/labtrax/vitest.setup.ts");
  });

  it("fails on an empty harness file, which parses but strips every mock", () => {
    const dir = tempDir();
    const file = join(dir, "vitest.setup.ts");
    writeFileSync(file, "\n\n   \n");

    const issues = inspectHarnessFile(file, "artifacts/labtrax/vitest.setup.ts");
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("empty");
  });

  it("passes a harness file that exists and parses", () => {
    const dir = tempDir();
    const file = join(dir, "vitest.setup.ts");
    writeFileSync(file, CLEAN_SETUP);

    expect(inspectHarnessFile(file, "artifacts/labtrax/vitest.setup.ts")).toEqual([]);
  });
});

describe("check-test-harness — setupFiles extraction", () => {
  it("reads a single-entry array", () => {
    expect(
      extractSetupFiles(`export default { test: { setupFiles: ["./vitest.setup.ts"] } }`),
    ).toEqual(["./vitest.setup.ts"]);
  });

  it("reads several entries across lines", () => {
    const source = `export default defineConfig({
  test: {
    setupFiles: [
      "@testing-library/jest-dom/vitest",
      "./src/__tests__/setup.ts",
    ],
  },
});
`;
    expect(extractSetupFiles(source)).toEqual([
      "@testing-library/jest-dom/vitest",
      "./src/__tests__/setup.ts",
    ]);
  });

  it("reads a bare string form", () => {
    expect(extractSetupFiles(`test: { setupFiles: './setup.ts' }`)).toEqual([
      "./setup.ts",
    ]);
  });

  it("returns nothing when the config declares no setup files", () => {
    expect(extractSetupFiles(`test: { include: ["src/**/*.test.ts"] }`)).toEqual([]);
  });
});

describe("check-test-harness — discovery", () => {
  it("finds each project's config and the setup files it names", () => {
    const root = tempDir();
    mkdirSync(join(root, "artifacts", "app-a"), { recursive: true });
    mkdirSync(join(root, "artifacts", "app-b", "src", "__tests__"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "artifacts", "app-a", "vitest.config.ts"),
      `export default { test: { setupFiles: ["./vitest.setup.ts"] } };`,
    );
    writeFileSync(join(root, "artifacts", "app-a", "vitest.setup.ts"), CLEAN_SETUP);
    writeFileSync(
      join(root, "artifacts", "app-b", "vitest.config.ts"),
      `export default { test: { setupFiles: ["@testing-library/jest-dom/vitest", "./src/__tests__/setup.ts"] } };`,
    );
    writeFileSync(
      join(root, "artifacts", "app-b", "src", "__tests__", "setup.ts"),
      CLEAN_SETUP,
    );

    const found = discoverHarnessFiles(root);
    const paths = found.map((file) => file.path);

    expect(paths).toContain("artifacts/app-a/vitest.config.ts");
    expect(paths).toContain("artifacts/app-a/vitest.setup.ts");
    expect(paths).toContain("artifacts/app-b/vitest.config.ts");
    expect(paths).toContain("artifacts/app-b/src/__tests__/setup.ts");

    // Package specifiers are dependencies, not project files to parse.
    expect(paths).not.toContain("@testing-library/jest-dom/vitest");

    const setup = found.find((file) => file.path === "artifacts/app-a/vitest.setup.ts");
    expect(setup?.role).toBe("setup");
    expect(setup?.declaredBy).toBe("artifacts/app-a/vitest.config.ts");
  });

  it("finds alternate configs such as a dedicated restore config", () => {
    const root = tempDir();
    mkdirSync(join(root, "artifacts", "api"), { recursive: true });
    writeFileSync(join(root, "artifacts", "api", "vitest.config.ts"), `export default {};`);
    writeFileSync(
      join(root, "artifacts", "api", "vitest.restore.config.ts"),
      `export default {};`,
    );

    const paths = discoverHarnessFiles(root).map((file) => file.path);
    expect(paths).toContain("artifacts/api/vitest.config.ts");
    expect(paths).toContain("artifacts/api/vitest.restore.config.ts");
  });

  it("ignores files that only look like configs", () => {
    const root = tempDir();
    mkdirSync(join(root, "artifacts", "app"), { recursive: true });
    writeFileSync(join(root, "artifacts", "app", "vite.config.ts"), `export default {};`);
    writeFileSync(join(root, "artifacts", "app", "vitest.config.md"), `docs`);

    expect(discoverHarnessFiles(root)).toEqual([]);
  });
});

describe("check-test-harness — collection verdict", () => {
  const COLLECTED = `lib/__tests__/a.test.ts > suite > does a thing
lib/__tests__/b.test.ts > suite > does another thing
`;

  it("passes when collection exits cleanly with tests", () => {
    const verdict = summarizeCollectOutput(0, COLLECTED);
    expect(verdict.ok).toBe(true);
    expect(verdict.testCount).toBe(2);
  });

  it("fails when collection exits non-zero", () => {
    const verdict = summarizeCollectOutput(
      1,
      `Error: Transform failed with 1 error:
vitest.setup.ts:635:18: ERROR: "await" can only be used inside an "async" function`,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("exit code 1");
  });

  it("fails when collection succeeds but finds no tests at all", () => {
    const verdict = summarizeCollectOutput(0, "");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("no tests");
  });

  it("fails when collection times out", () => {
    const verdict = summarizeCollectOutput(null, COLLECTED, true);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("timed out");
  });
});

describe("check-test-harness — the fence watches the real repo", () => {
  it("discovers the mobile, desktop, and api-server harness files", () => {
    const paths = discoverHarnessFiles(REPO_ROOT).map((file) => file.path);

    expect(paths).toContain("artifacts/labtrax/vitest.config.ts");
    expect(paths).toContain("artifacts/labtrax/vitest.setup.ts");
    expect(paths).toContain("artifacts/labtrax-desktop/vitest.config.ts");
    expect(paths).toContain("artifacts/labtrax-desktop/src/__tests__/setup.ts");
    expect(paths).toContain("artifacts/api-server/vitest.config.ts");
  });

  it("still covers every required harness file", () => {
    const paths = new Set(discoverHarnessFiles(REPO_ROOT).map((file) => file.path));
    for (const required of REQUIRED_HARNESS_FILES) {
      expect(paths.has(required)).toBe(true);
      expect(existsSync(join(REPO_ROOT, required))).toBe(true);
    }
  });

  it("collects from a project directory that exists", () => {
    expect(existsSync(join(REPO_ROOT, COLLECT_PROJECT.dir))).toBe(true);
  });

  it("parses every harness file currently in the repo", () => {
    const issues = discoverHarnessFiles(REPO_ROOT).flatMap((file) =>
      inspectHarnessFile(join(REPO_ROOT, file.path), file.path),
    );

    expect(
      issues.map((issue) => `${issue.file}:${issue.line ?? 0} ${issue.message}`),
    ).toEqual([]);
  });
});
