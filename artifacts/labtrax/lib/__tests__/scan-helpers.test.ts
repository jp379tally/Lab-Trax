import { describe, it, expect } from "vitest";
import {
  decideManualEntry,
  shouldAutoAnalyze,
  resolveCloseAction,
  pickRawCaptureUri,
} from "../scan-helpers";

describe("decideManualEntry (deep-link manual mode guard)", () => {
  it("fires handleManualEntry when ?mode=manual is present and the nonce has not been applied yet", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "abc123",
      lastAppliedNonce: null,
      phase: "camera",
    });
    expect(result).toEqual({ kind: "fire", nextLastNonce: "abc123" });
  });

  it("does NOT fire again when the same nonce focuses the screen a second time", () => {
    // First focus: fire and record the nonce as applied.
    const first = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "abc123",
      lastAppliedNonce: null,
      phase: "form",
    });
    expect(first.kind).toBe("fire");

    // Second focus with the SAME nonce: must be a no-op (we're already on the form).
    const second = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "abc123",
      lastAppliedNonce: "abc123",
      phase: "form",
    });
    expect(second).toEqual({ kind: "noop" });
  });

  it("fires again when a fresh nonce is supplied (e.g. New Case tapped a second time)", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "nonce-2",
      lastAppliedNonce: "nonce-1",
      phase: "form",
    });
    expect(result).toEqual({ kind: "fire", nextLastNonce: "nonce-2" });
  });

  it("resets back to camera when manual mode is not requested and the user is not already on the form", () => {
    const result = decideManualEntry({
      manualModeRequested: false,
      currentNonce: null,
      lastAppliedNonce: null,
      phase: "review",
    });
    expect(result).toEqual({ kind: "reset" });
  });

  it("leaves the form alone when manual mode is not requested and the user is already on the form", () => {
    const result = decideManualEntry({
      manualModeRequested: false,
      currentNonce: null,
      lastAppliedNonce: "old-nonce",
      phase: "form",
    });
    expect(result).toEqual({ kind: "noop" });
  });
});

describe("shouldAutoAnalyze (one-shot review-phase auto-analyze guard)", () => {
  it("fires the first time the review phase is entered", () => {
    expect(shouldAutoAnalyze({ cancelled: false, alreadyFired: false })).toBe(true);
  });

  it("does NOT fire a second time within the same review session", () => {
    // Simulates the autoAnalyzedRef having been flipped to true after the
    // first invocation.
    expect(shouldAutoAnalyze({ cancelled: false, alreadyFired: true })).toBe(false);
  });

  it("does NOT fire if the review-phase effect was cancelled before the wait completed", () => {
    expect(shouldAutoAnalyze({ cancelled: true, alreadyFired: false })).toBe(false);
  });

  it("does NOT fire if both cancelled and already-fired are true", () => {
    expect(shouldAutoAnalyze({ cancelled: true, alreadyFired: true })).toBe(false);
  });
});

describe("resolveCloseAction (camera/review close button)", () => {
  it("from the review phase, discards captured pages and returns to camera", () => {
    const action = resolveCloseAction({ phase: "review", canGoBack: true });
    expect(action).toEqual({ kind: "discard-review" });
  });

  it("from the camera phase, calls router.back when the navigator can go back", () => {
    const action = resolveCloseAction({ phase: "camera", canGoBack: true });
    expect(action).toEqual({ kind: "router-back" });
  });

  it("from the camera phase, replaces to /(tabs) (the dashboard) when there is no history", () => {
    const action = resolveCloseAction({ phase: "camera", canGoBack: false });
    expect(action).toEqual({ kind: "router-replace", path: "/(tabs)" });
  });

  it("ignores canGoBack when in the review phase (review always discards in-place)", () => {
    const action = resolveCloseAction({ phase: "review", canGoBack: false });
    expect(action).toEqual({ kind: "discard-review" });
  });
});

describe("pickRawCaptureUri (handleTakePhoto error-fallback cascade)", () => {
  it("prefers the camera ref's URI when present", () => {
    const result = pickRawCaptureUri({
      cameraUri: "file://camera.jpg",
      webCanvasUri: "data:web",
      imagePickerUri: "file://picker.jpg",
    });
    expect(result).toEqual({ ok: true, uri: "file://camera.jpg" });
  });

  it("falls back to the web canvas URI when the camera ref returned nothing", () => {
    const result = pickRawCaptureUri({
      cameraUri: null,
      webCanvasUri: "data:image/jpeg;base64,XYZ",
      imagePickerUri: null,
    });
    expect(result).toEqual({ ok: true, uri: "data:image/jpeg;base64,XYZ" });
  });

  it("falls back to the ImagePicker URI when both camera and web canvas failed", () => {
    const result = pickRawCaptureUri({
      cameraUri: null,
      webCanvasUri: null,
      imagePickerUri: "file://picker.jpg",
    });
    expect(result).toEqual({ ok: true, uri: "file://picker.jpg" });
  });

  it("returns ok:false when every fallback failed — caller MUST surface an error, never silently swallow", () => {
    const result = pickRawCaptureUri({
      cameraUri: null,
      webCanvasUri: null,
      imagePickerUri: null,
    });
    expect(result).toEqual({ ok: false });
  });

  it("treats empty strings as a failed source (so the cascade keeps trying)", () => {
    const result = pickRawCaptureUri({
      cameraUri: "",
      webCanvasUri: "",
      imagePickerUri: "file://picker.jpg",
    });
    expect(result).toEqual({ ok: true, uri: "file://picker.jpg" });
  });
});
