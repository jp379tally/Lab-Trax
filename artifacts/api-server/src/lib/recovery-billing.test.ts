import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertRecoveryReleased, finalizedInvoiceSql, isRecoveryHeld } from "./recovery-billing-hold";
import { assertRecoveryDataAvailable, buildRecoveryScope, loadRecoveryScopeFromDirectory } from "./recovery-billing-scope";
import { recoveredRxWork } from "./recovery-billing-analysis";
import { buildBridgeAwareLineItems } from "./invoice-line-grouping";
import { sumGroupedLineItemsTotal } from "./invoice-sync";
import { recoveryPreviewSchema, recoveryProposalSchema } from "./recovery-billing";
import { invoiceRecognizedAsOf } from "./ap-ar-reporting";
import { recoveryRunSchema, RECOVERY_SAFEGUARD_VERSION } from "./recovery-billing-run";

describe("reconstructed billing boundaries", () => {
  it("builds evidence scope from typed synthetic records and attachments", () => {
    const scope = buildRecoveryScope(
      [{
        case_number: "SYNTH-OLD-001", received_at: "2026-10-01",
        provider_organization_id: "synthetic-practice", needs_ai_review: false,
        evidence: { source: "synthetic-fixture" },
      }],
      { "SYNTH-OLD-001": [
        { disk_filename: "synthetic-rx.pdf", kind: "prescription" },
        { disk_filename: "synthetic-note.txt", kind: "note" },
      ] },
      { "SYNTH-OLD-001": "SYNTH-CASE-001" },
    );
    expect(scope.size).toBe(1);
    expect([...scope.values()][0]).toMatchObject({
      caseNumber: "SYNTH-CASE-001", historicalDate: "2026-10-01",
      practiceId: "synthetic-practice", flagged: false,
      prescriptions: ["synthetic-rx.pdf"], inWindow: true,
    });
  });

  it("loads validated synthetic source files and fails closed when private files are absent", () => {
    const syntheticDirectory = path.join(tmpdir(), `labtrax-recovery-fixture-${randomUUID()}`);
    const directory = mkdtempSync(syntheticDirectory);
    try {
      writeFileSync(path.join(directory, "staged-cases.json"), JSON.stringify([
        "001", "002", "003",
      ].map((suffix) => ({
        case_number: `SYNTH-OLD-${suffix}`, received_at: "2026-01-02",
        provider_organization_id: "synthetic-practice", needs_ai_review: false,
        evidence: { source: "synthetic-fixture" },
      }))));
      writeFileSync(path.join(directory, "staged-attachments.json"), JSON.stringify({
        "SYNTH-OLD-001": [{ disk_filename: "synthetic-rx-2.pdf", kind: "prescription" }],
      }));
      writeFileSync(path.join(directory, "recovery-scope-config.json"), JSON.stringify({
        labId: "00000000-0000-4000-8000-000000000123",
        tag: "recovery-test-fixture",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        timezone: "UTC",
        safeguardVersion: "recovery-safeguards-test-v1",
        caseNumberOverrides: {
          "SYNTH-OLD-001": "SYNTH-CASE-001",
          "SYNTH-OLD-002": "SYNTH-CASE-002",
          "SYNTH-OLD-003": "SYNTH-CASE-003",
        },
        legacyCleanup: {
          confirmationPhrase: "CONFIRM_SYNTHETIC_CLEANUP",
          eraStartMs: Date.parse("2026-01-01T00:00:00.000Z"),
          eraEndMs: Date.parse("2026-02-01T00:00:00.000Z"),
          targetPatients: ["Synthetic Patient"],
        },
      }));
      const loaded = loadRecoveryScopeFromDirectory(directory);
      expect(loaded.available).toBe(true);
      expect(loaded.scope.size).toBe(3);
      expect([...loaded.scope.values()][0]).toMatchObject({
        caseNumber: "SYNTH-CASE-001", prescriptions: ["synthetic-rx-2.pdf"], inWindow: true,
      });
      rmSync(path.join(directory, "recovery-scope-config.json"));
      const missing = loadRecoveryScopeFromDirectory(directory);
      expect(missing).toMatchObject({ available: false, reason: "missing" });
      expect(missing.scope.size).toBe(0);
      let thrown: unknown;
      try { assertRecoveryDataAvailable(missing); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ statusCode: 503, message: expect.stringMatching(/private source records/) });
      writeFileSync(path.join(directory, "recovery-scope-config.json"), JSON.stringify({
        labId: "00000000-0000-4000-8000-000000000123",
        tag: "recovery-test-fixture", startDate: "2026-01-01", endDate: "2026-01-31",
        timezone: "UTC", safeguardVersion: "recovery-safeguards-test-v1",
        caseNumberOverrides: {},
      }));
      expect(loadRecoveryScopeFromDirectory(directory))
        .toMatchObject({ available: false, reason: "invalid", scope: new Map() });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on either status or persisted hold metadata", () => {
    for (const invoice of [
      { status: "recovery_draft" },
      { status: "open", displayMetadataJson: { recoveryBilling: { state: "held" } } },
      { status: "paid", displayMetadataJson: { recoveryBilling: { state: "held" } } },
    ]) {
      expect(isRecoveryHeld(invoice)).toBe(true);
      expect(() => assertRecoveryReleased(invoice)).toThrow(/historical-payment review/);
    }
    expect(() => assertRecoveryReleased({ status: "open" })).not.toThrow();
    expect(() => assertRecoveryReleased({ status: "open",
      displayMetadataJson: { recoveryBilling: { state: "released" } } })).not.toThrow();
  });

  it("excludes drafts and metadata holds in SQL without changing ordinary statuses", () => {
    const query = new PgDialect().sqlToQuery(finalizedInvoiceSql());
    expect(query.sql).toContain("status");
    expect(query.sql).toContain("'recoveryBilling'->>'state'");
    expect(query.params).toContain("recovery_draft");
    expect(query.sql).toContain("'held'");
  });

  it("never recognizes a held accounting snapshot as issued revenue", () => {
    expect(invoiceRecognizedAsOf({
      invoiceId: "held", status: "recovery_draft", totalCents: 20000, balanceDueCents: 0,
      issuedAt: new Date("2026-01-01"), dueAt: null, voidedAt: null, fromSnapshot: true,
    }, new Date("2026-01-02"))).toBe(false);
  });

  it("cannot accept dollar amounts from intake/proposal callers", () => {
    expect(recoveryProposalSchema.safeParse({
      evidenceAttachmentId: "rx", prescriptionReviewed: true, identityReviewed: true,
      duplicateReviewed: true, reviewNotes: "Reviewed against prescription.",
      restorations: [{ toothNumber: "8", restorationType: "Crown & Bridge",
        material: "Zirconia", quantity: 1, unitPrice: 1 }],
    }).success).toBe(false);
  });

  it("previews entered work without review sign-off but still refuses caller amounts", () => {
    const work = { evidenceAttachmentId: "rx", bridgeConnectors: null,
      restorations: [{ toothNumber: "19", restorationType: "Crown & Bridge", material: "Zirconia", shade: "A2", quantity: 1 }] };
    expect(recoveryPreviewSchema.safeParse(work).success).toBe(true);
    expect(recoveryPreviewSchema.safeParse({ ...work,
      restorations: [{ ...work.restorations[0], unitPrice: 1 }] }).success).toBe(false);
    expect(recoveryPreviewSchema.safeParse({ ...work, total: "1.00" }).success).toBe(false);
    expect(recoveryPreviewSchema.safeParse({ ...work, restorations: [] }).success).toBe(false);
  });

  it("routes summaries, unspecified materials, ranges and ambiguous repair work to review", () => {
    expect(recoveredRxWork({}).exceptions).not.toHaveLength(0);
    expect(recoveredRxWork({ restorations: [{ teeth: "8-10", type: "Crown", material: "Zirconia", isBridge: true }] }).restorations).toHaveLength(0);
    expect(recoveredRxWork({ restorations: [{ teeth: "8", type: "Crown", material: null, isBridge: false }] }).restorations).toHaveLength(0);
    expect(recoveredRxWork({ caseType: "Removable", removableSubtype: "repair", arch: "upper" }).exceptions).not.toHaveLength(0);
  });

  it("retains explicit per-tooth work, not one charge for an entire case", () => {
    const result = recoveredRxWork({ restorations: [
      { teeth: "8,9", type: "Crown", material: "Zirconia", isBridge: false },
      { teeth: "10", type: "Pontic", material: "Zirconia", isBridge: true },
    ] });
    expect(result.restorations.map((row) => row.toothNumber)).toEqual(["8", "9", "10"]);
    expect(result.restorations[2]?.restorationType).toBe("Pontic");
    expect(result.exceptions).toContain("Bridge/pontic topology needs an explicit reviewed connector map.");
  });

  it("prices each explicit arch once and keeps partial teeth as prescription detail", () => {
    const result = recoveredRxWork({ caseType: "Removable", removableSubtype: "partial",
      arch: "upper_lower", material: "Acrylic", teeth: "3,4,7" });
    expect(result.restorations.map((row) => [row.arch, row.quantity])).toEqual([["upper", 1], ["lower", 1]]);
  });

  it("uses canonical bridge units and supported porcelain children in proposed totals", () => {
    const bridge = buildBridgeAwareLineItems([
      { id: "a", toothNumber: "8", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "100.00" },
      { id: "b", toothNumber: "9", restorationType: "Pontic", material: "Zirconia", quantity: 1, unitPrice: "100.00" },
      { id: "c", toothNumber: "10", restorationType: "Crown", material: "Zirconia", quantity: 1, unitPrice: "100.00" },
    ], "8-9,9-10", false);
    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.quantity).toBe(3);
    expect(sumGroupedLineItemsTotal(bridge.map((row, sortOrder) => ({ ...row, invoiceId: "invoice", sortOrder })))).toBe("300.00");
    const pfz = buildBridgeAwareLineItems([
      { id: "pfz", toothNumber: "8", restorationType: "Crown", material: "Porcelain Fused to Zirconia", quantity: 1, unitPrice: "100.00" },
    ], null, false);
    expect(pfz[0]?.childItems?.[0]?.unitPrice).toBe("37.00");
    expect(sumGroupedLineItemsTotal(pfz.map((row, sortOrder) => ({ ...row, invoiceId: "invoice", sortOrder })))).toBe("137.00");
  });

  it("requires exact run identity, rollback and rehearsal evidence before approval", () => {
    expect(recoveryRunSchema.safeParse({ version: RECOVERY_SAFEGUARD_VERSION, proposals: {} }).success).toBe(false);
  });
});
