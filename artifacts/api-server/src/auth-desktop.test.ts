/**
 * Integration tests for the desktop sign-in path:
 *   1. CORS preflight from `app://labtrax` is allowed with credentials.
 *   2. Login with `clientType: "desktop"` returns tokens in the JSON body
 *      (not the cookie-only branch).
 *   3. Refresh with `{ refreshToken }` in the body returns rotated tokens.
 *
 * The DB layer is mocked entirely; the auth router is mounted on a minimal
 * Express app together with the real CORS middleware from `./lib/cors`.
 */
import crypto from "node:crypto";
import type { Server } from "node:http";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import request from "supertest";
import bcrypt from "bcryptjs";

interface FakeUser {
  id: string;
  username: string;
  password: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  initials: string;
  userType: string;
  role: string;
  licenseNumber: string | null;
  practiceName: string | null;
  doctorName: string | null;
  practiceAddress: string | null;
  practicePhone: string | null;
  phoneContactName: string | null;
  accountNumber: string | null;
  wantsUpdates: boolean;
  workStatus: string;
  lastLoginAt: Date | null;
}

interface FakeSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

const state = vi.hoisted(() => {
  const PASSWORD = "secret-pw-123";
  const passwordHash = require("bcryptjs").hashSync(PASSWORD, 4);
  const fakeUser = {
    id: "user-desktop-1",
    username: "desktoptest",
    password: passwordHash,
    email: "desktop@example.com",
    phone: null,
    firstName: "Desk",
    lastName: "Top",
    initials: "DT",
    userType: "lab",
    role: "user",
    licenseNumber: null,
    practiceName: null,
    doctorName: null,
    practiceAddress: null,
    practicePhone: null,
    phoneContactName: null,
    accountNumber: null,
    wantsUpdates: false,
    workStatus: "available",
    lastLoginAt: null,
  };
  const sessions: Array<Record<string, unknown>> = [];
  return { fakeUser, sessions, PASSWORD };
});

vi.mock("@workspace/db", () => {
  interface Marker {
    __table: string;
  }
  type RowsByTable = Partial<Record<string, readonly unknown[]>>;
  const tables: Record<string, Marker> = {
    users: { __table: "users" },
    userSessions: { __table: "userSessions" },
    organizationMemberships: { __table: "organizationMemberships" },
    organizations: { __table: "organizations" },
    organizationJoinRequests: { __table: "organizationJoinRequests" },
    notifications: { __table: "notifications" },
    auditLogs: { __table: "auditLogs" },
    // Referenced transitively by lib/soft-delete.
    cases: { __table: "cases" },
    caseAttachments: { __table: "caseAttachments" },
    invoices: { __table: "invoices" },
    bankTransactions: { __table: "bankTransactions" },
    pricingTiers: { __table: "pricingTiers" },
    pricingOverrides: { __table: "pricingOverrides" },
    labMemberships: { __table: "labMemberships" },
    invoiceAttachments: { __table: "invoiceAttachments" },
    invoiceCredits: { __table: "invoiceCredits" },
    practiceStatements: { __table: "practiceStatements" },
    practiceStatementSends: { __table: "practiceStatementSends" },
    // Referenced transitively by lib/soft-delete (PROTECTED_TABLES).
    subscriptions: { __table: "subscriptions" },
    vendorTypes: { __table: "vendorTypes" },
    aiMemory: { __table: "aiMemory" },
  };

  const rowsByTable: RowsByTable = {
    users: [state.fakeUser],
  };

  interface SelectChain extends PromiseLike<readonly unknown[]> {
    from(t: Marker): SelectChain;
    where(): SelectChain;
    orderBy(): SelectChain;
  }
  const select = (): SelectChain => {
    let fromName = "";
    const obj: SelectChain = {
      from(t) {
        fromName = t.__table;
        return obj;
      },
      where() {
        return obj;
      },
      orderBy() {
        return obj;
      },
      then(resolve, reject) {
        return Promise.resolve(rowsByTable[fromName] ?? []).then(
          resolve,
          reject,
        );
      },
    };
    return obj;
  };

  interface InsertChain {
    values(v: Record<string, unknown>): InsertChain;
    returning(): Promise<Array<Record<string, unknown>>>;
    then<TResult1 = void, TResult2 = never>(
      onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2>;
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<void | TResult>;
    finally(onfinally?: (() => void) | null): Promise<void>;
  }
  const insert = (t: Marker): InsertChain => {
    let lastValues: Record<string, unknown> = {};
    // A real Drizzle write resolves to a query promise that supports
    // then/catch/finally — not just `then`. Route handlers chain
    // `.catch(wrapDbError)` onto inserts (e.g. the userSessions insert in the
    // login handler), so the mock must expose all three or `.catch` is
    // `undefined` and the handler throws a TypeError (surfacing as a 500).
    const settled: Promise<void> = Promise.resolve();
    const obj: InsertChain = {
      values(v) {
        lastValues = v;
        if (t.__table === "userSessions") {
          state.sessions.push({ ...v, revokedAt: null });
        }
        return obj;
      },
      returning() {
        return Promise.resolve([lastValues]);
      },
      then(onfulfilled, onrejected) {
        return settled.then(onfulfilled, onrejected);
      },
      catch(onrejected) {
        return settled.catch(onrejected);
      },
      finally(onfinally) {
        return settled.finally(onfinally);
      },
    };
    return obj;
  };

  interface UpdateChain {
    set(v: Record<string, unknown>): UpdateChain;
    where(): Promise<void>;
    returning(): Promise<Array<Record<string, unknown>>>;
  }
  const update = (t: Marker): UpdateChain => {
    let pendingSet: Record<string, unknown> | null = null;
    const obj: UpdateChain = {
      set(v) {
        pendingSet = v;
        return obj;
      },
      where() {
        if (pendingSet) {
          if (t.__table === "userSessions") {
            for (const s of state.sessions) Object.assign(s, pendingSet);
          } else if (t.__table === "users") {
            Object.assign(state.fakeUser, pendingSet);
          }
        }
        return Promise.resolve();
      },
      returning() {
        return Promise.resolve([]);
      },
    };
    return obj;
  };

  const db = {
    select,
    insert,
    update,
    query: {
      users: {
        findFirst: async () => undefined,
      },
      userSessions: {
        findFirst: async () =>
          state.sessions[state.sessions.length - 1] ?? undefined,
      },
      organizationMemberships: {
        findMany: async () => [],
      },
    },
  };

  return { db, ...tables };
});

import { corsOptions } from "./lib/cors.js";
import authRouter from "./routes/auth.js";

function buildApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

interface LoginResponseBody {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
}
interface RefreshResponseBody {
  data?: { accessToken: string; refreshToken: string };
  accessToken?: string;
  refreshToken?: string;
}

describe("desktop sign-in against the API", () => {
  let server: Server;

  beforeAll(() => {
    server = buildApp().listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("CORS preflight from app://labtrax is allowed with credentials", async () => {
    const res = await request(server)
      .options("/api/auth/login")
      .set("Origin", "app://labtrax")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization");

    expect([200, 204]).toContain(res.status);
    expect(res.headers["access-control-allow-origin"]).toBe("app://labtrax");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("login with clientType: 'desktop' returns tokens in JSON", async () => {
    const res = await request(server)
      .post("/api/auth/login")
      .set("Origin", "app://labtrax")
      .send({
        username: state.fakeUser.username,
        password: state.PASSWORD,
        clientType: "desktop",
      });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("app://labtrax");
    const body = res.body as LoginResponseBody;
    expect(body.success).toBe(true);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.accessToken!.length).toBeGreaterThan(20);
    expect(body.refreshToken!.length).toBeGreaterThan(20);
    // bcrypt is imported so the seeded password hash is verifiable end-to-end.
    expect(bcrypt.compareSync(state.PASSWORD, state.fakeUser.password)).toBe(
      true,
    );
  });

  it("refresh with { refreshToken } in body returns rotated tokens", async () => {
    const loginRes = await request(server)
      .post("/api/auth/login")
      .set("Origin", "app://labtrax")
      .send({
        username: state.fakeUser.username,
        password: state.PASSWORD,
        clientType: "desktop",
      });
    expect(loginRes.status).toBe(200);
    const refreshToken = (loginRes.body as LoginResponseBody).refreshToken;
    expect(typeof refreshToken).toBe("string");

    const refreshRes = await request(server)
      .post("/api/auth/refresh")
      .set("Origin", "app://labtrax")
      .send({ refreshToken });

    expect(refreshRes.status).toBe(200);
    const body = refreshRes.body as RefreshResponseBody;
    const data = body.data ?? body;
    expect(typeof data.accessToken).toBe("string");
    expect(typeof data.refreshToken).toBe("string");
    expect(data.accessToken!.length).toBeGreaterThan(20);
    expect(data.refreshToken!.length).toBeGreaterThan(20);
    // Same {sub, sid, iat, exp} can produce a byte-identical JWT, so assert
    // rotation via the stored session's tokenHash instead of token inequality.
    const presented = crypto
      .createHash("sha256")
      .update(data.refreshToken!)
      .digest("hex");
    const lastSession = state.sessions[state.sessions.length - 1] as
      | unknown as
      | FakeSession
      | undefined;
    expect(lastSession?.tokenHash).toBe(presented);
  });
});
