/**
 * Contract scaffold for the Account epic (Phase 1).
 *
 * These tests validate that the OpenAPI-generated Zod schemas (the source of
 * truth for the auth / organization / invitation / membership / audit
 * contracts) parse representative payloads and reject malformed ones. They run
 * WITHOUT a database — they exercise the generated contract, not the live
 * routes — so they guard against accidental contract drift when the spec is
 * regenerated. Phase 2 adds DB-backed behavioural tests for the same routes.
 */
import { describe, expect, it } from "vitest";
import {
  RegisterUserBody,
  LoginUserBody,
  RefreshSessionBody,
  GetCurrentUserResponse,
  ListSessionsResponse,
  VerifyEmailCodeBody,
  VerifyEmailCodeResponse,
  VerifyPhoneCodeBody,
  CreateOrganizationBody,
  CreateInvitationBody,
  UpdateMembershipBody,
  UpdateMembershipResponse,
  ListAuditLogsQueryParams,
  ListAuditLogsResponse,
} from "@workspace/api-zod";

describe("Account epic — auth contract", () => {
  it("accepts a minimal registration payload", () => {
    expect(() =>
      RegisterUserBody.parse({ username: "drsmith", password: "hunter2!" })
    ).not.toThrow();
  });

  it("accepts a full registration payload with org creation", () => {
    const parsed = RegisterUserBody.parse({
      username: "drsmith",
      password: "hunter2!",
      email: "dr@example.com",
      phone: "5551234567",
      firstName: "Jane",
      lastName: "Smith",
      userType: "lab",
      practiceName: "Smith Dental",
      createOrganization: true,
      clientType: "web",
      wantsUpdates: false,
    });
    expect(parsed.username).toBe("drsmith");
  });

  it("rejects registration without a password", () => {
    expect(() => RegisterUserBody.parse({ username: "drsmith" })).toThrow();
  });

  it("rejects an invalid userType", () => {
    expect(() =>
      RegisterUserBody.parse({
        username: "drsmith",
        password: "hunter2!",
        userType: "superadmin",
      })
    ).toThrow();
  });

  it("accepts login by username or identifier", () => {
    expect(() =>
      LoginUserBody.parse({ username: "drsmith", password: "hunter2!" })
    ).not.toThrow();
    expect(() =>
      LoginUserBody.parse({ identifier: "L-2026-3-5551234567", password: "x" })
    ).not.toThrow();
  });

  it("rejects login without a password", () => {
    expect(() => LoginUserBody.parse({ identifier: "drsmith" })).toThrow();
  });

  it("allows an empty refresh body (cookie clients)", () => {
    expect(() => RefreshSessionBody.parse({})).not.toThrow();
  });

  it("parses a current-user response with memberships", () => {
    expect(() =>
      GetCurrentUserResponse.parse({
        success: true,
        user: { id: "u1", username: "drsmith" },
        memberships: [
          { id: "m1", role: "owner", status: "active", organizationId: "o1", organization: null },
        ],
      })
    ).not.toThrow();
  });

  it("parses a session-list response", () => {
    expect(() =>
      ListSessionsResponse.parse({
        success: true,
        sessions: [
          {
            id: "s1",
            deviceName: "Chrome",
            ipAddress: "1.2.3.4",
            userAgent: "ua",
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
            current: true,
            isSuspicious: false,
          },
        ],
      })
    ).not.toThrow();
  });
});

describe("Account epic — verification contract", () => {
  it("requires email + code to verify email", () => {
    expect(() =>
      VerifyEmailCodeBody.parse({ email: "dr@example.com", code: "123456" })
    ).not.toThrow();
    expect(() => VerifyEmailCodeBody.parse({ email: "dr@example.com" })).toThrow();
  });

  it("requires phone + code to verify phone", () => {
    expect(() =>
      VerifyPhoneCodeBody.parse({ phone: "5551234567", code: "123456" })
    ).not.toThrow();
    expect(() => VerifyPhoneCodeBody.parse({ code: "123456" })).toThrow();
  });

  it("parses a verification result", () => {
    expect(() =>
      VerifyEmailCodeResponse.parse({ success: true, verified: true })
    ).not.toThrow();
  });
});

describe("Account epic — organization & membership contract", () => {
  it("requires type + name to create an organization", () => {
    expect(() =>
      CreateOrganizationBody.parse({ type: "lab", name: "Acme Lab" })
    ).not.toThrow();
    expect(() => CreateOrganizationBody.parse({ name: "Acme Lab" })).toThrow();
  });

  it("rejects an invalid organization type", () => {
    expect(() =>
      CreateOrganizationBody.parse({ type: "clinic", name: "Acme" })
    ).toThrow();
  });

  it("requires email + roleToAssign to create an invitation", () => {
    expect(() =>
      CreateInvitationBody.parse({ email: "dr@example.com", roleToAssign: "user" })
    ).not.toThrow();
    expect(() =>
      CreateInvitationBody.parse({ email: "dr@example.com" })
    ).toThrow();
  });

  it("rejects an invitation role outside the role enum", () => {
    expect(() =>
      CreateInvitationBody.parse({ email: "dr@example.com", roleToAssign: "superuser" })
    ).toThrow();
  });

  it("accepts a partial membership update and its response", () => {
    expect(() => UpdateMembershipBody.parse({ role: "admin" })).not.toThrow();
    expect(() => UpdateMembershipBody.parse({ status: "suspended" })).not.toThrow();
    expect(() => UpdateMembershipBody.parse({})).not.toThrow();
    expect(() =>
      UpdateMembershipResponse.parse({ ok: true, data: { id: "m1", role: "admin" } })
    ).not.toThrow();
  });

  it("rejects an out-of-enum membership role", () => {
    expect(() => UpdateMembershipBody.parse({ role: "god" })).toThrow();
  });
});

describe("Account epic — audit-log contract", () => {
  it("accepts organizationId in the query and bounds the limit", () => {
    expect(() =>
      ListAuditLogsQueryParams.parse({ organizationId: "o1" })
    ).not.toThrow();
    expect(() =>
      ListAuditLogsQueryParams.parse({ organizationId: "o1", limit: 50 })
    ).not.toThrow();
    // Limit is bounded server-side at 200 — anything larger is rejected.
    expect(() =>
      ListAuditLogsQueryParams.parse({ organizationId: "o1", limit: 5000 })
    ).toThrow();
    expect(() =>
      ListAuditLogsQueryParams.parse({ organizationId: "o1", limit: 0 })
    ).toThrow();
  });

  it("parses an audit-log list response", () => {
    expect(() =>
      ListAuditLogsResponse.parse({
        ok: true,
        data: [
          {
            id: "a1",
            userId: "u1",
            organizationId: "o1",
            action: "membership_updated",
            entityType: "organization_membership",
            entityId: "m1",
            ipAddress: "1.2.3.4",
            userAgent: "ua",
            beforeJson: { role: "user" },
            afterJson: { role: "admin" },
            metadataJson: {},
            createdAt: new Date().toISOString(),
          },
        ],
      })
    ).not.toThrow();
  });
});
