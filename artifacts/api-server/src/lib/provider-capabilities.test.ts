import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSubjectForUser: vi.fn(),
  getEntitlement: vi.fn(),
  getProviderOrgIdsForUserAndLinks: vi.fn(),
}));

vi.mock("./entitlement", () => ({
  getSubjectForUser: mocks.getSubjectForUser,
  getEntitlement: mocks.getEntitlement,
}));

// The unit tests exercise entitlement decisions only; no case row lookup is
// reached by assertProviderCapability.
vi.mock("@workspace/db", () => ({ db: {}, cases: {} }));
vi.mock("./cross-lab-doctor", () => ({
  getProviderOrgIdsForUserAndLinks: mocks.getProviderOrgIdsForUserAndLinks,
}));

import {
  assertLinkedProviderCapability,
  assertProviderCapability,
} from "./provider-capabilities";

const providerSubject = { subjectType: "provider_org", subjectId: "provider-1" };
const labSubject = { subjectType: "lab_org", subjectId: "lab-1" };

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    accessLevel: "full",
    hasActiveWaiver: false,
    providerPlan: "basic",
    capabilities: {
      active_case_view: true,
      billing_view_pay: false,
      lab_communication: false,
    },
    ...overrides,
  };
}

describe("provider capability enforcement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSubjectForUser.mockResolvedValue(providerSubject);
    mocks.getProviderOrgIdsForUserAndLinks.mockResolvedValue({ providerOrgIds: [] });
  });

  it("allows Basic active-case reads but rejects billing and communication", async () => {
    mocks.getEntitlement.mockResolvedValue(entitlement());
    await expect(assertProviderCapability("user-1", "case_read")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "billing")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertProviderCapability("user-1", "communication")).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each(["free", "onboarding_pending"])("enforces %s case-only capabilities independently of waivers and selected paid tier", async (status) => {
    mocks.getEntitlement.mockResolvedValue(entitlement({
      status, providerPlan: status === "free" ? "free" : "premium",
      accessLevel: "read_only", hasActiveWaiver: true,
      capabilities: { active_case_view: true, billing_view_pay: true, lab_communication: true },
    }));
    await expect(assertProviderCapability("user-1", "case_read")).resolves.toBeUndefined();
    for (const capability of ["billing", "communication", "provider_portal"] as const) {
      await expect(assertProviderCapability("user-1", capability)).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it("allows Standard billing but rejects communication", async () => {
    mocks.getEntitlement.mockResolvedValue(entitlement({
      providerPlan: "standard",
      capabilities: {
        active_case_view: true,
        billing_view_pay: true,
        lab_communication: false,
      },
    }));
    await expect(assertProviderCapability("user-1", "billing")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "communication")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("allows every provider portal capability for Premium", async () => {
    mocks.getEntitlement.mockResolvedValue(entitlement({
      providerPlan: "premium",
      capabilities: {
        active_case_view: true,
        billing_view_pay: true,
        lab_communication: true,
      },
    }));
    await expect(assertProviderCapability("user-1", "case_read")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "billing")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "communication")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "provider_portal")).resolves.toBeUndefined();
  });

  it("keeps plan-authorized retained-data reads available in read-only mode", async () => {
    mocks.getEntitlement.mockResolvedValue(entitlement({
      providerPlan: "premium",
      accessLevel: "read_only",
      capabilities: {
        active_case_view: true,
        billing_view_pay: true,
        lab_communication: true,
      },
    }));
    await expect(assertProviderCapability("user-1", "case_read")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "billing")).resolves.toBeUndefined();
  });

  it("uses the assigned plan during an active waiver", async () => {
    mocks.getEntitlement.mockResolvedValue(entitlement({
      providerPlan: "standard",
      accessLevel: "full",
      hasActiveWaiver: true,
      capabilities: {
        active_case_view: true,
        billing_view_pay: true,
        lab_communication: false,
      },
    }));
    await expect(assertProviderCapability("user-1", "billing")).resolves.toBeUndefined();
    await expect(assertProviderCapability("user-1", "communication")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("does not apply provider plan restrictions to lab subjects", async () => {
    mocks.getSubjectForUser.mockResolvedValue(labSubject);
    await expect(assertProviderCapability("lab-user", "communication")).resolves.toBeUndefined();
    expect(mocks.getEntitlement).not.toHaveBeenCalled();
  });

  it("does not let a lab-preferred mixed identity bypass its provider org plan", async () => {
    mocks.getSubjectForUser.mockResolvedValue(labSubject);
    mocks.getProviderOrgIdsForUserAndLinks.mockResolvedValue({
      providerOrgIds: ["provider-basic"],
    });
    mocks.getEntitlement.mockResolvedValue(entitlement());

    // The legacy/user-preferred check is intentionally a lab pass-through.
    await expect(assertProviderCapability("mixed-user", "billing")).resolves.toBeUndefined();
    // Provider-facing routes must use the linked-org-aware check instead.
    await expect(
      assertLinkedProviderCapability("mixed-user", "billing"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("requires every linked provider organization to include the feature", async () => {
    mocks.getProviderOrgIdsForUserAndLinks.mockResolvedValue({
      providerOrgIds: ["provider-premium", "provider-basic"],
    });
    mocks.getEntitlement
      .mockResolvedValueOnce(entitlement({
        providerPlan: "premium",
        capabilities: {
          active_case_view: true,
          billing_view_pay: true,
          lab_communication: true,
        },
      }))
      .mockResolvedValueOnce(entitlement());

    await expect(
      assertLinkedProviderCapability("mixed-user", "communication"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("evaluates provider-portal capability by linked org for mixed identities", async () => {
    mocks.getSubjectForUser.mockResolvedValue(labSubject);
    mocks.getProviderOrgIdsForUserAndLinks.mockResolvedValue({
      providerOrgIds: ["provider-premium"],
    });
    mocks.getEntitlement.mockResolvedValue(entitlement({
      providerPlan: "premium",
      capabilities: {
        active_case_view: true,
        billing_view_pay: true,
        lab_communication: true,
      },
    }));

    await expect(
      assertLinkedProviderCapability("mixed-user", "provider_portal"),
    ).resolves.toEqual(["provider-premium"]);
  });
});