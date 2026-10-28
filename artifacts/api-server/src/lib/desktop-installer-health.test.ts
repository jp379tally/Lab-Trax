import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchMock,
  getDesktopInstallerHandleMock,
  getDesktopInstallerMetadataMock,
  getDesktopUpdatePayloadHandleMock,
  readUpdateManifestMock,
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getDesktopInstallerHandleMock: vi.fn(),
  getDesktopInstallerMetadataMock: vi.fn(),
  getDesktopUpdatePayloadHandleMock: vi.fn(),
  readUpdateManifestMock: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ inArray: vi.fn(() => null) }));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([
          { key: "desktop_installer_url", value: "/downloads/LabTrax-Setup.exe" },
          { key: "desktop_installer_version", value: "1.2.3" },
        ]),
      })),
    })),
  },
  systemSettings: { key: "key", value: "value" },
}));

vi.mock("./download-interruptions.js", () => ({
  getDownloadInterruptionStats: vi.fn().mockResolvedValue({
    count24h: 0,
    retryFailCount24h: 0,
    lastOccurredAt: null,
  }),
}));

vi.mock("./desktop-installer-storage.js", () => ({
  getDesktopInstallerHandle: getDesktopInstallerHandleMock,
  getDesktopInstallerMetadata: getDesktopInstallerMetadataMock,
  getDesktopUpdatePayloadHandle: getDesktopUpdatePayloadHandleMock,
  installerKindFromUrl: vi.fn((url: string) => (url.endsWith(".exe") ? "exe" : null)),
  readUpdateManifest: readUpdateManifestMock,
}));

let runDesktopInstallerHealthCheck: typeof import("./desktop-installer-health.js").runDesktopInstallerHealthCheck;

const sha512 = Buffer.alloc(64, 7).toString("base64");
const windowsManifest = (version = "1.2.3") => Buffer.from(
  `version: ${version}\nfiles:\n  - url: LabTrax-Setup.exe\n    sha512: ${sha512}\n    size: 7\npath: LabTrax-Setup.exe\n`,
);
const macManifest = (version = "1.2.3") => Buffer.from(
  `version: ${version}\nfiles:\n  - url: LabTrax-${version}-x64-mac.zip\n    sha512: ${sha512}\n    size: 10\npath: LabTrax-${version}-x64-mac.zip\n`,
);

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_REPO_URL", "");
  ({ runDesktopInstallerHealthCheck } = await import("./desktop-installer-health.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();

  readUpdateManifestMock.mockImplementation(async (platform: "windows" | "mac") =>
    platform === "windows" ? windowsManifest() : macManifest(),
  );
  getDesktopInstallerHandleMock.mockResolvedValue({
    size: 7,
    uploadedAt: "2026-10-21T00:00:00.000Z",
    etag: "installer-etag",
  });
  getDesktopInstallerMetadataMock.mockResolvedValue({
    size: 7,
    uploadedAt: "2026-10-21T00:00:00.000Z",
  });
  getDesktopUpdatePayloadHandleMock.mockResolvedValue({
    size: 10,
    uploadedAt: "2026-10-21T00:00:00.000Z",
    etag: "payload-etag",
    fileName: "LabTrax-1.2.3-x64-mac.zip",
  });
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => ({
    status: init?.method === "HEAD" ? 200 : 206,
    ok: true,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "content-length") return "7";
        if (name.toLowerCase() === "etag") return "installer-etag";
        return null;
      },
    },
    text: async () => "",
  }));
});

describe("runDesktopInstallerHealthCheck update feeds", () => {
  it("reports healthy Windows and macOS feeds when manifests and payloads match", async () => {
    const report = await runDesktopInstallerHealthCheck({ baseUrl: "https://health.example" });

    expect(report.updateFeeds).toMatchObject({
      ok: true,
      windows: {
        path: "/downloads/latest.yml",
        ok: true,
        version: "1.2.3",
        payloadFiles: ["LabTrax-Setup.exe"],
        issues: [],
      },
      mac: {
        path: "/downloads/latest-mac.yml",
        ok: true,
        version: "1.2.3",
        payloadFiles: ["LabTrax-1.2.3-x64-mac.zip"],
        issues: [],
      },
    });
    expect(report.ok).toBe(true);
    expect(report.issues.filter((issue) => issue.startsWith("updateFeeds:"))).toEqual([]);
  });

  it("includes missing manifest and payload problems in the unhealthy report", async () => {
    readUpdateManifestMock.mockImplementation(async (platform: "windows" | "mac") =>
      platform === "windows" ? null : macManifest(),
    );
    getDesktopUpdatePayloadHandleMock.mockResolvedValue(null);

    const report = await runDesktopInstallerHealthCheck({ baseUrl: "https://health.example" });

    expect(report.ok).toBe(false);
    expect(report.updateFeeds.ok).toBe(false);
    expect(report.updateFeeds.windows.issues.join("\n")).toContain("/downloads/latest.yml is missing");
    expect(report.updateFeeds.mac.issues.join("\n")).toContain(
      "LabTrax-1.2.3-x64-mac.zip referenced by /downloads/latest-mac.yml is missing",
    );
    expect(report.issues.join("\n")).toContain("updateFeeds: /downloads/latest.yml is missing");
    expect(report.issues.join("\n")).toContain("updateFeeds: macOS update payload");
  });

  it("flags version drift and a missing Windows installer payload", async () => {
    readUpdateManifestMock.mockImplementation(async (platform: "windows" | "mac") =>
      platform === "windows" ? windowsManifest("1.2.2") : macManifest("1.2.2"),
    );
    getDesktopInstallerMetadataMock.mockImplementation(async (kind: string) =>
      kind === "exe" ? null : { size: 7, uploadedAt: "2026-10-21T00:00:00.000Z" },
    );

    const report = await runDesktopInstallerHealthCheck({ baseUrl: "https://health.example" });

    expect(report.updateFeeds.ok).toBe(false);
    expect(report.updateFeeds.windows.issues.join("\n")).toContain(
      "reports version 1.2.2, but the configured release is 1.2.3",
    );
    expect(report.updateFeeds.windows.issues.join("\n")).toContain(
      "Windows update payload LabTrax-Setup.exe referenced by /downloads/latest.yml is missing",
    );
    expect(report.updateFeeds.mac.issues.join("\n")).toContain(
      "reports version 1.2.2, but the configured release is 1.2.3",
    );
    expect(report.issues.join("\n")).toContain("Rerun Publish Draft Release for v1.2.3");
  });

  it("returns an unhealthy report instead of throwing for a malformed manifest path", async () => {
    readUpdateManifestMock.mockImplementation(async (platform: "windows" | "mac") =>
      platform === "windows"
        ? Buffer.from(
            `version: 1.2.3\nfiles:\n  - url: LabTrax-Setup.exe\n    sha512: ${sha512}\n    size: 7\npath: %E0\n`,
          )
        : macManifest(),
    );

    const report = await runDesktopInstallerHealthCheck({ baseUrl: "https://health.example" });

    expect(report.updateFeeds.ok).toBe(false);
    expect(report.updateFeeds.windows.issues.join("\n")).toContain("/downloads/latest.yml is invalid");
  });
});
