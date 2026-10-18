import { describe, expect, it } from "vitest";
import {
  PROVIDER_ACCOUNT_ALLOW_MARKER,
  scanContent,
} from "../lint-provider-account-creation.js";

const GATE_FILE = "artifacts/api-server/src/lib/provider-account.ts";
const DEMO_FILE = "artifacts/api-server/src/routes/labtrax-routes.ts";
const STORAGE_FILE = "artifacts/api-server/src/storage.ts";

describe("lint-provider-account-creation", () => {
  it("allows the canonical provider-account gate", () => {
    const violations = scanContent(
      "await runner.insert(users).values({ userType: \"provider\" });",
      GATE_FILE
    );

    expect(violations).toHaveLength(0);
  });

  it("allows only a marked insert in the demo seeder", () => {
    const content = `await db.insert(users).values({ // ${PROVIDER_ACCOUNT_ALLOW_MARKER}
  username: "drcraig",
});`;

    expect(scanContent(content, DEMO_FILE)).toHaveLength(0);
  });

  it("flags an unmarked insert in the demo route", () => {
    const violations = scanContent(
      "await db.insert(users).values({ username: \"unexpected\" });",
      DEMO_FILE
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(1);
  });

  it("flags the unused storage shortcut", () => {
    const violations = scanContent(
      `const [user] = await db
  .insert(users)
  .values({ username, password })
  .returning();`,
      STORAGE_FILE
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("lib/provider-account.ts");
  });

  it("flags raw SQL users inserts too", () => {
    const violations = scanContent(
      'await db.execute("INSERT INTO users (username) VALUES ($1)");',
      STORAGE_FILE
    );

    expect(violations).toHaveLength(1);
  });

  it("ignores comments describing an insert", () => {
    expect(
      scanContent("// await db.insert(users).values({});", STORAGE_FILE)
    ).toHaveLength(0);
  });
});