import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import {
  isForbiddenError,
  retryUnlessForbidden,
  haltPollingIfForbidden,
} from "@/lib/platform-admin-query";

describe("platform-admin-query helpers", () => {
  describe("isForbiddenError", () => {
    it("is true only for an ApiError with status 403", () => {
      expect(isForbiddenError(new ApiError("nope", 403))).toBe(true);
      expect(isForbiddenError(new ApiError("nope", 401))).toBe(false);
      expect(isForbiddenError(new ApiError("nope", 500))).toBe(false);
      expect(isForbiddenError(new Error("plain"))).toBe(false);
      expect(isForbiddenError(null)).toBe(false);
      expect(isForbiddenError(undefined)).toBe(false);
    });
  });

  describe("retryUnlessForbidden", () => {
    it("never retries a 403", () => {
      expect(retryUnlessForbidden(0, new ApiError("forbidden", 403))).toBe(false);
      expect(retryUnlessForbidden(5, new ApiError("forbidden", 403))).toBe(false);
    });

    it("retries other errors once (mirrors the app default)", () => {
      const err = new ApiError("boom", 500);
      expect(retryUnlessForbidden(0, err)).toBe(true);
      expect(retryUnlessForbidden(1, err)).toBe(false);
    });
  });

  describe("haltPollingIfForbidden", () => {
    it("returns false when the query's last error is a 403", () => {
      const interval = haltPollingIfForbidden(5000);
      const query = { state: { error: new ApiError("forbidden", 403) } };
      expect(interval(query)).toBe(false);
    });

    it("uses the base interval when there is no forbidden error", () => {
      const interval = haltPollingIfForbidden(5000);
      expect(interval({ state: { error: null } })).toBe(5000);
      expect(interval({ state: { error: new ApiError("boom", 500) } })).toBe(5000);
    });

    it("supports a function base and short-circuits it on a 403", () => {
      let called = 0;
      const interval = haltPollingIfForbidden((q: { state: { error: unknown } }) => {
        called += 1;
        return 1234;
      });
      expect(interval({ state: { error: null } })).toBe(1234);
      expect(called).toBe(1);
      // On a 403 the base function must not run.
      expect(interval({ state: { error: new ApiError("forbidden", 403) } })).toBe(false);
      expect(called).toBe(1);
    });
  });
});
