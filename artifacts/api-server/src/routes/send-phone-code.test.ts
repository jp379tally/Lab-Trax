/**
 * Unit tests for POST /api/send-phone-code — covering the four key branching
 * paths without requiring a live database or real SMS credentials.
 *
 * createVerificationCode is mocked so the DB is never touched, and
 * globalThis.fetch is stubbed per-test to simulate Vonage responses.
 *
 * Coverage:
 *  - 400 when phone is missing from the request body
 *  - 503 when SMS provider vars are absent in production (NODE_ENV=production)
 *  - 400 when the phone string cannot be normalised to E.164 (invalid format)
 *  - 200 when provider succeeds — code is persisted ONLY after SMS success
 *  - 500 when provider returns an error — code is NOT persisted
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import * as path from "node:path";
import type { Express } from "express";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    require("os").tmpdir(),
    "labtrax-test-send-phone-code",
  ),
  extractMediaFileName: () => null,
}));

const createVerificationCodeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/verification.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/verification.js")>();
  return {
    ...actual,
    createVerificationCode: (...args: unknown[]) =>
      createVerificationCodeMock(...args),
  };
});

function makeVonageSuccessResponse() {
  return new Response(
    JSON.stringify({
      "message-count": "1",
      messages: [
        {
          status: "0",
          "message-id": "03000000A0000B0C",
          to: "+15550001111",
          "remaining-balance": "123.45",
          "message-price": "0.05",
          network: "310000",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeVonageErrorResponse() {
  return new Response(
    JSON.stringify({
      "message-count": "1",
      messages: [
        {
          status: "3",
          "error-text": "Invalid request :: Invalid 'to' address",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("POST /api/send-phone-code", () => {
  let app: Express;

  let savedNodeEnv: string | undefined;
  let savedSid: string | undefined;
  let savedToken: string | undefined;
  let savedFrom: string | undefined;

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-send-phone-code";
    const appMod = await import("../app.js");
    app = appMod.default;
  });

  beforeEach(() => {
    createVerificationCodeMock.mockClear();

    savedNodeEnv = process.env["NODE_ENV"];
    savedSid = process.env["VONAGE_API_KEY"];
    savedToken = process.env["VONAGE_API_SECRET"];
    savedFrom = process.env["VONAGE_PHONE_NUMBER"];

    // Default: Vonage credentials present + Vonage call succeeds.
    // Individual tests override these as needed.
    process.env["VONAGE_API_KEY"] = "test_key";
    process.env["VONAGE_API_SECRET"] = "test_secret";
    process.env["VONAGE_PHONE_NUMBER"] = "+15550001111";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _opts: unknown) =>
        makeVonageSuccessResponse(),
      ),
    );
  });

  afterEach(() => {
    if (savedNodeEnv !== undefined) process.env["NODE_ENV"] = savedNodeEnv;
    else delete process.env["NODE_ENV"];

    if (savedSid !== undefined) process.env["VONAGE_API_KEY"] = savedSid;
    else delete process.env["VONAGE_API_KEY"];

    if (savedToken !== undefined)
      process.env["VONAGE_API_SECRET"] = savedToken;
    else delete process.env["VONAGE_API_SECRET"];

    if (savedFrom !== undefined)
      process.env["VONAGE_PHONE_NUMBER"] = savedFrom;
    else delete process.env["VONAGE_PHONE_NUMBER"];
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when phone is missing from the request body", async () => {
    const r = await request(app).post("/api/send-phone-code").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/phone/i);
    expect(createVerificationCodeMock).not.toHaveBeenCalled();
  });

  it("returns 503 when SMS provider is not configured in production", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["VONAGE_API_KEY"];
    delete process.env["VONAGE_API_SECRET"];
    delete process.env["VONAGE_PHONE_NUMBER"];

    // Unique phone per test to avoid the per-identifier cooldown window in
    // createSendCodeThrottle, which is intentionally NOT disabled under VITEST.
    const r = await request(app)
      .post("/api/send-phone-code")
      .send({ phone: "5550001001" });

    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not configured/i);
    // No code should be persisted — SMS was never attempted.
    expect(createVerificationCodeMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the phone number cannot be normalised to E.164", async () => {
    // "abc" strips to zero digits — below the 7-digit floor for E.164.
    // The throttle passes requests through when it cannot extract an identifier,
    // so a non-digit-only value is safe to use across tests without collisions.
    const r = await request(app)
      .post("/api/send-phone-code")
      .send({ phone: "abc" });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid phone/i);
    expect(createVerificationCodeMock).not.toHaveBeenCalled();
  });

  it("returns 200 and persists the code only after provider succeeds", async () => {
    // Unique phone — avoids the 30-second per-identifier cooldown gate in
    // createSendCodeThrottle which is active even under VITEST.
    // Default fetch stub already returns a provider success.
    const r = await request(app)
      .post("/api/send-phone-code")
      .send({ phone: "5550002002" });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // Code MUST have been stored exactly once, and only after SMS success.
    expect(createVerificationCodeMock).toHaveBeenCalledOnce();
    expect(createVerificationCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms" }),
    );
  });

  it("returns 500 and does NOT persist a code when provider returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _opts: unknown) =>
        makeVonageErrorResponse(),
      ),
    );

    // Unique phone to avoid the per-identifier cooldown.
    const r = await request(app)
      .post("/api/send-phone-code")
      .send({ phone: "5550003003" });

    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/failed to send/i);
    // Critical invariant: no code must be persisted when the SMS was not sent.
    expect(createVerificationCodeMock).not.toHaveBeenCalled();
  });

  it("does NOT block a retry with 429 after a failed provider send", async () => {
    // First call — provider errors out (500 from our handler).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _opts: unknown) =>
        makeVonageErrorResponse(),
      ),
    );

    // Unique phone so the rolling-window limit is not a factor.
    const phone = "5550004004";

    const first = await request(app)
      .post("/api/send-phone-code")
      .send({ phone });

    expect(first.status).toBe(500);

    // Second call — provider now succeeds. Must NOT be blocked by the cooldown
    // because the first call never successfully delivered an SMS.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _opts: unknown) =>
        makeVonageSuccessResponse(),
      ),
    );

    const second = await request(app)
      .post("/api/send-phone-code")
      .send({ phone });

    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(createVerificationCodeMock).toHaveBeenCalledOnce();
  });
});
