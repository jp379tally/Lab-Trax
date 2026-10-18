import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEMO_USERS,
  resolveDemoSeedPassword,
} from "./demo-seed-config";

describe("default demo seed identities", () => {
  it("uses synthetic usernames and reserved test email addresses", () => {
    expect(DEFAULT_DEMO_USERS.map(({ username }) => username)).toEqual([
      "labadmin_demo",
      "labtech_demo",
      "master_demo",
      "provider_demo",
    ]);
    expect(DEFAULT_DEMO_USERS.every(({ email }) =>
      email.endsWith("@example.test"),
    )).toBe(true);
  });
});

describe("resolveDemoSeedPassword", () => {
  it("keeps demo seeding unavailable outside development", () => {
    expect(
      resolveDemoSeedPassword({
        NODE_ENV: "production",
        LABTRAX_ENABLE_DEMO_SEEDS: "true",
        LABTRAX_DEMO_SEED_PASSWORD: "unit-test-only-value",
      }),
    ).toBeNull();
  });

  it("requires the explicit demo-seed opt-in", () => {
    expect(
      resolveDemoSeedPassword({
        NODE_ENV: "development",
        LABTRAX_DEMO_SEED_PASSWORD: "unit-test-only-value",
      }),
    ).toBeNull();
  });

  it("refuses demo seeding when the local password setting is missing", () => {
    expect(() =>
      resolveDemoSeedPassword({
        NODE_ENV: "development",
        LABTRAX_ENABLE_DEMO_SEEDS: "true",
      }),
    ).toThrow("LABTRAX_DEMO_SEED_PASSWORD");
  });

  it("refuses a blank local password setting", () => {
    expect(() =>
      resolveDemoSeedPassword({
        NODE_ENV: "development",
        LABTRAX_ENABLE_DEMO_SEEDS: "true",
        LABTRAX_DEMO_SEED_PASSWORD: "  ",
      }),
    ).toThrow("LABTRAX_DEMO_SEED_PASSWORD");
  });

  it("uses the explicitly supplied local password for development seeds", () => {
    expect(
      resolveDemoSeedPassword({
        NODE_ENV: "development",
        LABTRAX_ENABLE_DEMO_SEEDS: "true",
        LABTRAX_DEMO_SEED_PASSWORD: "unit-test-only-value",
      }),
    ).toBe("unit-test-only-value");
  });
});
