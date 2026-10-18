import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import PDFDocument from "pdfkit";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";

const fixture = vi.hoisted(() => {
  const caseId = "00000000-0000-4000-8000-000000000101";
  const filename = "synthetic-prescription.pdf";
  return {
    dir: `/tmp/recovery-analysis-${crypto.randomUUID()}`,
    caseId, filename,
    scope: new Map([[caseId, {
      caseNumber: "SYNTH-CASE-001", historicalDate: "2026-01-01",
      practiceId: "synthetic-practice", flagged: false,
      evidence: { source: "synthetic-fixture" }, prescriptions: [filename], inWindow: true,
    }]]),
    case: vi.fn(), attachment: vi.fn(), binding: vi.fn(), insert: vi.fn(),
    audit: vi.fn(), values: vi.fn(), vision: vi.fn(), object: vi.fn(), role: vi.fn(), warn: vi.fn(),
  };
});
vi.mock("@workspace/db", async (original) => {
  const actual = await original<typeof import("@workspace/db")>();
  return { ...actual, db: {
    query: { cases: { findFirst: fixture.case }, caseAttachments: { findFirst: fixture.attachment },
      legacyCaseMedia: { findFirst: fixture.binding } },
    insert: fixture.insert,
  } };
});
vi.mock("./case-media", async (original) => ({
  ...await original<typeof import("./case-media")>(), caseMediaDir: fixture.dir,
}));
vi.mock("./case-media-object-storage", async (original) => ({
  ...await original<typeof import("./case-media-object-storage")>(), openCaseMediaObjectStream: fixture.object,
}));
vi.mock("./rbac", async (original) => ({
  ...await original<typeof import("./rbac")>(), requireAnyRole: fixture.role,
}));
vi.mock("./logger", () => ({ logger: { warn: fixture.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./ai-openai-client", () => ({
  getAiClient: () => ({ chat: { completions: { create: fixture.vision } } }),
  createOpenAIClient: vi.fn(),
}));
vi.mock("./recovery-billing-scope", () => ({
  RECOVERY_LAB_ID: "synthetic-lab",
  RECOVERY_TAG: "recovery-fixture",
  RECOVERY_TIMEZONE: "UTC",
  RECOVERY_START: "2026-01-01",
  RECOVERY_END: "2026-01-02",
  RECOVERY_SAFEGUARD_VERSION: "recovery-safeguards-test-v1",
  recoveryScope: fixture.scope,
  recoveryDataAvailable: true,
  assertRecoveryDataAvailable: vi.fn(),
}));
vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth: { userId: string } }).auth = { userId: "fixture-billing" }; next();
  },
  requireVerifiedAccount: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { caseEvents } from "@workspace/db";
import { HttpError } from "./http";
import { analyzeRecoveredPrescription } from "./recovery-billing-analysis";
import { recoveryScope, RECOVERY_LAB_ID } from "./recovery-billing-scope";
import { PdfConversionError } from "./pdf-to-images";
import * as pdfRuntime from "./pdf-runtime";
import * as pdfConversion from "./pdf-to-images";
import router from "../routes/recovery-billing";

const fields = { restorations: [{ teeth: "19", type: "Crown", material: "Zirconia", isBridge: false }] };
const analyze = () => analyzeRecoveredPrescription(fixture.caseId, "fixture-attachment", "fixture-billing");
const app = express().use(express.json()).use("/billing-recovery", router);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error instanceof HttpError ? error.statusCode : 500)
    .json({ message: error instanceof HttpError ? error.message : "Unexpected error" });
});

describe("recovery prescription analysis (isolated evidence, real PDF reader)", () => {
  let pdf: Buffer;
  beforeAll(async () => {
    pdf = await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument({ size: [300, 300] });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.text("ISOLATED TEST ONLY. Zirconia crown tooth 19. Shade A2.");
      doc.end();
    });
    await mkdir(fixture.dir, { recursive: true });
  });
  afterAll(async () => { await rm(fixture.dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fixture.role.mockResolvedValue(undefined);
    fixture.case.mockResolvedValue({ id: fixture.caseId, caseNumber: "SYNTH-CASE-001" });
    fixture.attachment.mockResolvedValue({ id: "fixture-attachment", fileName: fixture.filename,
      fileType: "application/pdf", storageKey: `/uploads/case-media/${fixture.filename}` });
    fixture.binding.mockResolvedValue({ organizationId: RECOVERY_LAB_ID });
    fixture.audit.mockResolvedValue([{ id: "analysis-audit" }]);
    fixture.values.mockReturnValue({ returning: fixture.audit });
    fixture.insert.mockReturnValue({ values: fixture.values });
    fixture.object.mockResolvedValue(null);
    fixture.vision.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(fields) } }] });
    await writeFile(`${fixture.dir}/${fixture.filename}`, pdf);
  });
  it("binds the reported renumbered identity to original evidence, not the reissued number", () => {
    expect(recoveryScope.get(fixture.caseId)).toMatchObject({ caseNumber: "SYNTH-CASE-001", inWindow: true });
    expect(recoveryScope.get(fixture.caseId)?.prescriptions).toContain(fixture.filename);
  });
  it("extracts work through local bytes, real conversion, shared image vision and durable analysis only", async () => {
    const response = await request(app).post(`/billing-recovery/cases/${fixture.caseId}/analyze`)
      .send({ evidenceAttachmentId: "fixture-attachment" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ analysisId: "analysis-audit",
      restorations: [{ toothNumber: "19", material: "Zirconia", quantity: 1 }], exceptions: [] });
    const payload = fixture.vision.mock.calls[0]![0];
    expect(payload.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.insert).toHaveBeenCalledWith(caseEvents);
    expect(fixture.values).toHaveBeenCalledWith(expect.objectContaining({
      caseId: fixture.caseId, eventType: "billing_recovery_analyzed",
      metadataJson: expect.objectContaining({ evidenceAttachmentId: "fixture-attachment",
        evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(fixture.object).not.toHaveBeenCalled();
  });
  it("uses object storage when local evidence is absent", async () => {
    await rm(`${fixture.dir}/${fixture.filename}`);
    fixture.object.mockResolvedValue({ stream: Readable.from([pdf]), contentType: "application/pdf" });
    expect((await analyze()).restorations[0]?.toothNumber).toBe("19");
    expect(fixture.object).toHaveBeenCalledWith(fixture.filename);
  });
  it("reproduces missing deployed converter and gives safe actionable guidance without an audit/bill", async () => {
    vi.spyOn(pdfRuntime, "resolvePdfConverter").mockReturnValue("/nonexistent-isolated-fixture/pdftoppm");
    const response = await request(app).post(`/billing-recovery/cases/${fixture.caseId}/analyze`)
      .send({ evidenceAttachmentId: "fixture-attachment" });
    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/administrator.*PDF converter/);
    expect(JSON.stringify(response.body)).not.toContain("/nonexistent");
    expect(fixture.warn).toHaveBeenCalledWith({ stage: "extraction", reason: "unavailable" }, expect.any(String));
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it.each(["invalid", "truncated"])("refuses %s PDFs without inferred work", async (kind) => {
    await writeFile(`${fixture.dir}/${fixture.filename}`, kind === "invalid" ? "not a PDF" : "%PDF-1.4\nbroken");
    await expect(analyze()).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/unreadable/) });
    expect(fixture.vision).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it("maps conversion timeouts safely", async () => {
    vi.spyOn(pdfConversion, "convertPdfBufferToImageDataUrls").mockRejectedValue(new PdfConversionError("timeout"));
    await expect(analyze()).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/smaller readable copy/) });
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it.each(["missing", "storage", "stream"])("refuses %s evidence failures", async (kind) => {
    await rm(`${fixture.dir}/${fixture.filename}`);
    if (kind === "storage") fixture.object.mockRejectedValue(new Error("PRIVATE PATH credential"));
    if (kind === "stream") fixture.object.mockResolvedValue({
      stream: Readable.from((async function* () { throw new Error("PRIVATE prescription"); })()),
    });
    await expect(analyze()).rejects.toMatchObject({ statusCode: kind === "missing" ? 404 : 503 });
    expect(fixture.vision).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toMatch(/PRIVATE/);
  });
  it("rejects oversized object streams before conversion", async () => {
    await rm(`${fixture.dir}/${fixture.filename}`);
    fixture.object.mockResolvedValue({ stream: Readable.from([Buffer.alloc(26 * 1024 * 1024)]) });
    await expect(analyze()).rejects.toMatchObject({ statusCode: 413 });
    expect(fixture.vision).not.toHaveBeenCalled();
  });
  it("refuses empty local evidence rather than treating it as extracted work", async () => {
    await writeFile(`${fixture.dir}/${fixture.filename}`, "");
    await expect(analyze()).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/empty/) });
    expect(fixture.vision).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it("maps failed evidence verification without leaking SQL or patient data", async () => {
    fixture.case.mockRejectedValue(new Error("PRIVATE SQL patient contents"));
    await expect(analyze()).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/verification/) });
    expect(fixture.warn).toHaveBeenCalledWith({ stage: "evidence_lookup", reason: "failed" }, expect.any(String));
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("PRIVATE");
    expect(fixture.vision).not.toHaveBeenCalled();
  });
  it.each(["denied", "case", "attachment", "scope", "owner"])("preserves the %s evidence gate", async (gate) => {
    if (gate === "denied") fixture.role.mockRejectedValue(new HttpError(403, "Billing role required."));
    if (gate === "case") fixture.case.mockResolvedValue(undefined);
    if (gate === "attachment") fixture.attachment.mockResolvedValue(undefined);
    if (gate === "scope") fixture.attachment.mockResolvedValue({ storageKey: "/uploads/case-media/foreign.pdf" });
    if (gate === "owner") fixture.binding.mockResolvedValue({ organizationId: "foreign-lab" });
    await expect(analyze()).rejects.toBeInstanceOf(HttpError);
    expect(fixture.vision).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it("maps temporary AI failure without raw responses or patient text in diagnostics", async () => {
    fixture.vision.mockRejectedValue(new Error("PRIVATE provider response"));
    await expect(analyze()).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/Retry shortly/) });
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("PRIVATE");
  });
  it("returns ambiguity as review exceptions, not manufactured work", async () => {
    fixture.vision.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({}) } }] });
    const result = await analyze();
    expect(result.restorations).toEqual([]);
    expect(result.exceptions).not.toHaveLength(0);
    expect(fixture.insert).toHaveBeenCalledWith(caseEvents);
  });
  it("rejects unsafe extracted shapes at normalization", async () => {
    fixture.vision.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      restorations: [{ teeth: "19", type: "Crown", material: { unsafe: true } }],
    }) } }] });
    await expect(analyze()).rejects.toMatchObject({ statusCode: 422 });
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it.each(["rejected", "absent"])("does not return success when the audit is %s", async (mode) => {
    if (mode === "rejected") fixture.audit.mockRejectedValue(new Error("PRIVATE SQL with prescription"));
    else fixture.audit.mockResolvedValue([]);
    await expect(analyze()).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/could not be recorded/) });
    expect(fixture.insert).toHaveBeenCalledTimes(1);
    expect(fixture.insert).toHaveBeenCalledWith(caseEvents);
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("PRIVATE");
  });
});
