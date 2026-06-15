# Account Epic — Phase 1: Security Design Note (HIPAA-conscious)

> Scope: the account / signup / lab-creation / invitation / provider-portal
> epic. This note records the security guarantees the backend must uphold. It
> complements the repo-wide `threat_model.md`; where they overlap, the threat
> model is authoritative for the existing API.

## 0. Two non-negotiable PHI rules

1. **No PHI in invitation or signup emails/SMS.** Invite and verification
   messages may contain only: the organization's display name, the assigned
   role, the inviter's name, an opaque token/link, and an expiry. They must
   **never** contain patient names, case data, attachments, or any clinical
   identifier.
2. **No lab case data before verification.** A freshly registered, unverified
   user must not be able to read any case, attachment, invoice, or other PHI.
   Verification (email and/or phone) and an active org membership are
   preconditions for PHI access. Pre-verification, the API surface is limited to
   account/verification/org-join management.

## 1. Signup flow

- `POST /auth/register` creates a user with the **base `user` role only**. The
  global `users.role` is never elevated from a public endpoint; org rights come
  exclusively from `organizationMemberships.role` (`owner`/`admin`/…).
- Client-supplied `accountNumber` / `platformAccountNumber` are inputs to
  display fields only and never grant privilege. The platform account number is
  allocated server-side.
- Registration is rate-limited (`registerRateLimit`). Username uniqueness is a DB
  constraint; email uniqueness is enforced in app logic (Phase 2 should add a
  case-insensitive unique index to remove the race window).
- A half-created account must not be left behind on a failed join/claim lookup —
  the join target is resolved *before* the user row is inserted.

## 2. Password storage

- bcrypt via `lib/crypto#hashPassword`. Legacy plaintext rows are transparently
  re-hashed on the next successful login (`auth.ts` ~611–621). Never log or
  return password material. Phase 2 may add a minimum-strength policy at the
  Zod layer.

## 3. Email verification

- Codes are random numeric, single-use, 10-minute TTL. **Codes are hashed at
  rest** in the Phase 2 durable `verification_codes` table (today's in-memory
  Map stores plaintext, which Phase 2 replaces). Plaintext codes are returned in
  responses **only** in development when the SMTP/Twilio provider is unconfigured
  (`demoCode`), never in production.
- `verify-email-code` must, in Phase 2, persist `users.emailVerifiedAt` so the
  signal is durable and queryable. Verification is bound to the contact value of
  the requesting/just-registered account, not an arbitrary email.

## 4. SMS / phone (and email) 2FA

- Login second factor today is TOTP (`two-factor.ts`): AES-256-GCM-encrypted
  secret, bcrypt-hashed backup codes, pending-token two-step challenge,
  optional TTL'd trusted-device skip. Disabling 2FA revokes all trusted devices.
- Phase 2 adds email/SMS as alternative second factors via
  `users.twoFactorChannel`. They reuse the existing pending-token challenge:
  login returns `{requiresTwoFactor, pendingToken}`, the code is delivered out
  of band, and `/auth/2fa/challenge` (or a channel-specific verify) completes the
  session. SMS/email codes used as a 2nd factor must be hashed, single-use,
  short-TTL, and rate-limited per account to prevent flooding/toll fraud (DoS).

## 5. Session handling

- Refresh tokens are server-side sessions (`user_sessions`): stored as a hash,
  with expiry and `revokedAt`. Refresh **rotates** the token and runs
  **reuse detection** — a replayed/old refresh token revokes that session chain
  and notifies the user (`security_session_revoked`). Access tokens are short
  JWTs validated against a live, non-revoked session on every request
  (`requireAuth`).
- Web clients use httpOnly SameSite=Lax+Secure cookies; mobile/desktop use bearer
  tokens. Bearer clients must **never** receive `Set-Cookie` (avoids the RN
  cookie-jar CSRF trap). CSRF uses double-submit token for cookie clients;
  bearer requests are CSRF-exempt by design.

## 6. Invitation token security

- Invite tokens are opaque, unguessable, single-row, with `expiresAt` and a
  `status` lifecycle (`pending→accepted|declined|revoked`). Accept requires the
  **authenticated user's email to match the invite email** — possession of the
  link alone is insufficient (`organizations.ts` ~1696). Admin-only creation /
  cancellation (`ADMIN_ROLES`). Invite emails carry no PHI (§0).
- A pending invite per `(org,email)` is deduped (409) to limit spam.

## 7. Audit logging

- All security-relevant mutations write `audit_logs` via `writeAuditLog`:
  registration, login success/failure, logout, refresh-reuse detection, 2FA
  enable/disable/backup-code-use, invite create/accept/decline/cancel, membership
  role change, org create/archive. Logging is best-effort and must never block
  the user action, but failures are recorded to the app log.
- Phase 1 adds a **read** contract: `GET /audit-logs` (org-scoped, admin-only)
  so admins can review activity. Reads must be tenant-scoped — an admin only
  sees their org's entries.

## 8. Role / permission enforcement (RBAC)

- Org roles: `owner > admin > billing > user > read_only` (`lib/rbac.ts`).
  Every org-scoped write calls `requireMembership` / `requireAnyRole`.
- **Role ceiling:** a caller cannot assign a role above their own
  (`PATCH /memberships/:id`, `organizations.ts` ~2241). Roles are never trusted
  from registration/profile input.

## 9. Provider data isolation

- Tenancy boundary is `organizationMemberships`. A provider sees only cases of
  orgs they actively belong to, plus cross-lab linked-doctor cases resolved
  through `doctor_account_links` / `getProviderOrgIdsForUserAndLinks`. Legacy
  routes gate on `fetchUserActiveLabIds`.
- Provider orgs are scoped to a `parentLabOrganizationId`; account-number
  uniqueness is per parent lab. Cross-lab links must be explicit and consented
  (SMS YES-reply or manual linking) — they never auto-merge accounts.
- A lab admin's read access to a provider org derives from active membership of
  the **parent lab** (`resolveOrgReadAccess`), not from arbitrary org ids.

## 10. Account deactivation / deletion

- **Deactivation:** `users.isActive=false` — `requireAuth` rejects the user and
  existing sessions stop working. Reversible.
- **Deletion:** `users` and `organizations` are **protected tables**
  (`threat_model.md` §Destructive Data Loss) — only soft-delete via
  `softDelete()` (sets `deletedAt`/`deletedByUserId` + audit), never
  `db.delete(...)`. Reads filter with `notDeleted(table)`. Hard deletion of
  these tables is blocked by the CI lint guard.

## 11. PHI exposure risk summary

| Surface | Risk | Control |
|---|---|---|
| Invite / verification messages | PHI leak to wrong/unverified recipient | §0 rule 1 — no PHI in messages, opaque tokens, expiry |
| Pre-verification API access | unverified user reads cases | §0 rule 2 — verification + membership gate on PHI routes |
| Cross-tenant reads | provider sees another lab's cases | §9 membership/link scoping on every read |
| Verification code interception | account takeover | hashed, single-use, short-TTL, rate-limited codes |
| Refresh-token leak | persistent access | rotation + reuse detection + revoke chain + user alert |
| Audit-log read | one admin sees another org's activity | org-scoped, admin-only `GET /audit-logs` |
| Account number as identifier | enumeration / probing | server-only allocation; generic 404 on claim lookups |
