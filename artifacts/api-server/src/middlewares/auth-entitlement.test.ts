import { describe, expect, it } from "vitest";
import { isMutationAllowedDuringReadOnly } from "./auth";

describe("read-only mutation boundary", () => {
  it.each([
    ["GET", "/api/cases/case-1", true],
    ["HEAD", "/api/cases/case-1/attachments/file", true],
    ["OPTIONS", "/api/messages", true],
    ["POST", "/api/auth/logout", true],
    ["POST", "/api/provider/selection", true],
    ["POST", "/api/billing/checkout-session", true],
    ["POST", "/api/billing/portal-session", true],
    ["POST", "/api/billing/reactivate", true],
    ["POST", "/api/billing/link-revenuecat", false],
    ["POST", "/api/billing/decline-renewal", true],
    ["POST", "/api/cases", false],
    ["PATCH", "/api/cases/case-1", false],
    ["POST", "/api/media/upload-session", false],
    ["POST", "/api/provider-messenger/threads", false],
    ["POST", "/api/ai-agent/chat", false],
    ["PATCH", "/api/invoices/invoice-1", false],
    ["POST", "/api/statements", false],
    ["PATCH", "/api/auth/users/user-1/profile", false],
    ["DELETE", "/api/auth/users/user-1", false],
    ["PATCH", "/api/provider/subscription-autopay", false],
    ["POST", "/api/provider/payment-checkout", false],
  ] as const)("%s %s => %s", (method, path, allowed) => {
    expect(isMutationAllowedDuringReadOnly(method, `${path}?ignored=1`)).toBe(allowed);
  });
});