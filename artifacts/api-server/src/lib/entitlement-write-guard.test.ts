import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationType: "lab",
  getEntitlement: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  organizations: { id: "id", type: "type" },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ type: mocks.organizationType }],
        }),
      }),
    }),
  },
}));

vi.mock("./entitlement", () => ({
  getEntitlement: mocks.getEntitlement,
}));

import {
  assertOrganizationMutationAllowed,
  runWithEntitlementRequestContext,
} from "./entitlement-write-guard";

describe("resource-bound entitlement write guard", () => {
  it.each(["free", "onboarding_pending"])("blocks direct %s mutations even with a billing waiver", async (status) => {
    mocks.getEntitlement.mockResolvedValue({ status, accessLevel: "read_only", hasActiveWaiver: true });
    await expect(runWithEntitlementRequestContext(
      { method: "POST", originalUrl: "/api/cases" },
      () => assertOrganizationMutationAllowed("provider-b"),
    )).rejects.toMatchObject({ statusCode: 403 });
  });
  beforeEach(() => {
    mocks.organizationType = "lab";
    mocks.getEntitlement.mockReset();
  });

  it("blocks the resolved read-only tenant regardless of unrelated request headers", async () => {
    mocks.getEntitlement.mockResolvedValue({
      accessLevel: "read_only",
      hasActiveWaiver: false,
    });

    await expect(
      runWithEntitlementRequestContext(
        { method: "PATCH", originalUrl: "/api/organizations/resource-b" },
        () => assertOrganizationMutationAllowed("tenant-b"),
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { code: "BILLING_READ_ONLY" },
    });
    expect(mocks.getEntitlement).toHaveBeenCalledWith({
      subjectType: "lab_org",
      subjectId: "tenant-b",
    });
  });

  it("preserves reads, recovery mutations, and active administrative waivers", async () => {
    mocks.getEntitlement.mockResolvedValue({
      accessLevel: "read_only",
      hasActiveWaiver: true,
    });
    await runWithEntitlementRequestContext(
      { method: "PATCH", originalUrl: "/api/cases/case-b" },
      () => assertOrganizationMutationAllowed("tenant-b"),
    );
    await runWithEntitlementRequestContext(
      { method: "GET", originalUrl: "/api/cases/case-b" },
      () => assertOrganizationMutationAllowed("tenant-b"),
    );
    await runWithEntitlementRequestContext(
      { method: "POST", originalUrl: "/api/billing/checkout-session" },
      () => assertOrganizationMutationAllowed("tenant-b"),
    );
  });

  it("allows an administrator to report an issue while the account is read-only", async () => {
    mocks.getEntitlement.mockResolvedValue({
      accessLevel: "read_only",
      hasActiveWaiver: false,
    });

    await runWithEntitlementRequestContext(
      {
        method: "POST",
        originalUrl: "/api/support-reports?portal=provider",
      },
      () => assertOrganizationMutationAllowed("provider-b"),
    );

    expect(mocks.getEntitlement).not.toHaveBeenCalled();
  });
});