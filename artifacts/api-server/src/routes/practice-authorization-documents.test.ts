import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

const objects = new Map<string, { body: Buffer; type: string }>();
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: vi.fn(async (key: string, body: Buffer, type: string) => {
    objects.set(key, { body, type }); return true;
  }),
  openCaseMediaObjectStream: vi.fn(async (key: string, type?: string) => {
    const item = objects.get(key); if (!item) return null;
    const { Readable } = await import("node:stream");
    return { stream: Readable.from(item.body), contentType: type ?? item.type };
  }),
  deleteCaseMediaFromObjectStorage: vi.fn(async (key: string) => objects.delete(key)),
}));

const run = !!process.env.DATABASE_URL;
const suite = run ? describe : describe.skip;
const id = (prefix: string) => `${prefix.slice(0, 5)}_${randomBytes(3).toString("hex")}`;
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

suite("completed practice authorization HTTP endpoints", () => {
  let db: any, t: any, app: any, token = "", userId = "";
  let labA = "", labB = "", practiceA = "", practiceB = "";
  const users: string[] = [], orgs: string[] = [];
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  beforeAll(async () => {
    t = await import("@workspace/db"); db = t.db;
    await db.execute(sql`
      ALTER TABLE practice_authorization_documents
        ALTER COLUMN byte_size DROP NOT NULL;
      ALTER TABLE practice_authorization_documents
        ADD COLUMN IF NOT EXISTS legacy_authorization_id varchar;
      ALTER TABLE practice_authorization_documents
        ADD COLUMN IF NOT EXISTS legacy_evidence jsonb;
      ALTER TABLE practice_authorization_documents
        ADD COLUMN IF NOT EXISTS supersedes_document_id varchar
        REFERENCES practice_authorization_documents(id) ON DELETE restrict
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS practice_auth_docs_legacy_authorization_unique
        ON practice_authorization_documents (legacy_authorization_id);
      CREATE UNIQUE INDEX IF NOT EXISTS practice_auth_docs_supersedes_unique
        ON practice_authorization_documents (supersedes_document_id)
    `);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION deny_practice_authorization_document_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'practice authorization documents are immutable';
      END $$;
      DROP TRIGGER IF EXISTS practice_authorization_documents_immutable
        ON practice_authorization_documents;
      CREATE TRIGGER practice_authorization_documents_immutable
        BEFORE UPDATE OR DELETE ON practice_authorization_documents
        FOR EACH ROW EXECUTE FUNCTION deny_practice_authorization_document_mutation()
    `);
    process.env.JWT_SECRET ??= "authorization-doc-test-secret";
    app = (await import("../app.js")).default;
    await vi.waitFor(async () => {
      expect((await request(app).get("/api/__test_missing_route__")).status).toBe(404);
    }, { timeout: 15_000, interval: 25 });
    const username = id("authdoc");
    const registered = await request(app).post("/api/auth/register").send({
      username, password: "TestPass1!", email: `${username}@example.com`, userType: "lab", clientType: "mobile",
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    token = registered.body.accessToken; userId = registered.body.user.id; users.push(userId);
    await db.update(t.users).set({ emailVerifiedAt: new Date() }).where(eq(t.users.id, userId));
    [labA, labB] = (await db.insert(t.organizations).values([
      { type: "lab", name: id("LabA") }, { type: "lab", name: id("LabB") },
    ]).returning({ id: t.organizations.id })).map((x: any) => x.id);
    [practiceA, practiceB] = (await db.insert(t.organizations).values([
      { type: "provider", name: id("PracticeA"), parentLabOrganizationId: labA },
      { type: "provider", name: id("PracticeB"), parentLabOrganizationId: labB },
    ]).returning({ id: t.organizations.id })).map((x: any) => x.id);
    orgs.push(labA, labB, practiceA, practiceB);
    await db.insert(t.organizationMemberships).values({ labId: labA, userId, role: "admin", status: "active" });
  });
  beforeEach(() => objects.clear());
  afterAll(async () => {
    if (!run) return;
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.delete(t.practiceAuthorizationDocuments).where(inArray(t.practiceAuthorizationDocuments.labOrganizationId, [labA, labB]));
      await tx.delete(t.labAuthorizationTemplates).where(inArray(t.labAuthorizationTemplates.labOrganizationId, [labA, labB]));
    });
    await db.delete(t.organizationMemberships).where(eq(t.organizationMemberships.userId, userId));
    await db.delete(t.organizations).where(inArray(t.organizations.id, orgs));
    await db.delete(t.users).where(inArray(t.users.id, users));
  });

  it("returns safe defaults, updates templates, and isolates tenants", async () => {
    const defaults = await auth(request(app).get(`/api/admin/authorization-templates?labOrganizationId=${labA}`));
    expect(defaults.status).toBe(200);
    expect(defaults.body.data.map((x: any) => x.templateType)).toEqual(["card_on_file", "autopay"]);
    expect(defaults.body.data.every((x: any) => x.content && x.version === 1)).toBe(true);
    const saved = await auth(request(app).put("/api/admin/authorization-templates/card_on_file"))
      .send({ labOrganizationId: labA, content: "Custom card terms." });
    expect(saved.status).toBe(200); expect(saved.body.data.content).toBe("Custom card terms.");
    expect((await auth(request(app).get(`/api/admin/authorization-templates?labOrganizationId=${labB}`))).status).toBe(403);
    expect((await auth(request(app).put("/api/admin/authorization-templates/autopay")).send({ labOrganizationId: labB, content: "Nope" })).status).toBe(403);
    await auth(request(app).put("/api/admin/authorization-templates/card_on_file"))
      .send({ labOrganizationId: labA, content: "{{labName}} {{practiceName}} {{signerName}} {{date}}" });
    const templatePdf = await auth(request(app).get(`/api/admin/authorization-templates/card_on_file/pdf?labOrganizationId=${labA}`));
    expect(templatePdf.status).toBe(200); expect(templatePdf.headers["content-disposition"]).toMatch(/card-on-file-authorization-template\.pdf/);
    expect(templatePdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(templatePdf.body.includes(Buffer.from("{{"))).toBe(false);
  });

  it("requires billing access and validates completed PDF uploads", async () => {
    const unauth = id("norole");
    const registered = await request(app).post("/api/auth/register").send({
      username: unauth, password: "TestPass1!", email: `${unauth}@example.com`, userType: "lab", clientType: "mobile",
    });
    users.push(registered.body.user.id);
    await db.update(t.users).set({ emailVerifiedAt: new Date() }).where(eq(t.users.id, registered.body.user.id));
    const noAccess = request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`)
      .set("Authorization", `Bearer ${registered.body.accessToken}`).field("authorizationType", "card_on_file").attach("file", pdf, "x.pdf");
    expect((await noAccess).status).toBe(403);
    const malformed = auth(request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`))
      .field("authorizationType", "card_on_file").attach("file", Buffer.from("not pdf"), "x.pdf");
    expect((await malformed).status).toBe(415);
    const missing = await auth(request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`)).field("authorizationType", "card_on_file");
    expect(missing.status).toBe(400);
    const upload = await auth(request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`))
      .field("authorizationType", "card_on_file").attach("file", pdf, "signed.pdf");
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const documentId = upload.body.data.id;
    const list = await auth(request(app).get(`/api/admin/practices/${practiceA}/authorization-documents?labOrganizationId=${labA}`));
    expect(list.status).toBe(200); expect(list.body.data).toHaveLength(1);
    expect((await auth(request(app).get(`/api/admin/practices/${practiceB}/authorization-documents`))).status).toBe(403);
    expect((await auth(request(app).get(`/api/admin/authorization-documents/${documentId}/preview`))).headers["content-disposition"]).toMatch(/^inline/);
    expect((await auth(request(app).get(`/api/admin/authorization-documents/${documentId}/download`))).headers["content-disposition"]).toMatch(/^attachment/);
    await db.update(t.organizations).set({ parentLabOrganizationId: labB }).where(eq(t.organizations.id, practiceA));
    const afterReparent = await auth(request(app).get(`/api/admin/practices/${practiceA}/authorization-documents?labOrganizationId=${labA}`));
    expect(afterReparent.status).toBe(200); expect(afterReparent.body.data).toHaveLength(1);
    expect((await auth(request(app).get(`/api/admin/authorization-documents/${documentId}/preview?labOrganizationId=${labB}`))).status).toBe(403);
    try {
      await expect(db.update(t.practiceAuthorizationDocuments).set({ originalFilename: "tampered.pdf" }).where(eq(t.practiceAuthorizationDocuments.id, documentId))).rejects.toThrow();
      await expect(db.delete(t.practiceAuthorizationDocuments).where(eq(t.practiceAuthorizationDocuments.id, documentId))).rejects.toThrow();
    } finally {
      await db.update(t.organizations).set({ parentLabOrganizationId: labA }).where(eq(t.organizations.id, practiceA));
    }
  });

  it("allows exactly one immutable correction within the same practice and lab", async () => {
    const first = await auth(request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`))
      .field("authorizationType", "autopay").field("labOrganizationId", labA)
      .attach("file", pdf, "first.pdf");
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replacements = await Promise.all(["a.pdf", "b.pdf"].map((filename) =>
      auth(request(app).post(`/api/admin/practices/${practiceA}/authorization-documents`))
        .field("authorizationType", "autopay").field("labOrganizationId", labA)
        .field("supersedesDocumentId", first.body.data.id).attach("file", pdf, filename)));
    expect(replacements.map((response) => response.status).sort()).toEqual([201, 409]);

    const rows = await db.select().from(t.practiceAuthorizationDocuments)
      .where(eq(t.practiceAuthorizationDocuments.supersedesDocumentId, first.body.data.id));
    expect(rows).toHaveLength(1);
    const replacement = replacements.find((response) => response.status === 201)!;

    const list = await auth(request(app).get(
      `/api/admin/practices/${practiceA}/authorization-documents?labOrganizationId=${labA}`,
    ));
    const pair = list.body.data.filter((row: any) =>
      row.id === first.body.data.id || row.id === replacement.body.data.id);
    expect(pair).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.body.data.id, status: "superseded" }),
      expect.objectContaining({ id: replacement.body.data.id, status: "current" }),
    ]));

    const crossPractice = await auth(request(app).post(`/api/admin/practices/${practiceB}/authorization-documents`))
      .field("authorizationType", "autopay").field("labOrganizationId", labA)
      .field("supersedesDocumentId", first.body.data.id).attach("file", pdf, "forbidden.pdf");
    expect(crossPractice.status).toBe(403);
    expect(objects.size).toBe(2);
  });

  it("keeps retired in-app signing routes unavailable", async () => {
    expect((await auth(request(app).get("/api/admin/authorizations/prepare"))).status).toBe(404);
    expect((await auth(request(app).get("/api/admin/authorizations"))).status).toBe(404);
    expect((await auth(request(app).get("/api/admin/authorizations/retired-record"))).status).toBe(404);
    expect((await auth(request(app).get("/api/admin/authorizations/retired-record/download"))).status).toBe(404);
    expect((await auth(request(app).get("/api/admin/authorizations/retired-record/retrieve"))).status).toBe(404);
    expect((await auth(request(app).post("/api/admin/authorizations").send({}))).status).toBe(404);
    expect((await auth(request(app).put("/api/admin/authorizations/retired-draft").send({}))).status).toBe(404);
    expect((await auth(request(app).post("/api/admin/authorizations/retired-draft/finish").send({}))).status).toBe(404);
  });
});
