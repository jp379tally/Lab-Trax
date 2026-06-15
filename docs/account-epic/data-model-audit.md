# Account Epic — Phase 1: Data-Model Audit

> Source of truth for schema: `lib/db/src/schema/schema.ts`. This document maps
> the *existing* auth / org / invite / account-number schema to the Account
> epic's requirements (signup, enforced verification, lab creation, invitations,
> provider portal) and records the column/table **deltas** Phase 2+ must add.
> No schema is changed in Phase 1 — this is design only.

## 1. Existing tables (relevant subset)

### `users` (`schema.ts` ~24–81)
| Column | Type | Notes |
|---|---|---|
| `id` | varchar PK | `gen_random_uuid()` |
| `username` | text NOT NULL, unique | login identifier |
| `password` | text NOT NULL | bcrypt (`$2…`); legacy plaintext upgraded on login |
| `email` | text | nullable; uniqueness enforced **in app code only**, not by a DB constraint |
| `phone` | text | nullable; free-form, not normalized at rest |
| `firstName`, `lastName`, `initials` | text | |
| `userType` | text default `"lab"` | `"lab"` \| `"provider"` (intent marker) |
| `role` | text default `"user"` | **global** role; only `"admin"` is privileged (platform). Org rights live in memberships, not here. |
| `isActive` | boolean NOT NULL default true | soft on/off switch; `requireAuth` rejects inactive |
| `licenseNumber`, `practiceName`, `doctorName`, `practiceAddress`, `practicePhone`, `phoneContactName` | text | provider/practice profile fields captured at signup |
| `accountNumber` | text | legacy free-form, lab-scoped |
| `platformAccountNumber` | text | platform-wide `<seq><YY><F><L>` (Task #320), unique index |
| `wantsUpdates` | boolean default false | marketing opt-in |
| `lastLoginAt` | timestamptz | |
| `workStatus` | text default `"available"` | |
| `emailPreferences`, `smsPreferences` | jsonb | notification toggles |
| `twoFactorSecret` | text | AES-256-GCM encrypted TOTP secret |
| `twoFactorEnabled` | boolean NOT NULL default false | TOTP enrolled |
| `twoFactorBackupCodes` | jsonb | bcrypt-hashed one-time codes |
| `profilePhotoUrl` | text | |
| `createdAt` | timestamp | |
| `deletedAt`, `deletedByUserId` | timestamptz / varchar | soft-delete (protected table) |

**Gap:** there is **no durable email/phone verification state**. Verification is
ephemeral only (see `verificationCodes` in §2). There are no `emailVerifiedAt` /
`phoneVerifiedAt` columns, and no per-channel 2FA selection (TOTP is the only
second factor; email/SMS codes are signup-time only and not a login 2nd factor).

### `organizations` (~170–283)
Lab and provider orgs share one table, discriminated by `type` (`"lab"` |
`"provider"`). Relevant columns: `id`, `type`, `name`, `displayName`, contact &
address fields, `isActive`, `parentLabOrganizationId` (provider → creating lab),
`accountNumber` (lab-scoped, unique within parent lab), `platformAccountNumber`
(platform-wide, Task #320), `createdByUserId`, `trustedDeviceTtlDays`,
`defaultCaseDueDays`, `deletedAt`/`deletedByUserId` (protected table).

### `lab_memberships` → exported as `organizationMemberships` (~387–423)
Join row binding a user to an org. `labId` (the org id — **column is `lab_id`,
not `organization_id`**), `userId`, `role` (`owner|admin|user|billing|read_only`),
`status` (`active|pending|invited|suspended`), `invitedByUserId`,
`approvedByUserId`, `joinedAt`, soft-delete columns. Unique on `(labId, userId)`
(relied on by invite-accept `onConflictDoUpdate`).

### `lab_invites` → `organizationInvites` (~455–485)
Tokenized email invites: `labId`, `email`, `phone`, `roleToAssign`, `token`
(unique), `status` (`pending|accepted|declined|revoked`), `invitedByUserId`,
`expiresAt`, `acceptedByUserId`, `acceptedAt`.

### `join_requests` → `organizationJoinRequests` (~425–453)
User-initiated requests to join an org (the inverse of an invite): `labId`,
`userId`, `requestedRole`, `message`, `status`, `reviewedByUserId`, `reviewedAt`.

### `account_link_invites` (~350–385) & `doctor_account_links` (~316–342)
Cross-lab provider identity linking. `account_link_invites` tracks the Twilio
SMS "is this you?" invite (`newUserId`, `existingUserId`, `matchedOn`,
`sentToPhone`, Twilio SID/error fields, `status`). `doctor_account_links` is the
confirmed symmetric pair (`userIdLow`/`userIdHigh` normalized ordering,
`linkedVia` = `sms_yes|manual`).

### `platform_account_sequences` (~291–305)
Per-`(year, entityType)` counter: `year`, `entityType` (`"user"|"org"`),
`nextSeq` default 1, `updatedAt`. Allocated via `SELECT … FOR UPDATE` in
`lib/platform-account-number.ts`.

### `user_sessions` (~1166–1188) & `trusted_devices` (~1960–1981)
Server-side refresh-token sessions (`tokenHash`, `expiresAt`, `revokedAt`,
device/IP/UA) and 2FA "remember this device" tokens (hashed, TTL'd).

### `audit_logs` (~1138–1164)
`userId`, `organizationId`, `action`, `entityType`, `entityId`, `ipAddress`,
`userAgent`, `beforeJson`, `afterJson`, `metadataJson`, `createdAt` (indexed).
Written via `lib/audit.ts#writeAuditLog` (best-effort; swallows errors). **No
read endpoint exists yet** — Phase 1 adds the contract for one.

## 2. Ephemeral verification (today)

`send-email-code` / `verify-email-code` / `send-phone-code` /
`verify-phone-code` live in `labtrax-routes.ts` (~3286–3403). They store codes
in an **in-process `Map` (`verificationCodes`)** keyed by `email:<addr>` /
`phone:<num>`, 10-minute TTL. Implications:
- State is lost on restart and **not shared across instances** — unusable as a
  durable "is this email verified?" signal and not safe for a multi-instance
  Reserved VM if it ever scales out.
- `verify-*-code` returns `{verified:true}` but **persists nothing** — no row,
  no `users` column update. There is currently no way to ask "has this user
  verified their email/phone?" after the fact.
- The codes gate signup UX only; they are **not** a login second factor.

## 3. Mapping epic requirements → schema

| Epic requirement | Covered by today | Delta needed (Phase 2+) |
|---|---|---|
| User signup | `users` + `/auth/register` | Add durable verification columns (below); decouple practice fields if needed |
| **Enforced** email/phone verification | ephemeral codes only | `users.emailVerifiedAt`, `users.phoneVerifiedAt` (timestamptz, nullable) + a durable `verification_codes` (or `verification_tokens`) table; enforcement in `requireAuth`/route guards |
| Email / SMS 2FA at login | TOTP only (`two-factor.ts`) | `users.twoFactorChannel` (`totp|email|sms`) + per-channel challenge issuance; reuse `userSessions`/pending-token flow |
| Lab creation | `organizations` (`type=lab`) + register/`POST /organizations` | none structural; new account-number format (separate doc) |
| Provider org creation | `organizations` (`type=provider`, `parentLabOrganizationId`) | none structural |
| Invitations (send/accept/deny/revoke) | `lab_invites` + routes | none structural; ensure invite emails carry **no PHI** |
| Join requests | `join_requests` + routes | none structural |
| List my orgs | `GET /auth/me` memberships | none |
| Role update | `PATCH /memberships/:id` (role ceiling) | none |
| Provider case visibility / isolation | membership + `parentLabOrganizationId`; `listCases` provider aggregation | none structural; document isolation invariants (security note) |
| Cross-lab linking | `account_link_invites`, `doctor_account_links` | new account-number format changes the matched value (see format doc) |
| Audit logging | `audit_logs` + `writeAuditLog` | **add read contract** `GET /audit-logs` (org-scoped, admin) |
| Account deactivation / deletion | `users.isActive`, soft-delete columns | document semantics; no new columns |

## 4. Recommended new columns/tables (design — implemented in Phase 2)

1. **`users.emailVerifiedAt timestamptz NULL`**, **`users.phoneVerifiedAt timestamptz NULL`**
   — durable, queryable verification state. Set by `verify-*-code` once the code
   matches the signed-in (or just-registered) user's contact value.
2. **`users.twoFactorChannel text NULL`** — `totp|email|sms`; null = TOTP
   (back-compat). Selects which 2nd factor the login challenge issues.
3. **`verification_codes` table** (durable replacement for the in-memory Map):
   `id`, `userId` (nullable for pre-account signup), `channel` (`email|sms`),
   `target` (normalized email / E.164 phone), `codeHash` (never store plaintext),
   `expiresAt`, `consumedAt`, `attemptCount`, `createdAt`. Enables rate limiting,
   multi-instance correctness, and an audit trail.
4. **No new invite table** — `lab_invites` already suffices; just enforce the
   no-PHI rule on invite email bodies.

All new `users` columns are nullable / additive, so the migration is a pure
`ADD COLUMN` with no backfill required (unverified = NULL).
