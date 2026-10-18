import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const SOURCE_PATH = path.resolve(
  __dirname,
  "../components/customer-detail-tabs.tsx",
);

describe("customer card-on-file billing controls", () => {
  let source: string;

  beforeEach(() => {
    source = fs.readFileSync(SOURCE_PATH, "utf8");
  });

  it("uses the hosted setup and authoritative charge endpoints", () => {
    expect(source).toContain('"/provider/lab-card/setup"');
    expect(source).toContain('"/provider/lab-card/charge"');
    expect(source).toContain("idempotencyKey");
  });

  it("retains the hosted session and resolves setup status authoritatively once", () => {
    expect(source).toContain("sessionId: string");
    expect(source).toContain("setSetupSessionId(sessionId)");
    expect(source).toContain("/provider/lab-card/setup-status/");
    expect(source).toContain("setupTerminalEventsRef.current.has(setupSessionId)");
    expect(source).toContain('trackSavedCardSetup(status.status)');
    expect(source).toContain('status.status !== "pending"');
  });

  it("uses completed practice-scoped PDF authorization records instead of in-app signing", () => {
    expect(source).toContain("`/admin/practices/${encodeURIComponent(practice.id)}/authorization-documents`");
    expect(source).toContain("/admin/authorization-documents/");
    expect(source).toContain("apiUploadWithProgress");
    expect(source).toContain('accept="application/pdf,.pdf"');
    expect(source).toContain("button-upload-authorization");
    expect(source).not.toContain("<AuthorizationSigningModal");
  });

  it("renders masked card, read-only auto-pay, and reviewed allocations", () => {
    expect(source).toContain("•••• •••• ••••");
    expect(source).toContain('data-testid="autopay-status"');
    expect(source).toContain("Invoices are due by the 10th");
    expect(source).toContain('data-testid="checkbox-confirm-card-charge"');
    expect(source).toContain('data-testid="button-confirm-card-charge"');
  });

  it("limits card billing controls to billing roles and refreshes affected data", () => {
    expect(source).toMatch(/user\?\.role === "owner".*user\?\.role === "admin".*user\?\.role === "billing"/s);
    expect(source).toContain('queryKey: ["invoices"]');
    expect(source).toContain('queryKey: ["provider-lab-card"]');
    expect(source).toContain('queryKey: ["payments"]');
    expect(source).toContain('queryKey: ["receive-payments"]');
    expect(source).toContain('window.addEventListener("focus", refresh)');
  });
});