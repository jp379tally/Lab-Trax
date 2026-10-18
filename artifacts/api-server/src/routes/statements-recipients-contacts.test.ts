/**
 * Real Drizzle regression: the recipients route must not detach findFirst
 * from its relational-query receiver. Only authentication and external I/O
 * are stubbed; invoice cutoff and contact isolation execute against the DB.
 */
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db, cases, invoices, organizations, users, doctorProfiles,
  doctorPhoneEntries, doctorEmailEntries, practiceStatements,
} from "@workspace/db";
import {
  buildPracticeStatementBundles, buildPracticeStatementsForScope,
  generateStatementsZipBufferForLab, NO_DOCTOR_KEY,
} from "../lib/statements";
import router from "./statements";

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.auth = { userId: "fixture-user" };
    next();
  },
  requireVerifiedAccount: (_req: any, _res: any, next: () => void) => next(),
}));
vi.mock("../lib/rbac", () => ({
  ADMIN_ROLES: ["admin"],
  BILLING_ROLES: ["admin"],
  requireAnyRole: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/mail", () => ({
  sendMail: vi.fn(() => { throw new Error("This suite must never send mail"); }),
  getAppBaseUrl: () => "https://example.invalid",
  LAB_LOGO_CID: "lab-logo",
}));
vi.mock("../lib/lab-logo-storage", () => ({
  openLabLogoStream: vi.fn().mockResolvedValue(null),
  openInvoiceTemplateImageStream: vi.fn().mockResolvedValue(null),
}));

function pdfText(buffer: Buffer): string {
  return Array.from(buffer.toString("binary").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g))
    .flatMap((match) => {
      const bytes = Buffer.from(match[1]!, "binary");
      let content: string;
      try { content = inflateSync(bytes).toString("latin1"); }
      catch { content = bytes.toString("latin1"); }
      return Array.from(content.matchAll(/<([0-9a-fA-F]+)>/g), (hex) =>
        Buffer.from(hex[1]!, "hex").toString("latin1"));
    }).join("");
}

describe("statement recipients and previews with real ORM contacts", () => {
  const prefix = `statement_contacts_${randomUUID()}`;
  const labId = `${prefix}_lab`;
  const otherLabId = `${prefix}_other_lab`;
  const userId = `${prefix}_user`;
  const practiceIds = Array.from({ length: 19 }, (_, i) => `${prefix}_practice_${i}`);
  const cutoff = "2026-09-30T23:59:59.000Z";
  const app = express();
  app.use(express.json());
  app.use("/lab-orgs", router);
  app.use((err: Error, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });
  const options = { scope: "open_as_of" as const, asOf: new Date(cutoff) };
  const invoiceNumber = (i: number, d: number) => `FIX-${prefix.slice(-8)}-${i}-${d}`;

  beforeAll(async () => {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, username: userId, password: "fixture-only" });
      await tx.insert(organizations).values([
        { id: labId, type: "lab", name: "Contact Fixture Lab" },
        { id: otherLabId, type: "lab", name: "Other Fixture Lab" },
        ...practiceIds.map((id, i) => ({
          id, type: "provider", name: `Practice ${i + 1}`,
          billingEmail: `practice-${i + 1}@example.invalid`, phone: "555-0100",
        })),
      ]);
      await tx.insert(cases).values(practiceIds.flatMap((id, i) =>
        ["Dr. Shared", "Dr. Missing"].map((doctorName, d) => ({
          id: `${id}_case_${d}`, caseNumber: `${prefix}_${i}_${d}`,
          labOrganizationId: labId, providerOrganizationId: id,
          patientFirstName: "Fixture", patientLastName: "Patient",
          doctorName, createdByUserId: userId,
        })),
      ));
      await tx.insert(invoices).values(practiceIds.flatMap((id, i) =>
        [0, 1, 2, 3].map((d) => ({
          id: `${id}_invoice_${d}`, invoiceNumber: invoiceNumber(i, d),
          labOrganizationId: labId, providerOrganizationId: id,
          caseId: d === 2 ? null : `${id}_case_${d === 1 ? 1 : 0}`,
          status: "sent", total: "100.00", balanceDue: "100.00",
          createdByUserId: userId,
          issuedAt: new Date(d === 3 ? "2026-10-01T00:00:00Z" : "2026-09-30T12:00:00Z"),
        })),
      ));
      await tx.insert(doctorProfiles).values([
        ...practiceIds.map((id, i) => ({
          id: `${id}_profile`, labOrganizationId: labId,
          providerOrganizationId: id, doctorName: "Dr. Shared",
          displayName: `Doctor at practice ${i + 1}`,
        })),
        {
          id: `${prefix}_foreign_profile`, labOrganizationId: otherLabId,
          providerOrganizationId: practiceIds[0], doctorName: "Dr. Shared",
          displayName: "Wrong lab contact",
        },
      ]);
      await tx.insert(doctorPhoneEntries).values(practiceIds.flatMap((id) => [
        { doctorProfileId: `${id}_profile`, phoneNumber: "555-0101", label: "other" },
        { doctorProfileId: `${id}_profile`, phoneNumber: "555-0102", label: "main", isPrimary: true },
      ]));
      await tx.insert(doctorEmailEntries).values(practiceIds.flatMap((id, i) => [
        { doctorProfileId: `${id}_profile`, email: `other-${i}@example.invalid`, label: "other" },
        { doctorProfileId: `${id}_profile`, email: `doctor-${i}@example.invalid`, label: "general", isPrimary: true },
      ]));
    });
  });

  afterAll(async () => {
    // Delete only this suite's rows, including partially initialized fixtures.
    await db.transaction(async (tx) => {
      await tx.delete(invoices).where(eq(invoices.labOrganizationId, labId));
      await tx.delete(cases).where(eq(cases.labOrganizationId, labId));
      await tx.delete(doctorProfiles).where(inArray(doctorProfiles.labOrganizationId, [labId, otherLabId]));
      await tx.delete(organizations).where(inArray(organizations.id, [labId, otherLabId, ...practiceIds]));
      await tx.delete(users).where(eq(users.id, userId));
    });
  });

  it("loads all 19 practices through September 30 with every doctor and unassigned document", async () => {
    const res = await request(app)
      .get(`/lab-orgs/${labId}/statements/recipients`)
      .query({ mode: "practice", scope: options.scope, asOf: cutoff });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.recipients).toHaveLength(19);
    expect(res.body.data.recipients.map((r: any) => r.key).sort()).toEqual([...practiceIds].sort());
    for (const r of res.body.data.recipients) {
      expect(r.invoiceCount).toBe(3);
      expect(r.openBalance).toBe(300);
      expect(r.recipientEmails).toHaveLength(1);
      expect(r.doctors.map((d: any) => d.key).sort()).toEqual(
        ["Dr. Shared", "Dr. Missing", NO_DOCTOR_KEY].sort(),
      );
    }
  });

  it("keeps complete contacts scoped to the lab and billed practice and preserves fallbacks", async () => {
    const bundles = await buildPracticeStatementBundles(labId, { ...options, practiceIds });
    expect(bundles).toHaveLength(19);
    expect(bundles.flatMap((b) => b.documents)).toHaveLength(57);
    for (const bundle of bundles) {
      const i = practiceIds.indexOf(bundle.practiceId);
      const contact = bundle.documents.find((d) => d.doctorName === "Dr. Shared")!.data.doctorContact!;
      expect(contact.displayName).toBe(`Doctor at practice ${i + 1}`);
      expect(contact.legalName).toBe("Dr. Shared");
      expect(contact.phone).toBe("555-0102");
      expect(contact.phones.sort()).toEqual(["555-0101", "555-0102"]);
      expect(contact.billingEmail).toBe(`doctor-${i}@example.invalid`);
      expect(contact.emails.sort()).toEqual([`doctor-${i}@example.invalid`, `other-${i}@example.invalid`].sort());
      for (const document of bundle.documents) {
        expect(document.data.invoices).toHaveLength(1);
        expect(document.data.invoices[0]!.id).not.toMatch(/_invoice_3$/);
        expect(document.data.practiceContact?.billingEmail).toBe(`practice-${i + 1}@example.invalid`);
        if (document.doctorName !== "Dr. Shared") expect(document.data.doctorContact).toBeNull();
      }
    }
    const doctors = await buildPracticeStatementsForScope(labId, { ...options, recipientType: "doctor" });
    expect(doctors).toHaveLength(57);
    expect(doctors.find((d) => d.practiceId === `${practiceIds[0]}::Dr. Shared`)?.doctorContact?.displayName)
      .toBe("Doctor at practice 1");
    const res = await request(app).get(`/lab-orgs/${labId}/statements/recipients`)
      .query({ mode: "doctor", scope: options.scope, asOf: cutoff });
    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toHaveLength(57);
  });

  it("surfaces genuine contact database failures instead of silently omitting documents", async () => {
    const lookup = vi.spyOn(db.query.doctorProfiles, "findFirst")
      .mockImplementation(() => { throw new Error("contact database unavailable"); });
    try {
      const res = await request(app).get(`/lab-orgs/${labId}/statements/recipients`)
        .query({ mode: "practice", scope: options.scope, asOf: cutoff });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("contact database unavailable");
    } finally {
      lookup.mockRestore();
    }
  });

  it("previews each document type and exports all selected PDFs without issuing statements or sending mail", async () => {
    for (const documentKey of ["Dr. Shared", "Dr. Missing", NO_DOCTOR_KEY]) {
      const res = await request(app).post(`/lab-orgs/${labId}/statements/preview-pdf`).send({
        recipientType: "practice", recipientKey: practiceIds[0], documentKey,
        invoiceScope: options.scope, asOf: cutoff,
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
      const text = pdfText(res.body);
      expect(text).toContain(invoiceNumber(0, documentKey === "Dr. Shared" ? 0 : documentKey === "Dr. Missing" ? 1 : 2));
      expect(text).not.toContain(invoiceNumber(0, 3));
      if (documentKey === "Dr. Shared") {
        expect(text).toContain("Doctor at practice 1");
        expect(text).toContain("doctor-0@example.invalid");
      }
    }
    const doctorPreview = await request(app).post(`/lab-orgs/${labId}/statements/preview-pdf`).send({
      recipientType: "doctor", recipientKey: `${practiceIds[0]}::Dr. Shared`,
      invoiceScope: options.scope, asOf: cutoff,
    });
    expect(doctorPreview.status).toBe(200);
    expect(pdfText(doctorPreview.body)).toContain("doctor-0@example.invalid");
    const { zipBuffer } = await generateStatementsZipBufferForLab({
      labOrganizationId: labId, recipientType: "practice", practiceIds,
      invoiceScope: options.scope, asOf: new Date(cutoff),
    });
    const entries = new AdmZip(zipBuffer).getEntries();
    expect(entries).toHaveLength(57);
    expect(new Set(entries.map((e) => e.entryName)).size).toBe(57);
    const exportedTexts = entries.map((entry) => {
      expect(entry.getData().subarray(0, 5).toString()).toBe("%PDF-");
      return pdfText(entry.getData());
    });
    for (let i = 0; i < 19; i++) {
      for (let d = 0; d < 3; d++) {
        expect(exportedTexts.filter((text) => text.includes(invoiceNumber(i, d)))).toHaveLength(1);
      }
      expect(exportedTexts.some((text) => text.includes(invoiceNumber(i, 3)))).toBe(false);
    }
    expect(await db.select().from(practiceStatements).where(eq(practiceStatements.labOrganizationId, labId))).toEqual([]);
  });
});
