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
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./lib/http";

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
  isActive: boolean;
  deletedAt: Date | null;
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
    isActive: true,
    deletedAt: null,
    profilePhotoUrl: null as string | null,
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
    innerJoin(t: Marker): SelectChain;
    where(condition: unknown): SelectChain;
    orderBy(): SelectChain;
    for(mode: string): SelectChain;
    limit(count: number): SelectChain;
  }
  const select = (): SelectChain => {
    let fromName = "";
    let joinsUser = false;
    let conditionValues: unknown[] = [];
    const valuesIn = (condition: unknown): unknown[] => {
      if (condition === undefined || condition === null) return [];
      if (typeof condition !== "object") return [condition];
      const node = condition as { queryChunks?: unknown[]; value?: unknown };
      if (node.queryChunks) return node.queryChunks.flatMap(valuesIn);
      return node.value === undefined ? [] : [node.value];
    };
    const obj: SelectChain = {
      from(t) {
        fromName = t.__table;
        return obj;
      },
      innerJoin(t) { joinsUser = t.__table === "users"; return obj; },
      where(condition) {
        conditionValues = valuesIn(condition);
        return obj;
      },
      orderBy() {
        return obj;
      },
      for() {
        return obj;
      },
      limit() {
        return obj;
      },
      then(resolve, reject) {
        const session = fromName === "userSessions" && joinsUser
          ? state.sessions.find((session) =>
            conditionValues.includes(session.id) &&
            conditionValues.includes(session.userId) &&
            session.userId === state.fakeUser.id &&
            !session.revokedAt &&
            session.expiresAt instanceof Date &&
            session.expiresAt.getTime() > Date.now())
          : undefined;
        const rows = fromName === "userSessions" && joinsUser
          ? (session ? [state.fakeUser] : [])
          : rowsByTable[fromName] ?? [];
        return Promise.resolve(rows).then(
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
    where(): Promise<void> & { returning(): Promise<Array<Record<string, unknown>>> };
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
        return Object.assign(Promise.resolve(), {
          returning: () => Promise.resolve(t.__table === "users" ? [state.fakeUser] : []),
        });
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
    transaction: async (callback: (tx: any) => Promise<unknown>) =>
      callback({ select, insert, update }),
    query: {
      users: {
        findFirst: async () => state.fakeUser,
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
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof HttpError ? err.statusCode : 500).json({ error: err.message });
  });
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

  it("normalizes self-owned photos, replaces them with unique URLs, and rejects invalid/cross-account uploads", async () => {
    const login = await request(server).post("/api/auth/login")
      .send({ username: state.fakeUser.username, password: state.PASSWORD, clientType: "desktop" });
    expect(login.status).toBe(200);
    const bearer = `Bearer ${login.body.accessToken}`;
    const endpoint = `/api/auth/users/${state.fakeUser.id}/profile-photo`;
    const image = await sharp({ create: { width: 300, height: 150, channels: 3, background: "red" } }).png().toBuffer();
    const created: string[] = [];
    try {
      const anonymous = await request(server).post(endpoint).attach("photo", image, "photo.png");
      expect(anonymous.status).toBe(401);
      const newestSession = state.sessions.at(-1)!;
      newestSession.revokedAt = new Date();
      try {
        const revoked = await request(server).post(endpoint)
          .set("Authorization", bearer).attach("photo", image, "photo.png");
        expect(revoked.status).toBe(401);
      } finally {
        newestSession.revokedAt = null;
      }
      const { signAccessToken } = await import("./lib/auth");
      const wrongSession = await request(server).post(endpoint)
        .set("Authorization", `Bearer ${signAccessToken(state.fakeUser.id, "unrelated-session")}`)
        .attach("photo", image, "photo.png");
      expect(wrongSession.status).toBe(401);
      const other = await request(server).post("/api/auth/users/another-user/profile-photo")
        .set("Authorization", bearer).attach("photo", image, "photo.png");
      expect(other.status).toBe(403);
      expect(state.fakeUser.profilePhotoUrl).toBeNull();
      // Account uploads are available even without admin/owner membership.
      for (const role of ["user", "billing", "admin", "owner", "read_only"]) {
        state.fakeUser.role = role;
        const uploaded = await request(server).post(endpoint)
          .set("Authorization", bearer).attach("photo", image, "photo.png");
        expect(uploaded.status).toBe(200);
        expect(uploaded.body.user.id).toBe(state.fakeUser.id);
        expect(uploaded.body.profilePhotoUrl).toBe(state.fakeUser.profilePhotoUrl);
        expect(created).not.toContain(uploaded.body.profilePhotoUrl);
        created.push(uploaded.body.profilePhotoUrl);
        const metadata = await sharp(path.join(process.cwd(), uploaded.body.profilePhotoUrl)).metadata();
        expect(metadata).toMatchObject({ width: 200, height: 200, format: "jpeg" });
      }
      const confirmed = state.fakeUser.profilePhotoUrl;
      const invalid = await request(server).post(endpoint).set("Authorization", bearer)
        .attach("photo", Buffer.from("not an image"), { filename: "bad.png", contentType: "image/png" });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("could not be read");
      const oversized = await request(server).post(endpoint).set("Authorization", bearer)
        .attach("photo", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "huge.png", contentType: "image/png" });
      expect(oversized.status).toBe(400);
      expect(oversized.body.error).toContain("5 MB");
      const text = await request(server).post(endpoint).set("Authorization", bearer)
        .attach("photo", Buffer.from("text"), "file.txt");
      expect(text.status).toBe(400);
      expect(state.fakeUser.profilePhotoUrl).toBe(confirmed);
      const profile = await request(server).get("/api/auth/me").set("Authorization", bearer);
      expect(profile.body.user.profilePhotoUrl).toBe(confirmed);
    } finally {
      state.fakeUser.role = "user";
      state.fakeUser.profilePhotoUrl = null;
      for (const url of created) fs.rmSync(path.join(process.cwd(), url), { force: true });
    }
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
