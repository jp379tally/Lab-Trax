import { describe, it, expect } from "vitest";
import { extractPgCode, wrapDbError, HttpError } from "./http";

describe("extractPgCode", () => {
  it("extracts code from a top-level pg-like error", () => {
    expect(extractPgCode({ code: "23505" })).toBe("23505");
  });

  it("extracts code from a Drizzle wrapper whose cause has the code", () => {
    expect(extractPgCode({ cause: { code: "23502" } })).toBe("23502");
  });

  it("returns undefined for a plain Error with no code", () => {
    expect(extractPgCode(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractPgCode(null)).toBeUndefined();
  });

  it("returns undefined for a string", () => {
    expect(extractPgCode("not an error")).toBeUndefined();
  });
});

describe("wrapDbError", () => {
  it("maps 23505 → 409 with default message", () => {
    expect(() => wrapDbError({ code: "23505" })).toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
  });

  it("maps 23505 → 409 with custom duplicate message", () => {
    let thrown: unknown;
    try {
      wrapDbError({ code: "23505" }, { duplicate: "Already exists." });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(409);
    expect((thrown as HttpError).message).toBe("Already exists.");
  });

  it("maps 23502 → 400 with default message", () => {
    let thrown: unknown;
    try {
      wrapDbError({ code: "23502" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(400);
    expect((thrown as HttpError).message).not.toMatch(/insert into|drizzle/i);
  });

  it("maps 23502 → 400 with custom notNull message", () => {
    let thrown: unknown;
    try {
      wrapDbError({ code: "23502" }, { notNull: "Practice name is required." });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HttpError).statusCode).toBe(400);
    expect((thrown as HttpError).message).toBe("Practice name is required.");
  });

  it("maps 23514 → 400 with default message", () => {
    let thrown: unknown;
    try {
      wrapDbError({ code: "23514" });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HttpError).statusCode).toBe(400);
  });

  it("maps 23514 → 400 with custom checkViolation message", () => {
    let thrown: unknown;
    try {
      wrapDbError({ code: "23514" }, { checkViolation: "Invalid value." });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HttpError).message).toBe("Invalid value.");
  });

  it("maps an unrecognised pg code → 500 with safe fallback (no raw SQL)", () => {
    const rawDrizzleErr = {
      message:
        "insert into organizations (name) values ($1) -- duplicate key violates constraint",
      code: "42P01",
    };
    let thrown: unknown;
    try {
      wrapDbError(rawDrizzleErr);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(500);
    expect((thrown as HttpError).message).not.toMatch(/insert into|organizations|drizzle/i);
  });

  it("maps a plain Error with no pg code → 500 with safe fallback", () => {
    let thrown: unknown;
    try {
      wrapDbError(new Error("ECONNREFUSED: database is down"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(500);
    expect((thrown as HttpError).message).not.toMatch(/ECONNREFUSED/i);
  });

  it("maps an unknown error type → 500 with safe fallback", () => {
    let thrown: unknown;
    try {
      wrapDbError("unexpected string error");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(500);
  });

  it("extracts pg code from Drizzle-wrapped cause (23505)", () => {
    const drizzleWrapped = {
      message: "DrizzleQueryError",
      cause: { code: "23505", message: "duplicate key value violates unique constraint" },
    };
    let thrown: unknown;
    try {
      wrapDbError(drizzleWrapped, { duplicate: "Duplicate." });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HttpError).statusCode).toBe(409);
    expect((thrown as HttpError).message).toBe("Duplicate.");
  });

  it("fallback message does not expose raw SQL or Drizzle internals", () => {
    const sensitiveErr = {
      message: "syntax error at or near INSERT INTO organizations SELECT * FROM users",
      code: "XX000",
    };
    let thrown: unknown;
    try {
      wrapDbError(sensitiveErr, { fallback: "Something went wrong." });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HttpError).message).toBe("Something went wrong.");
    expect((thrown as HttpError).message).not.toMatch(/INSERT INTO|organizations|SELECT/i);
  });
});
