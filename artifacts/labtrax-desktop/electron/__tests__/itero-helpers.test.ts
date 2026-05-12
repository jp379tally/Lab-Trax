import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const helpers = require("../itero-helpers.cjs") as {
  DEFAULT_POLL_INTERVAL_MIN: number;
  MIN_POLL_INTERVAL_MIN: number;
  MAX_POLL_INTERVAL_MIN: number;
  clampInterval: (v: unknown) => number;
  looksLikeLoginPage: (text: string | null | undefined) => boolean;
  normalizeStatusToken: (v: unknown) => string;
  isLabReviewOrder: (raw: unknown) => boolean;
};

const {
  DEFAULT_POLL_INTERVAL_MIN,
  MIN_POLL_INTERVAL_MIN,
  MAX_POLL_INTERVAL_MIN,
  clampInterval,
  looksLikeLoginPage,
  normalizeStatusToken,
  isLabReviewOrder,
} = helpers;

describe("clampInterval", () => {
  it("returns default when value is not finite", () => {
    expect(clampInterval(NaN)).toBe(DEFAULT_POLL_INTERVAL_MIN);
    expect(clampInterval("not-a-number")).toBe(DEFAULT_POLL_INTERVAL_MIN);
    expect(clampInterval(undefined)).toBe(DEFAULT_POLL_INTERVAL_MIN);
  });

  it("clamps below the minimum", () => {
    expect(clampInterval(0)).toBe(MIN_POLL_INTERVAL_MIN);
    expect(clampInterval(-100)).toBe(MIN_POLL_INTERVAL_MIN);
    expect(clampInterval(MIN_POLL_INTERVAL_MIN - 1)).toBe(MIN_POLL_INTERVAL_MIN);
  });

  it("clamps above the maximum", () => {
    expect(clampInterval(MAX_POLL_INTERVAL_MIN + 1)).toBe(MAX_POLL_INTERVAL_MIN);
    expect(clampInterval(99999)).toBe(MAX_POLL_INTERVAL_MIN);
  });

  it("rounds and accepts in-range values", () => {
    expect(clampInterval(30)).toBe(30);
    expect(clampInterval(30.4)).toBe(30);
    expect(clampInterval(30.6)).toBe(31);
    expect(clampInterval("45")).toBe(45);
  });
});

describe("looksLikeLoginPage", () => {
  it("returns false for empty/null inputs", () => {
    expect(looksLikeLoginPage("")).toBe(false);
    expect(looksLikeLoginPage(null)).toBe(false);
    expect(looksLikeLoginPage(undefined)).toBe(false);
  });

  it("detects an HTML login page", () => {
    const html =
      '<!doctype html><html><head><title>Login</title></head>' +
      '<body><form><input name="password" /></form></body></html>';
    expect(looksLikeLoginPage(html)).toBe(true);
  });

  it("rejects HTML pages that don't mention login/sign-in/password", () => {
    const html = "<html><body>Welcome to the dashboard</body></html>";
    expect(looksLikeLoginPage(html)).toBe(false);
  });

  it("rejects JSON responses even if they contain login keywords", () => {
    expect(looksLikeLoginPage('{"error":"login required"}')).toBe(false);
  });
});

describe("normalizeStatusToken", () => {
  it("handles null/undefined", () => {
    expect(normalizeStatusToken(null)).toBe("");
    expect(normalizeStatusToken(undefined)).toBe("");
  });

  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeStatusToken("Lab Review")).toBe("labreview");
    expect(normalizeStatusToken("LAB_REVIEW")).toBe("labreview");
    expect(normalizeStatusToken("lab-review")).toBe("labreview");
    expect(normalizeStatusToken("labReview")).toBe("labreview");
  });
});

describe("isLabReviewOrder", () => {
  it("returns false for falsy or non-object inputs", () => {
    expect(isLabReviewOrder(null)).toBe(false);
    expect(isLabReviewOrder(undefined)).toBe(false);
    expect(isLabReviewOrder("Lab Review")).toBe(false);
    expect(isLabReviewOrder(42)).toBe(false);
  });

  it("matches across alternate field names and spellings", () => {
    expect(isLabReviewOrder({ status: "Lab Review" })).toBe(true);
    expect(isLabReviewOrder({ orderStatus: "labReview" })).toBe(true);
    expect(isLabReviewOrder({ caseStatus: "LAB_REVIEW" })).toBe(true);
    expect(isLabReviewOrder({ statusName: "lab-review" })).toBe(true);
    expect(isLabReviewOrder({ workflowStatus: "labreview" })).toBe(true);
    expect(isLabReviewOrder({ state: "Lab Review" })).toBe(true);
    expect(isLabReviewOrder({ stage: "Lab Review" })).toBe(true);
    expect(isLabReviewOrder({ status: { name: "Lab Review" } })).toBe(true);
    expect(isLabReviewOrder({ status: { code: "LAB_REVIEW" } })).toBe(true);
  });

  it("rejects unrelated statuses", () => {
    expect(isLabReviewOrder({ status: "Sent to Doctor" })).toBe(false);
    expect(isLabReviewOrder({ status: "Completed" })).toBe(false);
    expect(isLabReviewOrder({ status: "Cancelled" })).toBe(false);
    expect(isLabReviewOrder({})).toBe(false);
  });
});
