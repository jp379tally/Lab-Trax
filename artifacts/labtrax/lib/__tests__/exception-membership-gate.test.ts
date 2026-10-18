import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isActiveMemberOfOrg, canEditOrg } from "../auth-me";

/**
 * The exception workflow is open to EVERY active internal lab member on the
 * server — flagging and reviewing are not edit-role gated, only resolution is
 * (owner/admin). Mobile previously gated the case-detail action and the queue
 * query on `canEdit`, which silently excluded active `user` and `read_only`
 * members from a feature the API would have accepted.
 */
describe("Mobile exception gating — active membership, not edit capability", () => {
  function me(role: string, status = "active") {
    return {
      memberships: [
        {
          organizationId: "lab_1",
          status,
          role,
          organization: { type: "lab" },
        },
      ],
    } as any;
  }

  it.each(["user", "read_only"])(
    "treats an active %s member of the lab as a lab member even though they cannot edit",
    (role) => {
      expect(isActiveMemberOfOrg(me(role), "lab_1")).toBe(true);
      // The distinction is the whole point of the helper: these roles fail the
      // edit gate that used to guard the exception UI.
      expect(canEditOrg(me(role), "lab_1")).toBe(false);
    },
  );

  it.each(["owner", "admin", "billing"])(
    "still treats an active %s member as a lab member",
    (role) => {
      expect(isActiveMemberOfOrg(me(role), "lab_1")).toBe(true);
    },
  );

  it("rejects an inactive membership, a different lab, and a missing org id", async () => {
    expect(isActiveMemberOfOrg(me("owner", "invited"), "lab_1")).toBe(false);
    expect(isActiveMemberOfOrg(me("owner"), "lab_2")).toBe(false);
    expect(isActiveMemberOfOrg(me("owner"), null)).toBe(false);
    expect(isActiveMemberOfOrg(undefined, "lab_1")).toBe(false);
  });

  it("wires the case-detail exception action and queue to membership, not canEdit", async () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "app", "case", "[id].tsx"),
      "utf8",
    );
    expect(source).toContain("isActiveMemberOfOrg(meQuery.data, labOrganizationId)");
    expect(source).toContain("{isLabMember ? (");
    // The queue query must follow the same gate, or a non-editing member sees
    // the action but never learns the case is already flagged.
    const queryIndex = source.indexOf("EXCEPTION_QUEUE_QUERY_KEY");
    const enabledIndex = source.indexOf("enabled: isLabMember", queryIndex);
    expect(queryIndex).toBeGreaterThan(-1);
    expect(enabledIndex).toBeGreaterThan(queryIndex);
  });
});
