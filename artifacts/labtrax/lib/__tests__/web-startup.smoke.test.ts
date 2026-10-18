import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const metroConfig = require("../../metro.config.js") as {
  resolver: {
    resolveRequest: (
      context: { resolveRequest: (...args: unknown[]) => unknown },
      moduleName: string,
      platform: string,
    ) => unknown;
  };
};

describe("LabTrax web startup", () => {
  it("redirects VisionCamera to the web-safe implementation", async () => {
    const fallbackResolver = vi.fn();
    const resolved = metroConfig.resolver.resolveRequest(
      { resolveRequest: fallbackResolver },
      "react-native-vision-camera",
      "web",
    );

    expect(resolved).toEqual({
      type: "sourceFile",
      filePath: path.resolve(__dirname, "../vision-camera-web.ts"),
    });
    expect(fallbackResolver).not.toHaveBeenCalled();
  });

  it("keeps native VisionCamera resolution unchanged", async () => {
    const fallbackResult = { type: "sourceFile", filePath: "/native-camera" };
    const fallbackResolver = vi.fn(() => fallbackResult);

    const resolved = metroConfig.resolver.resolveRequest(
      { resolveRequest: fallbackResolver },
      "react-native-vision-camera",
      "ios",
    );

    expect(resolved).toBe(fallbackResult);
    expect(fallbackResolver).toHaveBeenCalledWith(
      { resolveRequest: fallbackResolver },
      "react-native-vision-camera",
      "ios",
    );
  });
});