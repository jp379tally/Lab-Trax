import { describe, it, expect } from "vitest";
import {
  isCaseVisibleToUser,
  parseOrganizationIdFromAffiliationKey,
} from "../lib/case-visibility";

const USER_A = "user-a";
const USER_B = "user-b";
const LAB_1 = "lab-1";
const LAB_2 = "lab-2";

describe("isCaseVisibleToUser", () => {
  it("hides soft-deleted cases", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: null, deletedAt: new Date() },
        USER_A,
        new Set([LAB_1])
      )
    ).toBe(false);
  });

  it("shows private case to its owner", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: null },
        USER_A,
        new Set()
      )
    ).toBe(true);
  });

  it("hides private case from other users even if they share a lab", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: null },
        USER_B,
        new Set([LAB_1])
      )
    ).toBe(false);
  });

  it("shows lab case to every member of that lab", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: LAB_1 },
        USER_B,
        new Set([LAB_1])
      )
    ).toBe(true);
  });

  it("shows lab case to a lab member even when the case owner is not a member", () => {
    // The case is the lab's data once tagged. Every active member of
    // that lab sees it, regardless of who originally scanned it. (The
    // owner-may-not-be-a-member situation arises from legacy data
    // restored by the startup backfill.)
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: LAB_1 },
        USER_B,
        new Set([LAB_1])
      )
    ).toBe(true);
  });

  it("hides lab case from non-members", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: LAB_1 },
        USER_B,
        new Set([LAB_2])
      )
    ).toBe(false);
  });

  it("hides lab case from a user with no labs", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: LAB_1 },
        USER_B,
        new Set()
      )
    ).toBe(false);
  });

  it("shows lab case to its owner when they belong to the lab", () => {
    expect(
      isCaseVisibleToUser(
        { ownerId: USER_A, organizationId: LAB_1 },
        USER_A,
        new Set([LAB_1])
      )
    ).toBe(true);
  });
});

describe("parseOrganizationIdFromAffiliationKey", () => {
  it("returns null for nullish or non-string input", () => {
    expect(parseOrganizationIdFromAffiliationKey(null)).toBeNull();
    expect(parseOrganizationIdFromAffiliationKey(undefined)).toBeNull();
  });

  it("returns null for keys without org: prefix", () => {
    expect(parseOrganizationIdFromAffiliationKey("private")).toBeNull();
    expect(parseOrganizationIdFromAffiliationKey("lab:Acme")).toBeNull();
  });

  it("returns null when key is empty after prefix", () => {
    expect(parseOrganizationIdFromAffiliationKey("org:")).toBeNull();
    expect(parseOrganizationIdFromAffiliationKey("org:   ")).toBeNull();
  });

  it("returns the org id for a well-formed key", () => {
    expect(parseOrganizationIdFromAffiliationKey(`org:${LAB_1}`)).toBe(LAB_1);
  });

  it("returns the org id regardless of caller (parser is pure)", () => {
    // The parser only extracts the candidate org id from the JSON key;
    // it knows nothing about membership. The route layer is responsible
    // for enforcing "only active members of a lab may put cases there"
    // before the candidate is persisted to organization_id.
    expect(parseOrganizationIdFromAffiliationKey(`org:${LAB_2}`)).toBe(LAB_2);
  });

  it("trims whitespace around the affiliation key", () => {
    expect(parseOrganizationIdFromAffiliationKey(`  org:${LAB_1}  `)).toBe(LAB_1);
  });
});
