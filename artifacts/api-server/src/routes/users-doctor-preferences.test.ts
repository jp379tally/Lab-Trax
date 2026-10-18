import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  lastUpdate: null as null | Record<string, unknown>,
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      query: {
        users: {
          findFirst: vi.fn(async () => state.user),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              state.lastUpdate = values;
              state.user = { ...(state.user ?? {}), ...values };
              return [state.user];
            }),
          })),
        })),
      })),
    },
  };
});

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      return next(Object.assign(new Error("Authentication required."), { statusCode: 401 }));
    }
    (req as Request & { auth: { userId: string } }).auth = { userId: "provider-1" };
    next();
  },
}));

import usersRouter from "./users";
import { HttpError } from "../lib/http";

const app = express();
app.use(express.json());
app.use("/api/users", usersRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      ok: false,
      message: error.message,
      details: error.details,
    });
  }
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 500;
  return res.status(statusCode).json({ ok: false });
});

function authed(method: "get" | "patch", path = "/api/users/me/doctor-preferences") {
  return request(app)[method](path).set("Authorization", "Bearer test");
}

beforeEach(() => {
  state.user = {
    id: "provider-1",
    userType: "provider",
    doctorPreferences: null,
  };
  state.lastUpdate = null;
});

describe("provider doctor preferences API", () => {
  it("requires authentication", async () => {
    const response = await request(app).get("/api/users/me/doctor-preferences");
    expect(response.status).toBe(401);
  });

  it("returns safe null defaults for a provider with no saved record", async () => {
    const response = await authed("get");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      occlusionAmount: null,
      occlusionUnit: null,
      proximalContactAmount: null,
      proximalContactUnit: null,
      anatomyPreference: null,
      anatomyOther: null,
      caseQuestionContactMethod: null,
      caseQuestionContactValue: null,
    });
  });

  it("rejects non-provider accounts", async () => {
    state.user = { ...state.user, userType: "lab" };
    const response = await authed("get");
    expect(response.status).toBe(403);
  });

  it("rejects PATCH for non-provider accounts", async () => {
    state.user = { ...state.user, userType: "lab" };
    const response = await authed("patch").send({ occlusionAmount: 0.2 });
    expect(response.status).toBe(403);
    expect(state.lastUpdate).toBeNull();
  });

  it("merges partial updates with existing account-wide values", async () => {
    state.user = {
      ...state.user,
      doctorPreferences: {
        occlusionAmount: 0.2,
        occlusionUnit: "mm",
        anatomyPreference: "primary_only",
      },
    };
    const response = await authed("patch").send({
      proximalContactAmount: 30,
      proximalContactUnit: "microns",
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      occlusionAmount: 0.2,
      occlusionUnit: "mm",
      proximalContactAmount: 30,
      proximalContactUnit: "microns",
      anatomyPreference: "primary_only",
    });
    expect(state.lastUpdate?.doctorPreferences).toEqual(response.body.data);
  });

  it.each([
    [{ occlusionUnit: "inches" }, "occlusionUnit"],
    [{ proximalContactAmount: -1 }, "proximalContactAmount"],
    [{ anatomyPreference: "other", anatomyOther: "x".repeat(101) }, "anatomyOther"],
    [{ caseQuestionContactMethod: "email", caseQuestionContactValue: "not-an-email" }, "caseQuestionContactValue"],
    [{ caseQuestionContactMethod: "text", caseQuestionContactValue: "123" }, "caseQuestionContactValue"],
    [{ caseQuestionContactMethod: "phone_call", caseQuestionContactValue: null }, "caseQuestionContactValue"],
  ])("returns field-level validation for invalid values", async (body, field) => {
    const response = await authed("patch").send(body);
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("doctor preference");
    expect(response.body.details.fields[field]).toBeTruthy();
    expect(state.lastUpdate).toBeNull();
  });

  it("accepts each contact method with a matching contact value", async () => {
    for (const body of [
      { caseQuestionContactMethod: "text", caseQuestionContactValue: "+1 (555) 123-4567" },
      { caseQuestionContactMethod: "phone_call", caseQuestionContactValue: "555-123-4567" },
      { caseQuestionContactMethod: "email", caseQuestionContactValue: "doctor@example.com" },
    ]) {
      const response = await authed("patch").send(body);
      expect(response.status).toBe(200);
    }
  });

  it("supports explicit null clears and clears dependent values", async () => {
    state.user = {
      ...state.user,
      doctorPreferences: {
        anatomyPreference: "other",
        anatomyOther: "Custom anatomy",
        caseQuestionContactMethod: "email",
        caseQuestionContactValue: "doctor@example.com",
      },
    };
    const response = await authed("patch").send({
      anatomyPreference: null,
      caseQuestionContactMethod: null,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      anatomyPreference: null,
      anatomyOther: null,
      caseQuestionContactMethod: null,
      caseQuestionContactValue: null,
    });
  });
});