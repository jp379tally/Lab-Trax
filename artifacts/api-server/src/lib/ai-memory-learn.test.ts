/**
 * Unit tests for the pure extraction layer of AI memory auto-learning.
 *
 * extractMemoryCandidates only depends on the injected OpenAI client (mocked
 * here) and does no DB work, so these run without DATABASE_URL.
 *
 * Coverage:
 *  - parses a valid {"candidates":[...]} response into RawCandidate[]
 *  - drops items with an invalid kind, blank key, or blank value
 *  - normalizes mixed-case kinds and trims key/value
 *  - caps the result at 5 candidates
 *  - returns [] on a non-array payload, invalid JSON, empty content,
 *    a blank user message, or an OpenAI error (never throws)
 */
import { describe, expect, it, vi } from "vitest";
import { extractMemoryCandidates } from "./ai-memory-learn";

function mockOpenAi(content: string | null, opts: { throws?: boolean } = {}) {
  const create = opts.throws
    ? vi.fn().mockRejectedValue(new Error("boom"))
    : vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { chat: { completions: { create } } } as any;
}

describe("extractMemoryCandidates (pure)", () => {
  it("parses a valid candidates payload", async () => {
    const openai = mockOpenAi(
      JSON.stringify({
        candidates: [
          { kind: "glossary", key: "PFZ", value: "porcelain fused to zirconia" },
          { kind: "preference", key: "Tone", value: "concise" },
        ],
      }),
    );
    const out = await extractMemoryCandidates(openai, "what is PFZ?", "PFZ means ...");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      kind: "glossary",
      key: "PFZ",
      value: "porcelain fused to zirconia",
    });
  });

  it("drops invalid kinds and blank fields, normalizes case, trims", async () => {
    const openai = mockOpenAi(
      JSON.stringify({
        candidates: [
          { kind: "GLOSSARY", key: "  Zr  ", value: "  zirconia  " },
          { kind: "bogus", key: "x", value: "y" },
          { kind: "fact", key: "", value: "no key" },
          { kind: "fact", key: "no value", value: "   " },
        ],
      }),
    );
    const out = await extractMemoryCandidates(openai, "u", "a");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: "glossary", key: "Zr", value: "zirconia" });
  });

  it("caps the result at 5 candidates", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "fact",
      key: `k${i}`,
      value: `v${i}`,
    }));
    const openai = mockOpenAi(JSON.stringify({ candidates: many }));
    const out = await extractMemoryCandidates(openai, "u", "a");
    expect(out).toHaveLength(5);
  });

  it("returns [] for a non-array candidates field", async () => {
    const openai = mockOpenAi(JSON.stringify({ candidates: "nope" }));
    expect(await extractMemoryCandidates(openai, "u", "a")).toEqual([]);
  });

  it("returns [] for invalid JSON content", async () => {
    const openai = mockOpenAi("not json{");
    expect(await extractMemoryCandidates(openai, "u", "a")).toEqual([]);
  });

  it("returns [] for empty content", async () => {
    const openai = mockOpenAi(null);
    expect(await extractMemoryCandidates(openai, "u", "a")).toEqual([]);
  });

  it("returns [] for a blank user message without calling the model", async () => {
    const openai = mockOpenAi(JSON.stringify({ candidates: [] }));
    const out = await extractMemoryCandidates(openai, "   ", "a");
    expect(out).toEqual([]);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("returns [] (never throws) when the OpenAI call fails", async () => {
    const openai = mockOpenAi(null, { throws: true });
    await expect(extractMemoryCandidates(openai, "u", "a")).resolves.toEqual([]);
  });
});
