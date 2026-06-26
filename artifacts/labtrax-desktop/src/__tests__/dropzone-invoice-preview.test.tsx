/**
 * Regression guard: the drop-zone AI/Rx case-proposal panel must show a
 * read-only draft-invoice preview BEFORE the case is created, and that preview
 * must list, per line, the description (with optional tooth label), quantity,
 * unit price, and line total — plus an overall Total and a clear "not priced"
 * state for unpriced items.
 *
 * A full render test is impractical here: reaching the rxConfirm phase requires
 * a file drop + AI extraction round-trip through a very large component. So we
 * use the codebase's established static source-guard pattern (see
 * notification-case-navigation.test.tsx) to fail immediately if any required
 * piece of the preview UI or its wiring is removed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const SRC_PATH = path.resolve(__dirname, "../components/DashboardDropZone.tsx");

describe("Drop-zone invoice preview — static source guards", () => {
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(SRC_PATH, "utf-8");
  });

  it("calls the non-persisting preview endpoint", () => {
    expect(
      src,
      "DashboardDropZone must POST to /invoices/preview-draft to fetch the draft preview",
    ).toContain("/invoices/preview-draft");
  });

  it("uses the generated preview result type for the response", () => {
    expect(
      src,
      "Preview state must be typed with the generated PreviewDraftInvoiceResultData",
    ).toMatch(/PreviewDraftInvoiceResultData/);
  });

  it("gates the preview effect on the rxConfirm phase", () => {
    expect(
      src,
      "The preview effect must only run during the rxConfirm phase",
    ).toMatch(/phase\.kind\s*!==\s*"rxConfirm"/);
  });

  it("debounces the preview request with a timeout", () => {
    expect(
      src,
      "The preview request must be debounced (setTimeout) and cleared on change",
    ).toMatch(/setTimeout/);
    expect(src).toMatch(/clearTimeout/);
  });

  it("renders an Invoice preview section", () => {
    expect(src).toContain("Invoice preview");
  });

  it("renders per-line unit price", () => {
    expect(
      src,
      "Each preview line must display its unit price (e.g. `qty × $unitPrice`)",
    ).toMatch(/\$\{unitPrice\}/);
  });

  it("renders per-line quantity", () => {
    expect(src).toMatch(/li\.quantity/);
  });

  it("renders per-line line total", () => {
    expect(src).toMatch(/li\.lineTotal/);
  });

  it("renders the invoice total", () => {
    expect(src).toMatch(/invoicePreview!\.total/);
  });

  it("shows a clear 'not priced' state for unpriced lines", () => {
    expect(
      src,
      "Unpriced lines (priced === false) must render a 'not priced' label",
    ).toContain("not priced");
    expect(src).toMatch(/li\.priced\s*===\s*false/);
  });

  it("does not persist anything (read-only) — no create call inside the preview effect", () => {
    // The preview must never trigger case creation. createCaseFromRx is only
    // wired to the explicit "Create case" button.
    const previewBlock = src.slice(
      src.indexOf("/invoices/preview-draft") - 1200,
      src.indexOf("/invoices/preview-draft") + 400,
    );
    expect(
      previewBlock,
      "The preview fetch effect must not call createCaseFromRx",
    ).not.toContain("createCaseFromRx(");
  });
});
