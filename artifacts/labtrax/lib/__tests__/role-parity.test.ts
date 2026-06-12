import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Source-parity guard: the mobile client gates Lists/Reports (and the other
// edit-only surfaces) on EDIT_ROLES, which must mirror the desktop `billingOnly`
// predicate — desktop's BILLING_ROLES set. If desktop adds or removes a role
// from billing access, this test fails so the mobile gate stays in sync.
// We read both sources as text (the spec forbids importing/editing desktop).

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP_APPLAYOUT = resolve(
  here,
  "../../../labtrax-desktop/src/components/AppLayout.tsx",
);
const MOBILE_AUTH_ME = resolve(here, "../auth-me.ts");
const SERVER_RBAC = resolve(
  here,
  "../../../api-server/src/lib/rbac.ts",
);

// Extract the quoted string members of the first `[ ... ]` literal after a
// marker, returned sorted for order-insensitive comparison.
function parseStringList(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  // Search for the array literal AFTER the marker text so a `Type[]` annotation
  // inside the marker (e.g. `MembershipRole[]`) isn't mistaken for the array.
  const open = source.indexOf("[", start + marker.length);
  const close = source.indexOf("]", open);
  const body = source.slice(open, close);
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out.sort();
}

describe("role parity: mobile edit gate mirrors desktop billing gate", () => {
  it("mobile EDIT_ROLES equals desktop BILLING_ROLES (the billingOnly predicate)", () => {
    const desktop = readFileSync(DESKTOP_APPLAYOUT, "utf8");
    const mobile = readFileSync(MOBILE_AUTH_ME, "utf8");

    const desktopRoles = parseStringList(desktop, "BILLING_ROLES = new Set(");
    const mobileRoles = parseStringList(mobile, "EDIT_ROLES =");

    expect(mobileRoles).toEqual(["admin", "billing", "owner"]);
    expect(mobileRoles).toEqual(desktopRoles);
  });

  // Pricing tiers/overrides, the billed report, and item-label writes are
  // gated on the server's ADMIN_ROLES (owner/admin) — stricter than billing.
  // The mobile screens gate their admin affordances on ADMIN_ROLES in
  // auth-me.ts, which must mirror the server. The server rbac is the actual
  // enforcement boundary, so anchor parity there.
  it("mobile ADMIN_ROLES equals server rbac ADMIN_ROLES", () => {
    const mobile = readFileSync(MOBILE_AUTH_ME, "utf8");
    const server = readFileSync(SERVER_RBAC, "utf8");

    const mobileAdmin = parseStringList(mobile, "ADMIN_ROLES =");
    const serverAdmin = parseStringList(server, "ADMIN_ROLES: MembershipRole[] =");

    expect(mobileAdmin).toEqual(["admin", "owner"]);
    expect(mobileAdmin).toEqual(serverAdmin);
  });

  it("mobile EDIT_ROLES equals server rbac BILLING_ROLES", () => {
    const mobile = readFileSync(MOBILE_AUTH_ME, "utf8");
    const server = readFileSync(SERVER_RBAC, "utf8");

    const mobileEdit = parseStringList(mobile, "EDIT_ROLES =");
    const serverBilling = parseStringList(server, "BILLING_ROLES: MembershipRole[] =");

    expect(mobileEdit).toEqual(["admin", "billing", "owner"]);
    expect(mobileEdit).toEqual(serverBilling);
  });
});
