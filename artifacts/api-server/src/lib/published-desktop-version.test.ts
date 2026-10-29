import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ readManifest: vi.fn() }));
vi.mock("./desktop-installer-storage", () => ({
  readUpdateManifest: fixture.readManifest,
}));
import { getPublishedDesktopVersion } from "./published-desktop-version";

describe("published desktop version", () => {
  beforeEach(() => {
    fixture.readManifest.mockReset();
  });

  it("reports the updater's version instead of an unrelated settings value", async () => {
    fixture.readManifest.mockResolvedValue(
      Buffer.from("version: 1.0.3\npath: LabTrax-Setup.exe\n"),
    );
    const fallback = vi.fn().mockResolvedValue("1.0.5");
    expect(await getPublishedDesktopVersion(fallback)).toBe("1.0.3");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses existing metadata for portable-only installs without a feed", async () => {
    fixture.readManifest.mockResolvedValue(null);
    const fallback = vi.fn().mockResolvedValue("1.0.5");
    expect(await getPublishedDesktopVersion(fallback)).toBe("1.0.5");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it.each([
    "version: [",
    "version: 5",
    "version: latest",
    "path: LabTrax-Setup.exe",
    "version: 1.0.3\nversion: 1.0.5",
  ])("refuses invalid feed metadata without substituting another version: %s", async (content) => {
    fixture.readManifest.mockResolvedValue(Buffer.from(content));
    const fallback = vi.fn().mockResolvedValue("1.0.5");
    await expect(getPublishedDesktopVersion(fallback)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("bounds metadata size and rejects unavailable storage", async () => {
    fixture.readManifest.mockResolvedValue(
      Buffer.from(`version: 1.0.3\nnote: ${"x".repeat(64 * 1024)}\n`),
    );
    await expect(getPublishedDesktopVersion(async () => "1.0.5")).rejects.toMatchObject({
      statusCode: 503,
    });

    fixture.readManifest.mockRejectedValue(new Error("storage unavailable"));
    await expect(getPublishedDesktopVersion(async () => "1.0.5")).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
