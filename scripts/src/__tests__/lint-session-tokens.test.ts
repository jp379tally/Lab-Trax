import { describe, it, expect } from "vitest";
import {
  scanTestContentForFixedSessionTokens,
  SESSION_TOKEN_ALLOW_MARKER,
} from "../lint-protected-tables.js";

const FAKE_FILE = "artifacts/api-server/src/routes/some-new.test.ts";

describe("lint-protected-tables — fixed session token check", () => {
  describe("safe patterns pass", () => {
    it("allows tokenHash derived from a per-run-random id variable", () => {
      const content = `
const sessId = rid("sess");
await db.insert(userSessions).values({
  id: sessId,
  userId: ownerId,
  tokenHash: createHash("sha256").update(sessId).digest("hex"),
  expiresAt: new Date(Date.now() + 60_000),
});
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("allows tokenHash derived from a freshly signed token", () => {
      const content = `
const token = auth.signAccessToken(userId, sessionId);
const hash = createHash("sha256").update(token).digest("hex");
await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("allows a template literal WITH interpolation (dynamic)", () => {
      const content = `
await db.insert(userSessions).values({
  tokenHash: \`hash-\${rid("tok")}\`,
});
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("allows cleanup DELETEs of known legacy fixed hashes", () => {
      const content = `
const legacyFixedHashes = ["tok-11-a", "tok-11-b"].map(
  (t) => createHash("sha256").update(t).digest("hex"),
);
await dbPool.query(
  "DELETE FROM user_sessions WHERE token_hash = ANY($1)",
  [legacyFixedHashes],
);
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("does not confuse the createHash(\"sha256\") algorithm literal with a literal token", () => {
      const content = `
const hash = createHash("sha256").update(sentinelId).digest("hex");
await dbPool.query(
  \`INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
   VALUES ($1, $2, $3, now())\`,
  [sentinelId, ownerId, createHash("sha256").update(sentinelId).digest("hex")],
);
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("ignores comment lines", () => {
      const content = `
// tokenHash: createHash("sha256").update("tok-11-a").digest("hex"),
 * tokenHash: "fixed-value-in-jsdoc",
`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });
  });

  describe("dangerous patterns are flagged", () => {
    it("flags tokenHash hashed from a double-quoted literal (the 2026-07-08 wedge)", () => {
      const content = `
await db.insert(userSessions).values({
  id: rid("sess11a"),
  userId: ownerId,
  tokenHash: createHash("sha256").update("tok-11-a").digest("hex"),
  expiresAt: new Date(Date.now() + 60_000),
});
`;
      const violations = scanTestContentForFixedSessionTokens(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(5);
      expect(violations[0].reason).toContain("user_sessions_token_hash_unique");
      expect(violations[0].reason).toContain("per-run-random");
    });

    it("flags tokenHash hashed from a single-quoted literal", () => {
      const content = `tokenHash: createHash('sha256').update('tok-fixed').digest('hex'),`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(1);
    });

    it("flags tokenHash hashed from a template literal WITHOUT interpolation", () => {
      const content = "tokenHash: createHash(`sha256`).update(`tok-fixed`).digest(`hex`),";
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(1);
    });

    it("flags a direct string-literal tokenHash", () => {
      const content = `
await db.insert(userSessions).values({
  tokenHash: "deadbeefdeadbeef",
});
`;
      const violations = scanTestContentForFixedSessionTokens(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(3);
    });

    it("flags snake_case token_hash object keys too", () => {
      const content = `const row = { token_hash: "fixed" };`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(1);
    });

    it("flags a literal hash when the value wraps onto the next line", () => {
      const content = `
await db.insert(userSessions).values({
  tokenHash: createHash("sha256")
    .update("tok-wrapped")
    .digest("hex"),
});
`;
      const violations = scanTestContentForFixedSessionTokens(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(3);
    });

    it("flags raw-SQL INSERT INTO user_sessions fed by a hashed literal", () => {
      const content = `
await dbPool.query(
  \`INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
   VALUES ($1, $2, $3, now())\`,
  [sessId, ownerId, createHash("sha256").update("tok-raw-sql").digest("hex")],
);
`;
      const violations = scanTestContentForFixedSessionTokens(content, FAKE_FILE);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].reason).toContain("user_sessions_token_hash_unique");
    });
  });

  describe("allow marker", () => {
    it("suppresses a flagged line carrying the allow marker", () => {
      const content = `tokenHash: createHash("sha256").update("tok-known").digest("hex"), // ${SESSION_TOKEN_ALLOW_MARKER}`;
      expect(scanTestContentForFixedSessionTokens(content, FAKE_FILE)).toHaveLength(0);
    });

    it("does not suppress other lines in the same file", () => {
      const content = `
const a = { tokenHash: "ok-here" }; // ${SESSION_TOKEN_ALLOW_MARKER}
const b = { tokenHash: "not-ok-here" };
`;
      const violations = scanTestContentForFixedSessionTokens(content, FAKE_FILE);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(3);
    });
  });
});
