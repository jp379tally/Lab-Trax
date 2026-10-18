import { describe, expect, it } from "vitest";
import { isDbUnavailable } from "./db-unavailable";
describe("safe pool-timeout classification", () => {
  it("finds wrapped checkout errors without treating normal errors as outages", () => {
    expect(isDbUnavailable(new Error("Failed query", { cause: new Error("timeout exceeded when trying to connect") }))).toBe(true);
    expect(isDbUnavailable(new Error("not authorized"))).toBe(false);
    expect(isDbUnavailable(new Error("statement timeout"))).toBe(false);
  });
  it("bounds cyclic causes", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(isDbUnavailable(error)).toBe(false);
  });
});
