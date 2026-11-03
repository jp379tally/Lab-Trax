import { describe, it } from "vitest";
import * as assert from "node:assert/strict";
import { prescriptionAiFailure } from "./prescription-ai-error";

describe("prescription provider failure reporting", () => {
  it("stops invalid credentials and exhausted account quota without repeating paid calls", () => {
    for (const input of [{ status: 401 }, { code: "invalid_api_key" }, { status: 429, error: { code: "insufficient_quota" } }]) {
      const result = prescriptionAiFailure(input);
      assert.equal(result.status, 503);
      assert.equal(result.body.success, false);
      assert.equal(result.tryNextModel, false);
      assert.match(result.body.error, /administrator/);
    }
  });
  it("keeps fallback for model availability, model-specific permission, and transient errors", () => {
    for (const input of [{ status: 403 }, { status: 404 }, { status: 429 }, { status: 503 }]) {
      const result = prescriptionAiFailure(input);
      assert.equal(result.tryNextModel, true);
      assert.equal(result.status, 503);
    }
  });
  it("distinguishes rejected requests, connections, timeouts and unknown errors", () => {
    assert.equal(prescriptionAiFailure({ status: 400 }).body.code, "AI_REQUEST_REJECTED");
    assert.equal(prescriptionAiFailure({ status: 422 }).status, 502);
    assert.equal(prescriptionAiFailure({ name: "APIConnectionError" }).body.code, "AI_SERVICE_UNAVAILABLE");
    assert.equal(prescriptionAiFailure({ name: "APIConnectionTimeoutError" }).status, 504);
    assert.equal(prescriptionAiFailure(new Error("synthetic unknown")).status, 500);
    assert.equal(prescriptionAiFailure(null).body.code, "AI_ANALYSIS_FAILED");
  });
  it("never exposes provider messages, arbitrary names/codes, credentials, headers or echoed prescription contents", () => {
    const secret = "SYNTHETIC_SECRET_MUST_NOT_APPEAR";
    const result = prescriptionAiFailure({
      status: 400, code: secret, name: secret, message: secret,
      error: { code: secret, message: secret }, headers: { authorization: secret }, body: secret,
    });
    assert.deepEqual(result.diagnostics, { failureKind: "request", upstreamStatus: 400 });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(prescriptionAiFailure({ status: "SYNTHETIC_UNTRUSTED" }).diagnostics, { failureKind: "unknown" });
    assert.deepEqual(prescriptionAiFailure({ status: NaN }).diagnostics, { failureKind: "unknown" });
  });
});
