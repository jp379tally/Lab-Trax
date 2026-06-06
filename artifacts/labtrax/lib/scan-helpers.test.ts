/**
 * Unit tests for scan-helpers.ts pure functions (AI Reader regression guard).
 *
 * Invariants protected:
 *  - shouldAutoAnalyze: fires exactly once per phase entry unless cancelled
 *  - decideManualEntry: fires manual entry once per nonce; resets to camera when not on form; noops on form
 *  - resolveCloseAction: review → discard; camera+canGoBack → router-back; camera+!canGoBack → replace tabs
 *  - pickRawCaptureUri: prefers cameraUri > webCanvasUri > imagePickerUri; returns ok:false when all absent
 *
 * All inputs are plain objects; no RN/Expo imports needed.
 */
import { describe, expect, it } from "vitest";
import {
  shouldAutoAnalyze,
  decideManualEntry,
  resolveCloseAction,
  pickRawCaptureUri,
  type ScanPhase,
} from "./scan-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// shouldAutoAnalyze
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldAutoAnalyze", () => {
  it("returns true when not cancelled and not already fired", () => {
    expect(shouldAutoAnalyze({ cancelled: false, alreadyFired: false })).toBe(true);
  });

  it("returns false when already fired", () => {
    expect(shouldAutoAnalyze({ cancelled: false, alreadyFired: true })).toBe(false);
  });

  it("returns false when cancelled", () => {
    expect(shouldAutoAnalyze({ cancelled: true, alreadyFired: false })).toBe(false);
  });

  it("returns false when both cancelled and already fired", () => {
    expect(shouldAutoAnalyze({ cancelled: true, alreadyFired: true })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideManualEntry
// ─────────────────────────────────────────────────────────────────────────────

describe("decideManualEntry", () => {
  it("fires when manualModeRequested and nonce hasn't been applied yet", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "abc",
      lastAppliedNonce: null,
      phase: "camera",
    });
    expect(result.kind).toBe("fire");
    if (result.kind === "fire") {
      expect(result.nextLastNonce).toBe("abc");
    }
  });

  it("fires when nonce changed from previous value", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "xyz",
      lastAppliedNonce: "abc",
      phase: "camera",
    });
    expect(result.kind).toBe("fire");
    if (result.kind === "fire") {
      expect(result.nextLastNonce).toBe("xyz");
    }
  });

  it("does NOT fire when nonce was already applied (same nonce)", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "abc",
      lastAppliedNonce: "abc",
      phase: "camera",
    });
    expect(result.kind).not.toBe("fire");
  });

  it("returns reset when not on form phase and manual mode not requested", () => {
    for (const phase of ["camera", "scanning", "detected", "review"] as ScanPhase[]) {
      const result = decideManualEntry({
        manualModeRequested: false,
        currentNonce: null,
        lastAppliedNonce: null,
        phase,
      });
      expect(result.kind).toBe("reset");
    }
  });

  it("returns noop when on form phase and manual mode not requested", () => {
    const result = decideManualEntry({
      manualModeRequested: false,
      currentNonce: null,
      lastAppliedNonce: null,
      phase: "form",
    });
    expect(result.kind).toBe("noop");
  });

  it("does not fire when manualModeRequested is false even with new nonce", () => {
    const result = decideManualEntry({
      manualModeRequested: false,
      currentNonce: "new-nonce",
      lastAppliedNonce: null,
      phase: "camera",
    });
    expect(result.kind).toBe("reset");
  });

  it("fire result carries the current nonce as nextLastNonce", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: "nonce-42",
      lastAppliedNonce: null,
      phase: "form",
    });
    expect(result.kind).toBe("fire");
    if (result.kind === "fire") expect(result.nextLastNonce).toBe("nonce-42");
  });

  it("fire result carries null nextLastNonce when currentNonce is null", () => {
    const result = decideManualEntry({
      manualModeRequested: true,
      currentNonce: null,
      lastAppliedNonce: "old",
      phase: "camera",
    });
    expect(result.kind).toBe("fire");
    if (result.kind === "fire") expect(result.nextLastNonce).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCloseAction
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCloseAction", () => {
  it("returns discard-review when phase is review", () => {
    const result = resolveCloseAction({ phase: "review", canGoBack: true });
    expect(result.kind).toBe("discard-review");
  });

  it("returns discard-review in review phase even when canGoBack is false", () => {
    const result = resolveCloseAction({ phase: "review", canGoBack: false });
    expect(result.kind).toBe("discard-review");
  });

  it("returns router-back when not in review and canGoBack is true", () => {
    for (const phase of ["camera", "scanning", "detected", "form"] as ScanPhase[]) {
      const result = resolveCloseAction({ phase, canGoBack: true });
      expect(result.kind).toBe("router-back");
    }
  });

  it("returns router-replace to /(tabs) when not in review and cannot go back", () => {
    for (const phase of ["camera", "scanning", "detected", "form"] as ScanPhase[]) {
      const result = resolveCloseAction({ phase, canGoBack: false });
      expect(result.kind).toBe("router-replace");
      if (result.kind === "router-replace") {
        expect(result.path).toBe("/(tabs)");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickRawCaptureUri
// ─────────────────────────────────────────────────────────────────────────────

describe("pickRawCaptureUri", () => {
  it("prefers cameraUri over webCanvasUri and imagePickerUri", () => {
    const result = pickRawCaptureUri({
      cameraUri: "camera://shot.jpg",
      webCanvasUri: "data:image/png;base64,canvas",
      imagePickerUri: "file://picker.jpg",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe("camera://shot.jpg");
  });

  it("falls back to webCanvasUri when cameraUri is absent", () => {
    const result = pickRawCaptureUri({
      cameraUri: null,
      webCanvasUri: "data:image/png;base64,canvas",
      imagePickerUri: "file://picker.jpg",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe("data:image/png;base64,canvas");
  });

  it("falls back to imagePickerUri when cameraUri and webCanvasUri are absent", () => {
    const result = pickRawCaptureUri({
      cameraUri: undefined,
      webCanvasUri: undefined,
      imagePickerUri: "file://picker.jpg",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe("file://picker.jpg");
  });

  it("returns ok:false when all sources are null/undefined", () => {
    const result = pickRawCaptureUri({
      cameraUri: null,
      webCanvasUri: null,
      imagePickerUri: null,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when all sources are undefined", () => {
    const result = pickRawCaptureUri({});
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when all sources are empty strings (falsy)", () => {
    const result = pickRawCaptureUri({
      cameraUri: "",
      webCanvasUri: "",
      imagePickerUri: "",
    });
    expect(result.ok).toBe(false);
  });

  it("uses cameraUri when webCanvas and picker are missing", () => {
    const result = pickRawCaptureUri({ cameraUri: "camera://only.jpg" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe("camera://only.jpg");
  });
});
