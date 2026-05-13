import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installElectronMock, uninstallElectronMock } from "./_mock-electron";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-auth-store-"));
let encryptionAvailable = true;

type AuthStore = {
  getTokens: () => { accessToken: string; refreshToken: string } | null;
  setTokens: (v: unknown) => void;
  clearTokens: () => void;
  isAvailable: () => boolean;
};

let authStore: AuthStore;

beforeAll(() => {
  installElectronMock({
    app: {
      getPath: (name: string) => {
        if (name === "userData") return tmpDir;
        throw new Error(`unexpected getPath(${name})`);
      },
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getVersion: () => "0.0.0",
    },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (s: string) => Buffer.from("ENC::" + s, "utf8"),
      decryptString: (buf: Buffer) => {
        const s = buf.toString("utf8");
        if (!s.startsWith("ENC::")) throw new Error("bad blob");
        return s.slice(5);
      },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  authStore = require("../auth-store.cjs") as AuthStore;
});

beforeEach(() => {
  encryptionAvailable = true;
  try {
    fs.unlinkSync(path.join(tmpDir, "auth-tokens.bin"));
  } catch {
    /* ignore */
  }
});

afterAll(() => {
  uninstallElectronMock();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("auth-store", () => {
  it("returns null when no tokens have been written yet", () => {
    expect(authStore.getTokens()).toBeNull();
  });

  it("round-trips tokens through safeStorage", () => {
    authStore.setTokens({ accessToken: "access-123", refreshToken: "refresh-456" });

    const blobPath = path.join(tmpDir, "auth-tokens.bin");
    expect(fs.existsSync(blobPath)).toBe(true);

    const raw = fs.readFileSync(blobPath, "utf8");
    expect(raw.startsWith("ENC::")).toBe(true);

    const got = authStore.getTokens();
    expect(got).toEqual({ accessToken: "access-123", refreshToken: "refresh-456" });
  });

  it("clearTokens removes the persisted blob and is idempotent", () => {
    authStore.setTokens({ accessToken: "a", refreshToken: "b" });
    authStore.clearTokens();
    expect(fs.existsSync(path.join(tmpDir, "auth-tokens.bin"))).toBe(false);
    expect(authStore.getTokens()).toBeNull();
    expect(() => authStore.clearTokens()).not.toThrow();
  });

  it("rejects payloads missing either token", () => {
    expect(() => authStore.setTokens(null)).toThrow();
    expect(() => authStore.setTokens({})).toThrow();
    expect(() => authStore.setTokens({ accessToken: "a" })).toThrow();
    expect(() => authStore.setTokens({ refreshToken: "b" })).toThrow();
    expect(() => authStore.setTokens({ accessToken: "", refreshToken: "b" })).toThrow();
    expect(() => authStore.setTokens({ accessToken: "a", refreshToken: "" })).toThrow();
    expect(() =>
      authStore.setTokens({ accessToken: 1 as unknown, refreshToken: "b" }),
    ).toThrow();
  });

  it("refuses to write when the OS keychain is unavailable", () => {
    encryptionAvailable = false;
    expect(() =>
      authStore.setTokens({ accessToken: "a", refreshToken: "b" }),
    ).toThrow(/keychain is unavailable/i);
    expect(fs.existsSync(path.join(tmpDir, "auth-tokens.bin"))).toBe(false);
  });

  it("getTokens returns null when keychain is unavailable, even if a blob exists", () => {
    authStore.setTokens({ accessToken: "a", refreshToken: "b" });
    encryptionAvailable = false;
    expect(authStore.getTokens()).toBeNull();
  });

  it("getTokens swallows decryption errors instead of throwing", () => {
    fs.writeFileSync(path.join(tmpDir, "auth-tokens.bin"), Buffer.from("not-encrypted"));
    expect(authStore.getTokens()).toBeNull();
  });

  it("getTokens rejects blobs whose JSON is missing required fields", () => {
    const bad = Buffer.from("ENC::" + JSON.stringify({ accessToken: "a" }), "utf8");
    fs.writeFileSync(path.join(tmpDir, "auth-tokens.bin"), bad);
    expect(authStore.getTokens()).toBeNull();
  });

  it("isAvailable mirrors safeStorage.isEncryptionAvailable", () => {
    expect(authStore.isAvailable()).toBe(true);
    encryptionAvailable = false;
    expect(authStore.isAvailable()).toBe(false);
  });
});
