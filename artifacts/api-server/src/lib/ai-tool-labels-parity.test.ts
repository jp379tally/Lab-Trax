import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AGENT_TOOLS } from "./ai-agent-tools";

/**
 * Drift guard: the friendly tool labels in
 * `lib/api-client-react/src/ai-tool-labels.ts` are a hand-maintained map keyed
 * by the agent tool names defined in `ai-agent-tools.ts`. When a new tool is
 * added here without a matching label, the UI silently falls back to the
 * generic "Looking up…" spinner. This test fails on that drift so a friendly
 * label is added before shipping.
 */

const LABELS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../lib/api-client-react/src/ai-tool-labels.ts",
);

function readLabelKeys(): Set<string> {
  const source = readFileSync(LABELS_FILE, "utf8");
  const start = source.indexOf("TOOL_LABELS");
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  expect(
    start !== -1 && open !== -1 && close !== -1,
    "Could not locate the TOOL_LABELS object literal in ai-tool-labels.ts",
  ).toBe(true);
  const body = source.slice(open + 1, close);
  const keys = new Set<string>();
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

describe("AI tool label parity", () => {
  const labelKeys = readLabelKeys();
  const toolNames = AGENT_TOOLS.map((t) => t.name);

  it("extracts label keys from ai-tool-labels.ts", () => {
    expect(labelKeys.size).toBeGreaterThan(0);
  });

  it("every agent tool has a friendly label", () => {
    const missing = toolNames.filter((name) => !labelKeys.has(name));
    expect(
      missing,
      `Agent tools missing a label in lib/api-client-react/src/ai-tool-labels.ts: ${missing.join(", ")}. Add a friendly label for each.`,
    ).toEqual([]);
  });

  it("every label maps to a real agent tool (no stale labels)", () => {
    const toolNameSet = new Set(toolNames);
    const stale = [...labelKeys].filter((key) => !toolNameSet.has(key));
    expect(
      stale,
      `Labels in ai-tool-labels.ts with no matching agent tool: ${stale.join(", ")}. Remove or rename them.`,
    ).toEqual([]);
  });
});
