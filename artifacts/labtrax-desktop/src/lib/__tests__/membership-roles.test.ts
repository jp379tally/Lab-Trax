import { describe, expect, it } from "vitest";
import { headerRoleLabel, LAB_ADMIN_ROLES, LAB_BILLING_ROLES, membershipRoleLabel } from "@/lib/membership-roles";

describe("membership role labels", () => {
  it("names all five lab roles as Team settings does", () => {
    expect(membershipRoleLabel("owner")).toBe("Owner");
    expect(membershipRoleLabel("admin")).toBe("Admin");
    expect(membershipRoleLabel("billing")).toBe("Billing");
    expect(membershipRoleLabel("user")).toBe("User");
    expect(membershipRoleLabel("read_only")).toBe("Read Only");
    expect(membershipRoleLabel("superuser")).toBeNull();
    expect(membershipRoleLabel(null)).toBeNull();
  });

  it("shows the real membership role in the app header", () => {
    // The session role collapses every non-admin membership to "user", so the
    // header must read the membership role.
    expect(headerRoleLabel({ membershipRole: "owner", role: "admin" })).toBe("Owner");
    expect(headerRoleLabel({ membershipRole: "admin", role: "admin" })).toBe("Admin");
    expect(headerRoleLabel({ membershipRole: "billing", role: "user" })).toBe("Billing");
    expect(headerRoleLabel({ membershipRole: "user", role: "user" })).toBe("User");
    expect(headerRoleLabel({ membershipRole: "read_only", role: "user" })).toBe("Read Only");
  });

  it("falls back to the session role, then Member", () => {
    expect(headerRoleLabel({ membershipRole: null, role: "admin" })).toBe("Admin");
    expect(headerRoleLabel({ role: "user" })).toBe("User");
    expect(headerRoleLabel({ membershipRole: "superuser", role: "user" })).toBe("User");
    expect(headerRoleLabel({ role: "provider" })).toBe("Member");
    expect(headerRoleLabel(null)).toBe("Member");
  });

  it("matches the server's role sets: owners and admins receive and deposit, billing also reads aging", () => {
    expect([...LAB_ADMIN_ROLES].sort()).toEqual(["admin", "owner"]);
    expect([...LAB_BILLING_ROLES].sort()).toEqual(["admin", "billing", "owner"]);
  });
});
