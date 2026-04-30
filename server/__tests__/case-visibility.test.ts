import { describe, it, expect } from "vitest";
import {
  isCaseVisibleToUser,
  resolveOrganizationIdForWrite,
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

describe("resolveOrganizationIdForWrite", () => {
  it("returns null for nullish or non-string input", () => {
    expect(resolveOrganizationIdForWrite(null, new Set([LAB_1]))).toBeNull();
    expect(resolveOrganizationIdForWrite(undefined, new Set([LAB_1]))).toBeNull();
  });

  it("returns null for keys without org: prefix", () => {
    expect(resolveOrganizationIdForWrite("private", new Set([LAB_1]))).toBeNull();
    expect(resolveOrganizationIdForWrite("lab:Acme", new Set([LAB_1]))).toBeNull();
  });

  it("returns null when key is empty after prefix", () => {
    expect(resolveOrganizationIdForWrite("org:", new Set([LAB_1]))).toBeNull();
    expect(resolveOrganizationIdForWrite("org:   ", new Set([LAB_1]))).toBeNull();
  });

  it("returns the org id when the user is a member", () => {
    expect(resolveOrganizationIdForWrite(`org:${LAB_1}`, new Set([LAB_1]))).toBe(LAB_1);
  });

  it("rejects org tags the user does not belong to (cross-lab leak protection)", () => {
    expect(
      resolveOrganizationIdForWrite(`org:${LAB_2}`, new Set([LAB_1]))
    ).toBeNull();
  });

  it("trims whitespace around the affiliation key", () => {
    expect(
      resolveOrganizationIdForWrite(`  org:${LAB_1}  `, new Set([LAB_1]))
    ).toBe(LAB_1);
  });
});
