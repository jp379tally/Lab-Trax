import { afterEach, describe, expect, it, vi } from "vitest";
import { getBackupStagingLocation } from "./case-media-object-storage";

afterEach(() => vi.unstubAllEnvs());
describe("backup staging privacy and inventory isolation", () => {
  it("separates temporary archives from private source inventory and environments", () => {
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/synthetic-bucket/private/uploads");
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/synthetic-bucket/public");
    const dev = getBackupStagingLocation("non-production");
    const prod = getBackupStagingLocation("production");
    expect(dev.prefix).toMatch(/^\.labtrax-backup-staging\/[a-f0-9]{64}\/non-production$/);
    expect(prod.prefix).not.toBe(dev.prefix);
    expect(dev.prefix.startsWith("private/uploads/")).toBe(false);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/synthetic-bucket/another-private-source");
    expect(getBackupStagingLocation("non-production").prefix).not.toBe(dev.prefix);
  });
  it("refuses a public or inventoried staging prefix", () => {
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/synthetic-bucket/private");
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/synthetic-bucket");
    expect(() => getBackupStagingLocation("production")).toThrow(/publicly served/);
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/synthetic-bucket/.labtrax-backup-staging");
    expect(() => getBackupStagingLocation("production")).toThrow(/publicly served/);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/synthetic-bucket/.labtrax-backup-staging");
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "");
    expect(() => getBackupStagingLocation("production")).toThrow(/outside the recovery inventory/);
  });
  it("refuses a missing or unscoped private root", () => {
    vi.stubEnv("PRIVATE_OBJECT_DIR", "");
    expect(() => getBackupStagingLocation("production")).toThrow(/required/);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/synthetic-bucket/");
    expect(() => getBackupStagingLocation("production")).toThrow(/scoped|Invalid App Storage object path/);
  });
});
