/**
 * Shared, pure helpers for turning a geolocation failure into a clear,
 * actionable user-facing message. Used by the signup address-autofill flow
 * (LoginScreen) on both web (browser `navigator.geolocation`) and native
 * (`expo-location`). Keeping the mapping here (instead of inline) makes the
 * "no silent failure" guarantee unit-testable.
 */

export const GEO_MESSAGES = {
  webUnsupported:
    "Location isn't supported on this browser. Please type your address manually.",
  permissionDenied:
    "Location permission denied. Please type your address manually.",
  positionUnavailable:
    "Couldn't get your location — GPS is unavailable. Please type your address manually.",
  timeout:
    "Getting your location took too long. Please type your address manually.",
  noAddress: "Could not determine your address. Please type it manually.",
  generic: "Location unavailable. Please type your address manually.",
} as const;

// Browser `GeolocationPositionError` code values (per the W3C spec).
export const WEB_GEO_PERMISSION_DENIED = 1;
export const WEB_GEO_POSITION_UNAVAILABLE = 2;
export const WEB_GEO_TIMEOUT = 3;

/**
 * Map a browser GeolocationPositionError.code to a clear message so a denied
 * permission, an unavailable fix, and a timeout are never collapsed into one
 * generic "Location unavailable" string.
 */
export function webGeolocationErrorMessage(
  code: number | undefined | null,
): string {
  switch (code) {
    case WEB_GEO_PERMISSION_DENIED:
      return GEO_MESSAGES.permissionDenied;
    case WEB_GEO_POSITION_UNAVAILABLE:
      return GEO_MESSAGES.positionUnavailable;
    case WEB_GEO_TIMEOUT:
      return GEO_MESSAGES.timeout;
    default:
      return GEO_MESSAGES.generic;
  }
}

/**
 * Sentinel thrown when a geolocation lookup exceeds its time budget. Native
 * `Location.getCurrentPositionAsync` has no built-in timeout, so without this
 * a stuck GPS fix would spin the button forever (a silent failure).
 */
export class GeolocationTimeoutError extends Error {
  constructor() {
    super("geolocation-timeout");
    this.name = "GeolocationTimeoutError";
  }
}

/**
 * Race a promise against a timeout. Rejects with GeolocationTimeoutError if the
 * promise does not settle within `ms`. The underlying promise is left to settle
 * on its own (we cannot cancel a native location request), but the caller is
 * unblocked and shows an actionable message.
 */
export function withGeoTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GeolocationTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Best-effort classification of any thrown geolocation error into a message.
 * Handles our timeout sentinel, browser GeolocationPositionError (numeric
 * `code`), and falls back to a generic-but-actionable message.
 */
export function geolocationErrorMessage(error: unknown): string {
  if (error instanceof GeolocationTimeoutError) return GEO_MESSAGES.timeout;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  ) {
    return webGeolocationErrorMessage((error as { code: number }).code);
  }
  return GEO_MESSAGES.generic;
}
