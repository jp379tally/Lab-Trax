// Which shell a signed-in mobile user belongs in, and where a provider
// notification takes them. Both are pure decisions extracted from the portal so
// they can be pinned here without rendering the navigator.
import { describe, expect, it } from "vitest";
import {
  decideProviderPortal,
  hasActiveLabMembership,
} from "@/lib/provider-portal";
import { notificationTarget } from "@/components/provider-portal/ProviderPortalHeader";
import type { MeResponse } from "@/lib/auth-me";

function me(
  memberships: Array<{ orgId: string; type: string; status?: string }>,
): MeResponse {
  return {
    memberships: memberships.map(({ orgId, type, status }) => ({
      organizationId: orgId,
      role: "owner",
      status: status ?? "active",
      organization: { id: orgId, name: orgId, type },
    })),
  };
}

describe("provider portal routing decision", () => {
  it("keeps lab users on the lab shell without waiting for memberships", async () => {
    // A lab user must not gain a loading gate they don't have today: the
    // decision resolves before /api/auth/me has answered.
    expect(decideProviderPortal("lab", undefined, "pending")).toBe("lab");
    expect(decideProviderPortal("lab", me([{ orgId: "lab-1", type: "lab" }]), "success")).toBe("lab");
  });

  it("routes a provider account with no lab membership into the portal", async () => {
    expect(
      decideProviderPortal("provider", me([{ orgId: "prac-1", type: "practice" }]), "success"),
    ).toBe("provider");
    expect(decideProviderPortal("provider", me([]), "success")).toBe("provider");
  });

  it("keeps a user who holds both a lab and a provider membership on the lab shell", async () => {
    const dual = me([
      { orgId: "prac-1", type: "practice" },
      { orgId: "lab-1", type: "lab" },
    ]);
    expect(decideProviderPortal("provider", dual, "success")).toBe("lab");
  });

  it("waits for memberships before routing a provider account", async () => {
    expect(decideProviderPortal("provider", undefined, "pending")).toBe("pending");
  });

  it("falls back to the portal when memberships cannot be loaded", async () => {
    // The server already classified the account as a provider, matching the
    // desktop gate — a failed membership read must not strand them in the lab
    // shell they have no memberships for.
    expect(decideProviderPortal("provider", undefined, "error")).toBe("provider");
  });

  it("ignores inactive lab memberships", async () => {
    const revoked = me([
      { orgId: "prac-1", type: "practice" },
      { orgId: "lab-1", type: "lab", status: "revoked" },
    ]);
    expect(hasActiveLabMembership(revoked)).toBe(false);
    expect(decideProviderPortal("provider", revoked, "success")).toBe("provider");
  });
});

describe("provider notification deep links", () => {
  it("sends payment notifications to the billing section", async () => {
    for (const type of [
      "lab_payment_recorded",
      "payment_reversed",
      "provider_payment_received",
    ]) {
      expect(notificationTarget({ type, dataJson: null })).toEqual({
        section: "billing",
      });
    }
  });

  it("opens the Dashboard on the shared case for note and attachment alerts", async () => {
    for (const type of ["shared_note", "shared_note_added", "shared_attachment_added"]) {
      expect(notificationTarget({ type, dataJson: { caseId: "case-9" } })).toEqual({
        section: "dashboard",
        caseId: "case-9",
      });
    }
  });

  it("does not navigate when a shared-item alert carries no case", async () => {
    expect(notificationTarget({ type: "shared_note", dataJson: null })).toBeNull();
    expect(notificationTarget({ type: "shared_note", dataJson: { caseId: "" } })).toBeNull();
    expect(notificationTarget({ type: "some_other_alert", dataJson: null })).toBeNull();
  });
});
