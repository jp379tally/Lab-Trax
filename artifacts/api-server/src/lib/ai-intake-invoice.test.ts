import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { insertOrResolveAiIntakeInvoice } from "./ai-intake-invoice";

function txFor({
  inserted,
  existing,
}: {
  inserted?: unknown;
  existing?: unknown;
}) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => (inserted ? [inserted] : []),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => (existing ? [existing] : []),
        }),
      }),
    }),
  };
}

describe("AI intake invoice conflict handling", () => {
  const values = {
    invoiceNumber: "INV-AI-1",
    caseId: "case-1",
    labOrganizationId: "lab-1",
  };

  it("returns the inserted invoice", async () => {
    const invoice = { id: "invoice-1", ...values };
    await expect(
      insertOrResolveAiIntakeInvoice(txFor({ inserted: invoice }), values, "case-1", "lab-1"),
    ).resolves.toEqual({ ...invoice, newlyCreated: true });
  });

  it("resolves a conflict only to the same case and tenant", async () => {
    const invoice = { id: "invoice-1", ...values };
    await expect(
      insertOrResolveAiIntakeInvoice(txFor({ existing: invoice }), values, "case-1", "lab-1"),
    ).resolves.toEqual({ ...invoice, newlyCreated: false });
  });

  it("fails when a conflict does not resolve to a live matching invoice", async () => {
    await expect(
      insertOrResolveAiIntakeInvoice(txFor({}), values, "case-1", "lab-1"),
    ).rejects.toThrow("did not resolve to a live invoice");
  });

  it("keeps all three iTero invoice writers from rebuilding a resolved same-case invoice", () => {
    const source = readFileSync(fileURLToPath(import.meta.resolve("../routes/cases.ts")), "utf8");
    const starts = [...source.matchAll(/const autoInvoice = await insertOrResolveAiIntakeInvoice\(tx,/g)]
      .map((match) => match.index);
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      const path = source.slice(start, source.indexOf("autoInvoiceId = autoInvoice.id;", start));
      expect(path).toMatch(/if \(autoInvoice\.newlyCreated\) \{[\s\S]*?insertGroupedLineItemsWithChildren\(tx, itemsToInsert\)/);
    }
  });
});