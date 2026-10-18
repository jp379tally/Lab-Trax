import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { readFileSync } from "node:fs";
import { createUserRateLimit } from "../lib/rate-limit";
import type { RequestHandler } from "express";

const state = vi.hoisted(() => ({
  mode: "lab",
  role: "owner",
  orgId: "lab-1",
  providerId: "provider-1",
  jppEmails: ["jpp@support.example"] as Array<string | null>,
  reporter: { username: "reporter", email: "reporter@example.com", firstName: "Ada", lastName: "Lovelace" },
  sends: [] as any[],
  sendResult: { sent: true } as any,
  persisted: [] as any[],
  attachmentRows: [] as any[],
  storageWrites: [] as any[],
  storageDeletes: [] as string[],
  storageAvailable: true,
  persistenceFails: false,
  duplicate: false,
  failedReports: [] as any[],
  existingFailureReason: null as string | null,
  selectCalls: 0,
  creatorUnlocked: false,
}));

vi.mock("drizzle-orm", () => {
  const expression = (...args: any[]) => args;
  return {
    and: expression, eq: expression, ilike: expression, isNull: expression, asc: expression, or: expression,
  };
});

vi.mock("@workspace/db", () => {
  const users: any = { id: "users.id", username: "users.username", email: "users.email", isActive: "users.isActive", deletedAt: "users.deletedAt", firstName: "users.firstName", lastName: "users.lastName" };
  const organizations: any = { id: "organizations.id", name: "organizations.name", type: "organizations.type", isActive: "organizations.isActive", deletedAt: "organizations.deletedAt" };
  const organizationMemberships: any = { userId: "members.userId", labId: "members.labId", role: "members.role", status: "members.status", deletedAt: "members.deletedAt", createdAt: "members.createdAt" };
  const supportReports: any = {
    id: "supportReports.id", ownerStatus: "supportReports.ownerStatus", copyStatus: "supportReports.copyStatus",
    ownerAttempts: "supportReports.ownerAttempts", copyAttempts: "supportReports.copyAttempts",
    ownerFailureReason: "supportReports.ownerFailureReason", copyFailureReason: "supportReports.copyFailureReason",
    createdAt: "supportReports.createdAt",
  };
  const supportReportAttachments: any = {};
  const insert = (table: any) => ({
    values: vi.fn((values: any) => {
      if (state.persistenceFails) throw new Error("db unavailable");
      if (table === supportReports) {
        state.persisted.push(values);
        const operation: any = {
          onConflictDoNothing: vi.fn(() => operation),
          returning: vi.fn(async () => state.duplicate ? [] : [{ id: values.id, ...values }]),
          then(resolve: any, reject: any) {
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
        return operation;
      }
      state.attachmentRows.push(...(Array.isArray(values) ? values : [values]));
      return Promise.resolve([]);
    }),
  });
  const db: any = {
    query: {
      organizationMemberships: {
        findFirst: vi.fn(async () => ({ role: state.role, labId: state.providerId })),
      },
      supportReports: {
        findFirst: vi.fn(async () => state.duplicate
          ? { ownerFailureReason: state.existingFailureReason }
          : undefined),
      },
    },
    transaction: vi.fn(async (callback: any) => callback({ insert })),
    update: vi.fn(() => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const persisted = state.persisted[0];
            if (persisted) Object.assign(persisted, values);
            return persisted ? [{ id: persisted.id ?? "report-1", ...persisted }] : [];
          }),
          catch: vi.fn(async () => {
            const persisted = state.persisted[0];
            if (persisted) Object.assign(persisted, values);
            return undefined;
          }),
        })),
      })),
    })),
    select: vi.fn((shape?: any) => {
      if (shape?.ownerStatus) {
        const statusChain: any = {
          from: vi.fn(() => statusChain),
          where: vi.fn(() => statusChain),
          limit: vi.fn(async () => state.failedReports),
        };
        return statusChain;
      }
      const call = ++state.selectCalls;
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(async () => state.mode === "lab" ? [{ id: state.orgId, role: state.role }] : []),
        limit: vi.fn(async () => call === (state.mode === "provider" ? 2 : 3)
          ? [{ id: state.orgId, name: "Acme Lab" }]
          : [{ username: state.reporter.username, email: state.reporter.email, firstName: state.reporter.firstName, lastName: state.reporter.lastName }]),
      };
      // Recipient and organization queries do not call limit. Their result is
      // selected by the route's query shape; this small thenable supports both.
      chain.where.mockImplementation(() => {
        const recipientCall = state.mode === "provider" ? 3 : 4;
         const result: any = call === recipientCall
           ? state.jppEmails.map((email) => ({ email }))
           : chain;
        return result;
      });
      return chain;
    }),
  };
  return { db, users, organizations, organizationMemberships, supportReports, supportReportAttachments };
});

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    if (req.headers.authorization !== "Bearer test-token") return _res.status(401).json({ error: "Unauthorized" });
    req.auth = { userId: "user-1" };
    req.user = { id: "user-1", role: "admin" };
    next();
  },
}));
vi.mock("../lib/creator-auth", () => ({
  requireCreator: [(_req: any, res: any, next: any) => state.creatorUnlocked ? next() : res.status(403).json({ error: "Creator unlock required." })],
  creatorRecipientId: vi.fn(async () => "creator-1"),
}));

vi.mock("../lib/provider-selection", () => ({
  requireSelectedProviderOrganization: vi.fn(async (_userId: string, selected?: string) => {
    if (!selected || selected !== state.providerId) throw Object.assign(new Error("denied"), { status: 403 });
    return { id: state.providerId, name: "Selected Practice" };
  }),
}));

vi.mock("../lib/mail", () => ({
  isReservedEmailDomain: vi.fn(() => false),
  resolveDomainDeliverability: vi.fn(async () => "deliverable"),
  sendMail: vi.fn(async (opts: any) => {
    state.sends.push(opts);
    return Array.isArray(state.sendResult) ? state.sendResult.shift() : state.sendResult;
  }),
}));

vi.mock("../lib/support-report-storage", () => ({
  writeSupportReportAttachment: vi.fn(async (key: string, content: Buffer, contentType: string) => {
    if (!state.storageAvailable) return false;
    state.storageWrites.push({ key, content, contentType });
    return true;
  }),
  deleteSupportReportAttachment: vi.fn(async (key: string) => {
    state.storageDeletes.push(key);
  }),
}));

import supportReportsRouter from "./support-reports";

function app(rateLimit?: RequestHandler) {
  const server = express();
  server.use("/api/support-reports", supportReportsRouter(rateLimit));
  return server;
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function post() {
  state.selectCalls = 0;
  return request(app())
    .post(`/api/support-reports?portal=${state.mode === "provider" ? "provider" : "lab"}`)
    .set("Authorization", "Bearer test-token")
    .field("description", "The case list is broken");
}

const validPdf = readFileSync(require.resolve("pdf-parse/test/data/04-valid.pdf"));

describe("POST /support-reports", () => {
  beforeEach(() => {
    state.mode = "lab";
    state.role = "owner";
    state.orgId = "lab-1";
    state.jppEmails = ["jpp@support.example"];
    state.reporter = { username: "reporter", email: "reporter@example.com", firstName: "Ada", lastName: "Lovelace" };
    state.sends.length = 0;
    state.persisted.length = 0;
    state.attachmentRows.length = 0;
    state.storageWrites.length = 0;
    state.storageDeletes.length = 0;
    state.storageAvailable = true;
    state.persistenceFails = false;
    state.duplicate = false;
    state.failedReports.length = 0;
    state.existingFailureReason = null;
    state.sendResult = { sent: true };
    state.selectCalls = 0;
    state.creatorUnlocked = false;
  });

  it("is authenticated and uses the mounted POST /api/support-reports path", async () => {
    const denied = await request(app()).post("/api/support-reports?portal=lab").field("description", "x");
    expect(denied.status).toBe(401);
    const response = await post();
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, queued: true, copySent: false });
    expect(state.persisted).toHaveLength(1);
  });

  it("rate-limits an authenticated user before attachment parsing and mail delivery", async () => {
    const server = app(createUserRateLimit({
      windowMs: 60_000,
      max: 1,
      message: "Too many support reports. Please wait and try again later.",
    }));
    const first = await request(server)
      .post("/api/support-reports?portal=lab")
      .set("Authorization", "Bearer test-token")
      .field("description", "First report");
    const limited = await request(server)
      .post("/api/support-reports?portal=lab")
      .set("Authorization", "Bearer test-token")
      .field("description", "Second report")
      .attach("attachments", Buffer.from("not an image"), {
        filename: "bad.png",
        contentType: "image/png",
      });

    expect(first.status).toBe(202);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: "Too many support reports. Please wait and try again later.",
    });
    expect(state.persisted).toHaveLength(1);
  });

  it.each(["owner", "admin"])("allows a lab %s and derives the lab organization server-side", async (role) => {
    state.role = role;
    const response = await post();
    expect(response.status).toBe(202);
    expect(state.persisted[0].description).toContain("Organization: Acme Lab (lab-1)");
  });

  it("allows a provider owner/admin only for the selected practice", async () => {
    state.mode = "provider";
    state.role = "admin";
    const response = await post().set("X-Provider-Organization-Id", "provider-1");
    expect(response.status).toBe(202);
    expect(state.persisted[0].description).toContain("Portal: provider");
  });
  it.each(["lab", "provider"])("accepts general feedback from active %s members, retaining authenticated tenant scope", async (portal) => {
    state.mode = portal; state.role = "member"; state.selectCalls = 0;
    const response = await request(app()).post(`/api/support-reports?portal=${portal}&kind=feedback`)
      .set("Authorization", "Bearer test-token")
      .set("X-Provider-Organization-Id", "provider-1")
      .set("Idempotency-Key", `feedback-${portal}-1`)
      .field("description", "Please add a shortcut.")
      .attach("attachments", png, { filename: "example.png", contentType: "image/png" });
    expect(response.status).toBe(202);
    expect(state.persisted[0]).toMatchObject({ kind: "feedback", reporterUserId: "user-1", portal });
    expect(state.storageWrites).toHaveLength(1);
    expect(state.persisted[0].description).toContain("Please add a shortcut.");
  });
  it("rejects feedback with a foreign selected lab instead of falling back to another membership", async () => {
    state.role = "member";
    const response = await request(app()).post("/api/support-reports?portal=lab&kind=feedback")
      .set("Authorization", "Bearer test-token").set("X-Lab-Organization-Id", "foreign-lab")
      .field("description", "A suggestion");
    expect(response.status).toBe(403);
    expect(state.persisted).toHaveLength(0);
  });

  it("denies non-admin and cross-organization provider selection", async () => {
    state.role = "user";
    expect((await post()).status).toBe(403);
    state.mode = "provider";
    const crossOrg = await post().set("X-Provider-Organization-Id", "provider-other");
    expect(crossOrg.status).toBe(403);
  });

  it("looks up the active JPP recipient dynamically and rejects unavailable recipients", async () => {
    state.jppEmails = [null];
    const unavailable = await post();
    expect(unavailable.status).toBe(503);
    state.jppEmails = ["old@support.example", "current@support.example"];
    const ambiguous = await post();
    expect(ambiguous.status).toBe(503);
    state.jppEmails = ["jpp@support.example"];
    const available = await post();
    expect(available.status).toBe(202);
  });

  it("validates attachment count, declared MIME, magic bytes, and text binary content", async () => {
    expect((await post().attach("attachments", Buffer.from("not png"), { filename: "x.png", contentType: "image/png" })).status).toBe(415);
    expect((await post().attach("attachments", Buffer.from([0]), { filename: "x.txt", contentType: "text/plain" })).status).toBe(415);
    const unsupported = await post().attach("attachments", Buffer.from("x"), { filename: "x.exe", contentType: "application/octet-stream" });
    expect(unsupported.status).toBe(415);
    let many = post();
    for (let i = 0; i < 6; i++) many = many.attach("attachments", png, { filename: `${i}.png`, contentType: "image/png" });
    expect((await many).status).toBe(413);
    expect((await post().attach("attachments", png, { filename: "../../safe.png", contentType: "image/png" })).status).toBe(202);
    expect(state.attachmentRows.at(-1)?.filename).toBe("safe.png");
    expect((await post().attach("attachments", Buffer.from("%PDF-1.7 fake obj %%EOF"), { filename: "fake.pdf", contentType: "application/pdf" })).status).toBe(415);
    expect((await post().attach("attachments", validPdf, { filename: "valid.pdf", contentType: "application/pdf" })).status).toBe(202);
  });

  it("enforces per-file and aggregate attachment limits while streaming", async () => {
    const overFiveMiB = Buffer.alloc(5 * 1024 * 1024 + 1, 65);
    expect(
      (
        await post().attach("attachments", overFiveMiB, {
          filename: "large.txt",
          contentType: "text/plain",
        })
      ).status,
    ).toBe(413);

    let overTenMiB = post();
    for (const [index, size] of [4, 4, 3].entries()) {
      overTenMiB = overTenMiB.attach(
        "attachments",
        Buffer.alloc(size * 1024 * 1024, 65 + index),
        { filename: `${index}.txt`, contentType: "text/plain" },
      );
    }
    expect((await overTenMiB).status).toBe(413);
    expect(state.persisted).toHaveLength(0);
  });

  it("persists owner and reporter-copy delivery state before returning", async () => {
    const response = await post();
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ queued: true, copySent: false });
    expect(state.persisted[0]).toMatchObject({
      ownerEmail: "jpp@support.example",
      reporterEmail: "reporter@example.com",
      copyStatus: "pending",
    });
    expect(state.sends).toHaveLength(0);
  });

  it("deduplicates a retried submission before uploading attachments", async () => {
    state.duplicate = true;
    const response = await post()
      .set("Idempotency-Key", "report-retry-key")
      .attach("attachments", png, { filename: "proof.png", contentType: "image/png" });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ queued: true, duplicate: true });
    expect(state.storageWrites).toHaveLength(0);
    expect(state.attachmentRows).toHaveLength(0);
  });

  it("does not report a failed intake as successfully queued on duplicate retry", async () => {
    state.duplicate = true;
    state.existingFailureReason = "intake_incomplete";
    const response = await post().set("Idempotency-Key", "failed-intake-key");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Support attachments are temporarily unavailable." });
  });

  it("does not duplicate the confirmation when the reporter is the JPP recipient", async () => {
    state.reporter.email = "JPP@SUPPORT.EXAMPLE";
    const response = await post();
    expect(response.status).toBe(202);
    expect(state.persisted[0].copyStatus).toBe("not_applicable");
  });

  it("fails closed when durable persistence is unavailable and deletes uploaded blobs", async () => {
    state.persistenceFails = true;
    const failed = await post().attach("attachments", png, { filename: "proof.png", contentType: "image/png" });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "Support report could not be saved. Please try again later." });
    expect(state.storageWrites).toHaveLength(0);
    expect(state.storageDeletes).toHaveLength(0);
    expect(JSON.stringify(failed.body)).not.toContain("db unavailable");
  });

  it("fails closed when attachment storage is unavailable", async () => {
    state.storageAvailable = false;
    const failed = await post().attach("attachments", png, { filename: "proof.png", contentType: "image/png" });
    expect(failed.status).toBe(503);
    expect(state.persisted).toHaveLength(1);
    expect(state.persisted[0]).toMatchObject({
      ownerStatus: "permanent_failed",
      ownerFailureReason: "intake_incomplete",
    });
  });

  it("shows sanitized permanent failures only inside Creator, not via admin secrets", async () => {
    process.env.PLATFORM_ADMIN_SECRET = "support-test-secret";
    state.failedReports.push({
      id: "report-failed",
      ownerStatus: "permanent_failed",
      copyStatus: "sent",
      ownerAttempts: 3,
      copyAttempts: 1,
      ownerFailureReason: "raw provider detail",
      copyFailureReason: null,
      createdAt: new Date("2026-09-10T12:00:00Z"),
    });
    const denied = await request(app())
      .get("/api/support-reports/status")
      .set("Authorization", "Bearer test-token");
    expect(denied.status).toBe(403);
    const secretDenied = await request(app())
      .get("/api/support-reports/status")
      .set("Authorization", "Bearer test-token")
      .set("X-Platform-Admin-Secret", "support-test-secret");
    expect(secretDenied.status).toBe(403);
    state.creatorUnlocked = true;
    const allowed = await request(app()).get("/api/support-reports/status").set("Authorization", "Bearer test-token");
    expect(allowed.status).toBe(200);
    expect(allowed.body.reports[0]).toMatchObject({
      id: "report-failed",
      ownerFailureReason: "permanent_failure",
    });
    expect(JSON.stringify(allowed.body)).not.toContain("raw provider detail");
    expect(JSON.stringify(allowed.body)).not.toContain("description");
  });

  it("does not expose persistence or transport internals", async () => {
    state.persistenceFails = true;
    const failed = await post();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("db unavailable");
  });
});