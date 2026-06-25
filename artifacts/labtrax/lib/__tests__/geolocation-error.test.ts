import { describe, expect, it } from "vitest";
import {
  GEO_MESSAGES,
  GeolocationTimeoutError,
  geolocationErrorMessage,
  webGeolocationErrorMessage,
  withGeoTimeout,
  WEB_GEO_PERMISSION_DENIED,
  WEB_GEO_POSITION_UNAVAILABLE,
  WEB_GEO_TIMEOUT,
} from "../geolocation-error";

describe("geolocation-error messages", () => {
  it("maps the browser permission-denied code to an actionable message", () => {
    expect(webGeolocationErrorMessage(WEB_GEO_PERMISSION_DENIED)).toBe(
      GEO_MESSAGES.permissionDenied,
    );
  });

  it("distinguishes position-unavailable and timeout from permission-denied", () => {
    expect(webGeolocationErrorMessage(WEB_GEO_POSITION_UNAVAILABLE)).toBe(
      GEO_MESSAGES.positionUnavailable,
    );
    expect(webGeolocationErrorMessage(WEB_GEO_TIMEOUT)).toBe(GEO_MESSAGES.timeout);
    // The three are not collapsed into one generic string.
    expect(
      new Set([
        GEO_MESSAGES.permissionDenied,
        GEO_MESSAGES.positionUnavailable,
        GEO_MESSAGES.timeout,
      ]).size,
    ).toBe(3);
  });

  it("falls back to a generic-but-actionable message for unknown codes", () => {
    expect(webGeolocationErrorMessage(undefined)).toBe(GEO_MESSAGES.generic);
    expect(webGeolocationErrorMessage(99)).toBe(GEO_MESSAGES.generic);
  });

  it("classifies a thrown browser GeolocationPositionError (permission denied)", () => {
    // Simulates the object the browser rejects getCurrentPosition with.
    const denied = { code: WEB_GEO_PERMISSION_DENIED, message: "User denied" };
    expect(geolocationErrorMessage(denied)).toBe(GEO_MESSAGES.permissionDenied);
  });

  it("classifies the native timeout sentinel as a timeout message", () => {
    expect(geolocationErrorMessage(new GeolocationTimeoutError())).toBe(
      GEO_MESSAGES.timeout,
    );
  });

  it("classifies an unknown thrown value as the generic message", () => {
    expect(geolocationErrorMessage(new Error("boom"))).toBe(GEO_MESSAGES.generic);
  });
});

describe("withGeoTimeout", () => {
  it("rejects with GeolocationTimeoutError when the promise never settles", async () => {
    const never = new Promise<number>(() => {});
    await expect(withGeoTimeout(never, 10)).rejects.toBeInstanceOf(
      GeolocationTimeoutError,
    );
  });

  it("resolves with the value when the promise settles in time", async () => {
    await expect(withGeoTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("propagates the underlying rejection unchanged", async () => {
    const err = new Error("native-failure");
    await expect(withGeoTimeout(Promise.reject(err), 1000)).rejects.toBe(err);
  });
});
