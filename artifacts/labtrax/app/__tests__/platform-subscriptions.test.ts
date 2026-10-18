import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  correctAdminSubscriptionAccountNumber,
  getAdminSubscriptionHistory,
  getAdminSubscriptions,
  parseFutureWaiverEnd,
  saveAdminSubscriptionWaiver,
  subscriptionAccessLabel,
  updateAdminSubscription,
} from "@/lib/admin-subscriptions";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

const accountSource = readFileSync(join(__dirname, "../(tabs)/account.tsx"), "utf8");
const adminSource = readFileSync(join(__dirname, "../settings/platform-admin.tsx"), "utf8");
const consoleSource = readFileSync(join(__dirname, "../settings/platform-subscriptions.tsx"), "utf8");

afterEach(resetMockFetchHandler);

describe("creator mobile subscription console", () => {
  it("moves the console into Creator and keeps the unrelated Platform Admin row", async () => {
    expect(adminSource).not.toContain("creator-subscriptions-row");
    expect(adminSource).not.toContain("/settings/platform-subscriptions");
    expect(accountSource).toContain('title="Platform Admin"');
    expect(accountSource).toContain("/settings/creator");
    expect(accountSource).not.toContain('<SettingsSection title="Owner">');
    expect(consoleSource).toContain("CreatorGate");
  });

  it("renders canonical metadata, filters, management controls, and history", async () => {
    for (const contract of [
      "accountHolderName", "accountType", "canonicalAccountNumber", "formattedAddress",
      "No address on file", "Legacy account (no number)", "monthlyPriceUsd",
      "subscriptionAccessLabel", "status-filter-", "account-number-input", "waiver-reason-input",
      "waiver-indefinite", "Audit history", "Changes saved.",
    ]) expect(consoleSource).toContain(contract);
  });

  it("uses creator endpoints for filters and every mutation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    setMockFetchHandler(async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/history")) return Response.json({ events: [], audits: [] });
      return Response.json({ items: [], total: 0, plans: [], ok: true });
    });
    await getAdminSubscriptions({ q: "Bright", status: "active", plan: "premium" });
    await updateAdminSubscription("sub 1", { status: "grace" });
    await correctAdminSubscriptionAccountNumber("sub 1", "LAB-1");
    await saveAdminSubscriptionWaiver("sub 1", { reason: "Migration", endsAt: null });
    await getAdminSubscriptionHistory("sub 1");

    expect(requests[0].url).not.toContain("q=Bright");
    expect(requests[0].url).toContain("status=active");
    expect(requests[0].url).toContain("plan=premium");
    expect(requests.map((r) => r.url)).toEqual([
      expect.stringContaining("/api/admin/provider-subscriptions?"),
      "/api/admin/provider-subscriptions/sub%201",
      "/api/admin/provider-subscriptions/sub%201/account-number",
      "/api/admin/provider-subscriptions/sub%201/waiver",
      "/api/admin/provider-subscriptions/sub%201/history",
    ]);
    expect(requests.slice(1).map((r) => r.init?.method)).toEqual(["PATCH", "PATCH", "PUT", undefined]);
    expect(JSON.parse(String(requests[3].init?.body))).toMatchObject({ reason: "Migration", endsAt: null });
  });

  it("strictly rejects malformed, impossible, and non-future waiver dates", async () => {
    const now = new Date("2026-09-04T00:00:00Z");
    expect(parseFutureWaiverEnd("2026-02-30", now)).toBeNull();
    expect(parseFutureWaiverEnd("09/10/2026", now)).toBeNull();
    expect(parseFutureWaiverEnd("2026-09-03", now)).toBeNull();
    expect(parseFutureWaiverEnd("2026-09-10", now)).toBe("2026-09-10T23:59:59.999Z");
  });

  it("surfaces account-number conflicts with the server message", async () => {
    setMockFetchHandler(async () => Response.json(
      { error: "Account number is already assigned." },
      { status: 409 },
    ));
    await expect(correctAdminSubscriptionAccountNumber("sub-1", "DUPLICATE"))
      .rejects.toMatchObject({ status: 409, message: "Account number is already assigned." });
  });

  it("distinguishes paid, waived, grace, expired/canceled, and locked access", async () => {
    const label = (status: any, waiverActive = false, waiverEndsAt: string | null = null) =>
      subscriptionAccessLabel({ status, waiverActive, waiverEndsAt });
    expect(label("active")).toBe("Paid");
    expect(label("active", true)).toBe("Waived indefinitely");
    expect(label("active", true, "2027-01-01")).toBe("Waived");
    expect(label("grace")).toBe("In grace");
    expect(label("canceled")).toBe("Canceled");
    expect(label("locked")).toBe("Locked");
  });
});