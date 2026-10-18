import { describe, expect, it } from "vitest";
import { extractVersionBlock } from "../lib/parse-release-notes.mjs";

describe("release notes extractor", () => {
  it("extracts exactly one version block and accepts versions with or without v", () => {
    const notes = [
      "# Release notes",
      "",
      "## v1.2.3",
      "",
      "- First change",
      "- Second change",
      "",
      "## v1.2.2",
      "- Older change",
    ].join("\n");

    expect(extractVersionBlock(notes, "1.2.3")).toBe(
      "- First change\n- Second change",
    );
    expect(extractVersionBlock(notes, "v1.2.2")).toBe("- Older change");
  });

  it("returns null when the version is absent or its section is empty", () => {
    expect(extractVersionBlock("## v1.2.3\n- notes", "9.9.9")).toBeNull();
    expect(extractVersionBlock("## v1.2.3\n\n## v1.2.2\n- old", "1.2.3")).toBeNull();
  });
});
