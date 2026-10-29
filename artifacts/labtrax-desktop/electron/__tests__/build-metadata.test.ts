import { describe, expect, it } from "vitest";

const { buildMetadataFromStamp } = require("../build-metadata.cjs") as {
  buildMetadataFromStamp: (
    stamp: Record<string, unknown> | null,
    version: string | null,
  ) => {
    version: string | null;
    buildNumber: number | null;
    updateChannel: string | null;
  };
};

describe("build metadata", () => {
  it("returns packaged version, build number, and supported update channel only", () => {
    const result = buildMetadataFromStamp(
      {
        version: "9.9.9",
        buildNumber: 231,
        updateChannel: "installer",
        updateFeedUrl: "https://private.example/feed?token=secret",
      },
      "1.2.3",
    );

    expect(result).toEqual({
      version: "1.2.3",
      buildNumber: 231,
      updateChannel: "installer",
    });
    expect(JSON.stringify(result)).not.toContain("private.example");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns null for missing or invalid build and channel metadata", () => {
    expect(
      buildMetadataFromStamp(
        {
          buildNumber: "231",
          updateChannel: "https://private.example/feed",
          updateFeedUrl: "https://private.example/feed?token=secret",
        },
        null,
      ),
    ).toEqual({
      version: null,
      buildNumber: null,
      updateChannel: null,
    });
  });
});
