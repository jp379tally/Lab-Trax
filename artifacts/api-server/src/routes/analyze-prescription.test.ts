/**
 * Regression guard for POST /api/analyze-prescription — the endpoint behind the
 * mobile app's "AI reader" (Scan tab). This is the path that kept silently
 * breaking; the older cases-ai-reader.test.ts never exercised it.
 *
 * The OpenAI SDK is fully mocked here so the suite is deterministic and does NOT
 * depend on the live Replit AI proxy or on which models it currently serves.
 * It does not touch the database (the route is stateless, called anonymously).
 *
 * Coverage:
 *  - 400 when no image is provided
 *  - 400 IMAGE_TOO_SMALL for a truncated/corrupt payload
 *  - 400 for unsupported HEIC input
 *  - 200 happy path: returns extracted fields and fixes "Last, First" name order
 *  - resilient model chain: falls through legacy models to a current-gen model,
 *    and the current-gen call omits `temperature` (gpt-5+ rejects it)
 *  - 500 when every model in the chain fails
 *
 * The companion suite in cases-ai-reader.test.ts guards the 503 "AI not
 * configured" branch (it runs with the API key deleted).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-analyze"),
  extractMediaFileName: () => null,
}));

// Shared, reconfigurable mock for chat.completions.create.
const mockCreate = vi.fn();
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: (...args: any[]) => mockCreate(...args) } };
    constructor(_opts: any) {}
  }
  return { default: FakeOpenAI, toFile: vi.fn() };
});

// A non-HEIC, non-PDF JPEG data URI whose raw base64 clears the 5000-char floor.
const VALID_IMAGE = `data:image/jpeg;base64,${"A".repeat(6000)}`;

function aiJson(obj: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

describe("POST /api/analyze-prescription (mobile AI reader)", () => {
  let appMod: { default: import("express").Express };
  let savedKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeAll(async () => {
    savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    savedBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://example.invalid/v1";
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-analyze-rx";
    appMod = await import("../app.js");
    await vi.waitFor(async () => {
      expect((await request(appMod.default).get("/api/__test_missing_route__")).status).toBe(404);
    }, { timeout: 15_000, interval: 25 });
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;
    else delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (savedBaseUrl !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBaseUrl;
    else delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  });

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("sends every supplied page through the accurate desktop chain without hidden SDK retries", async () => {
    mockCreate.mockResolvedValueOnce(aiJson({ patientName: "Fixture", confidence: 0.9 }));
    const result = await request(appMod.default).post("/api/analyze-prescription").send({
      imageBase64: VALID_IMAGE, additionalImages: [VALID_IMAGE, VALID_IMAGE, VALID_IMAGE], desktopReader: true,
    });
    expect(result.status).toBe(200);
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.model).toBe("gpt-5.4");
    expect(params.messages[1].content.filter((item: any) => item.type === "image_url")).toHaveLength(4);
    expect(options).toMatchObject({ timeout: 30_000, maxRetries: 0 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(result.headers["server-timing"]).toContain("rxModel1");
    expect(result.headers["server-timing"]).toContain("rxPreprocess");
  });

  it("retains native fast mode and explicit fallback rather than SDK retry multiplication", async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }));
    mockCreate.mockResolvedValueOnce(aiJson({ patientName: "Fixture", confidence: 0.9 }));
    const result = await request(appMod.default).post("/api/analyze-prescription").send({ imageBase64: VALID_IMAGE, fast: true });
    expect(result.status).toBe(200);
    expect(mockCreate.mock.calls.map(([params]) => params.model)).toEqual(["gpt-5-mini", "gpt-5"]);
    for (const [, options] of mockCreate.mock.calls) {
      expect(options.maxRetries).toBe(0);
      expect(options.timeout).toBeLessThanOrEqual(30_000);
    }
  });

  it("stops fallback after the client disconnects even when the model adapter ignores cancellation", async () => {
    mockCreate.mockImplementation(() => new Promise(() => {}));
    const pending = request(appMod.default).post("/api/analyze-prescription").send({ imageBase64: VALID_IMAGE, desktopReader: true });
    pending.end(() => {});
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const signal = mockCreate.mock.calls[0][1].signal as AbortSignal;
    pending.abort();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when no image is provided", async () => {
    const r = await request(appMod.default).post("/api/analyze-prescription").send({});
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 IMAGE_TOO_SMALL for a truncated payload", async () => {
    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: `data:image/jpeg;base64,${"A".repeat(100)}` });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("IMAGE_TOO_SMALL");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported HEIC input", async () => {
    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: `data:image/heic;base64,${"A".repeat(6000)}` });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("HEIC");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns extracted fields and fixes Last, First name order on success", async () => {
    mockCreate.mockResolvedValueOnce(
      aiJson({
        doctorName: "Smith, John",
        patientName: "Doe, Jane",
        caseType: "Crown & Bridge",
        shade: "A2",
        gingivialShade: null,
        isRush: false,
        confidence: 0.92,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.doctorName).toBe("John Smith");
    expect(r.body.data.patientName).toBe("Jane Doe");
    expect(r.body.data.shade).toBe("A2");
    // Confidence drives the mobile live-scan auto-fill gate; it must survive
    // the server-side cleanup and reach the client.
    expect(r.body.data.confidence).toBe(0.92);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Leads with the current-gen high-accuracy model, not a legacy gpt-4o.
    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-5.4");
    // gpt-5+ rejects `temperature`; it must never be sent.
    expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();
  });

  it("uses the fast (gpt-5-mini) chain for live-scan detection requests", async () => {
    mockCreate.mockResolvedValueOnce(aiJson({ patientName: "Pat Roe", confidence: 0.4 }));

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE, fast: true });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Fast mode leads with the quick model so the live preview stays responsive.
    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-5-mini");
  });

  it("falls through the model chain to a current-gen model that omits temperature", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("model gpt-5.4 not available"))
      .mockRejectedValueOnce(new Error("model gpt-5 not available"))
      .mockResolvedValueOnce(aiJson({ patientName: "Pat Roe" }));

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.patientName).toBe("Pat Roe");
    expect(mockCreate).toHaveBeenCalledTimes(3);

    // The final attempt must NOT send temperature — gpt-5+ rejects it.
    const finalParams = mockCreate.mock.calls[2][0];
    expect(finalParams.model).not.toMatch(/^gpt-4o/);
    expect(finalParams.temperature).toBeUndefined();
  });

  it("bounds stalled model attempts, preserves accurate fallback order, and returns actionable timeout guidance", async () => {
    mockCreate.mockRejectedValue(new Error("request timed out"));

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE, desktopReader: true });

    expect(r.status).toBe(504);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/timed out.*Try again/i);
    expect(mockCreate.mock.calls.map(([params]) => params.model)).toEqual([
      "gpt-5.4",
      "gpt-5",
      "gpt-5-mini",
    ]);
    expect(mockCreate.mock.calls.map(([, options]) => options.timeout)).toEqual([
      30_000,
      30_000,
      30_000,
    ]);
  });

  it("returns 500 when every model in the chain fails", async () => {
    mockCreate.mockRejectedValue(new Error("proxy down"));

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("sends anyOf-based nullable fields in the strict JSON schema (regression guard)", async () => {
    mockCreate.mockResolvedValueOnce(aiJson({ patientName: "Pat Roe", confidence: 0.8 }));

    await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const schema =
      mockCreate.mock.calls[0][0].response_format?.json_schema?.schema ?? {};
    const props = schema.properties ?? {};

    // Every nullable string field must use anyOf, not the array-union shorthand
    // { type: ["string", "null"] } which OpenAI strict mode rejects with a 400.
    const nullableStringFields = [
      "doctorName",
      "patientName",
      "patientInitials",
      "caseType",
      "toothIndices",
      "shade",
      "gingivialShade",
      "material",
      "dueDate",
      "notes",
      "practiceName",
      "practiceAddress",
      "practicePhone",
    ];
    for (const field of nullableStringFields) {
      const def = props[field];
      expect(
        def,
        `${field} must be defined in the schema`
      ).toBeDefined();
      expect(
        Array.isArray(def.type),
        `${field} must NOT use array-union type syntax (type: ["string","null"]); use anyOf instead`
      ).toBe(false);
      expect(
        def.anyOf,
        `${field} must use anyOf for nullable definition`
      ).toBeDefined();
      const anyOfTypes = (def.anyOf as { type: string }[]).map((x) => x.type);
      expect(anyOfTypes).toContain("string");
      expect(anyOfTypes).toContain("null");
    }

    // isRush is the nullable boolean field — same anyOf requirement.
    const isRush = props["isRush"];
    expect(isRush).toBeDefined();
    expect(Array.isArray(isRush.type)).toBe(false);
    expect(isRush.anyOf).toBeDefined();
    const isRushTypes = (isRush.anyOf as { type: string }[]).map((x) => x.type);
    expect(isRushTypes).toContain("boolean");
    expect(isRushTypes).toContain("null");
  });

  it("includes restorationSubtype when caseType and material are both recognised (zirconia crown smoke test)", async () => {
    // AI returns "Crown & Bridge" + "Zirconia" → server must derive and return
    // the encoded taxonomy key "restorative/crown_and_bridge/zirconia" so the
    // mobile client can store it on caseRestorations without re-deriving it.
    mockCreate.mockResolvedValueOnce(
      aiJson({
        doctorName: "Dr. Synthetic063",
        patientName: "Jane Doe",
        caseType: "Crown & Bridge",
        material: "Zirconia",
        shade: "A2",
        isRush: false,
        confidence: 0.95,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.caseType).toBe("Crown & Bridge");
    expect(r.body.data.material).toBe("Zirconia");
    // The server must derive and return the encoded taxonomy subtype.
    expect(r.body.data.restorationSubtype).toBe("restorative/crown_and_bridge/zirconia");
  });

  it("omits restorationSubtype when the caseType/material pair is unrecognised", async () => {
    mockCreate.mockResolvedValueOnce(
      aiJson({
        patientName: "Pat Roe",
        caseType: "Other",
        material: null,
        confidence: 0.5,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    // "Other" caseType has no taxonomy subtype; restorationSubtype must be absent.
    expect(r.body.data.restorationSubtype).toBeUndefined();
  });

  it("omits restorationSubtype when confidence is below 0.7 even if caseType and material are present", async () => {
    // Low-confidence AI extraction: both fields are present but the model
    // is not sure enough. We must NOT pre-fill the restoration drawer with a
    // potentially wrong subtype.
    mockCreate.mockResolvedValueOnce(
      aiJson({
        doctorName: "Dr. Synthetic063",
        patientName: "Jane Doe",
        caseType: "Crown & Bridge",
        material: "Zirconia",
        shade: "A2",
        isRush: false,
        confidence: 0.6,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.caseType).toBe("Crown & Bridge");
    expect(r.body.data.material).toBe("Zirconia");
    // Confidence 0.6 < 0.7 threshold → subtype must be suppressed.
    expect(r.body.data.restorationSubtype).toBeUndefined();
  });

  it("omits restorationSubtype when material is missing even with high confidence", async () => {
    // Without a material field, inferring the subtype would force the client
    // to pick one, hiding the fact that it is unknown.
    mockCreate.mockResolvedValueOnce(
      aiJson({
        patientName: "Jane Doe",
        caseType: "Crown & Bridge",
        material: null,
        confidence: 0.9,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.caseType).toBe("Crown & Bridge");
    // No material in extraction → subtype must be absent regardless of confidence.
    expect(r.body.data.restorationSubtype).toBeUndefined();
  });

  // Guards the "AI not configured" branch without needing a database, so it
  // always runs in CI (the DB-gated cases-ai-reader.test.ts version is skipped
  // when DATABASE_URL is absent). Kept last: it rebuilds the module graph with
  // the key removed, which must not disturb the shared `appMod` used above.
  it("returns 503 when AI is not configured", async () => {
    const prevKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    vi.resetModules();
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    try {
      const freshApp = (await import("../app.js")).default;
      const r = await request(freshApp)
        .post("/api/analyze-prescription")
        .send({ imageBase64: VALID_IMAGE });
      expect(r.status).toBe(503);
      expect(r.body.success).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = prevKey;
      vi.resetModules();
    }
  });
});
