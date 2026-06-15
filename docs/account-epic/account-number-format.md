# Account Epic — Phase 1: Account-Number Format Design

> **Design only.** Phase 1 specifies the new format; implementation (changing
> `lib/platform-account-number.ts`, migrating existing numbers, and wiring
> login/cross-lab lookups) is Phase 2. The current format
> (`<seq><YY><F><L>`, e.g. `2926JW`) stays live until Phase 2 cuts over.

## 1. New format

```
<TYPE>-<YEAR>-<SEQUENCE>-<PHONE>
```

Example: `L-2026-3-5551234567`  (3rd lab created in 2026, phone 555-123-4567).

| Field | Rule |
|---|---|
| `<TYPE>` | `L` for lab org / lab user, `P` for provider org / provider user. Single uppercase letter. Derived from `entityType`/`userType`, never client-chosen for privilege. |
| `<YEAR>` | Four-digit allocation year (UTC), e.g. `2026`. Replaces the old two-digit `YY`. |
| `<SEQUENCE>` | Per-`(year, type)` incrementing integer, **no padding**, starts at 1. Allocated transactionally. |
| `<PHONE>` | 10-digit NANP phone, normalized (digits only, leading `1` country code and all separators/`+` stripped). |

Canonical separator is a single hyphen `-`. The number is stored and compared in
this canonical, uppercase-`TYPE` form.

### Phone normalization
- Strip everything non-digit.
- Drop a leading `1` if the result is 11 digits (NANP country code).
- Require exactly 10 digits afterward; otherwise the phone segment is **omitted**
  and the number is allocated as `<TYPE>-<YEAR>-<SEQUENCE>` (3 segments). This
  keeps allocation non-blocking for users/orgs without a usable phone, and the
  segment can be backfilled later without changing TYPE/YEAR/SEQUENCE.
- The same normalizer must be used at allocation time and at any
  lookup/comparison time (a shared `normalizePhone10()` helper).

## 2. Allocation — server-side only, transactional, immutable

- **Server-only:** account numbers are never accepted from the client and never
  influence privilege. `<TYPE>` comes from the server's notion of the entity
  kind, not from a request field.
- **Transactional:** reuse the existing `platform_account_sequences` mechanism
  (`INSERT … ON CONFLICT DO NOTHING` then `SELECT next_seq … FOR UPDATE` then
  increment) so concurrent signups can't collide on a sequence. The sequence key
  stays `(year, entityType)`; `entityType` maps to `<TYPE>` (`user`→ derived
  L/P by `userType`, `org`→ derived by org `type`). To keep `L`/`P` sequences
  independent, **widen the sequence key to `(year, accountType)`** where
  `accountType ∈ {L, P}` rather than the current `{user, org}` — otherwise a lab
  and provider created in the same year would share a counter. This is the one
  structural change Phase 2 makes to the sequence table semantics.
- **Immutable:** once allocated, `<TYPE>-<YEAR>-<SEQUENCE>` never changes for the
  life of the entity. Only the optional `<PHONE>` segment may be *added* later
  (if it was missing) — it must never be rewritten to a different number, since
  the account number is used as a stable external identifier (printed on
  paperwork, used for login and cross-lab linking). Treat the column as
  append-only at the segment level.

## 3. Storage

- Continue storing in `users.platformAccountNumber` and
  `organizations.platformAccountNumber` (text, unique). No new column required.
- Add a unique index already exists on `users.platformAccountNumber`; ensure the
  same on `organizations.platformAccountNumber` in Phase 2 if not present.

## 4. Migration / backfill of existing `<seq><YY><F><L>` numbers

Existing numbers (e.g. `2926JW`) are **not parseable** into the new format
unambiguously (no type letter, 2-digit year, initials instead of phone). Strategy:

1. **Do not rewrite existing numbers in place.** Rewriting would break any
   external reference (printed/quoted account numbers, prior cross-lab links).
2. Introduce the new format **only for newly allocated** entities at cutover.
3. For lookups, support **both** formats during a transition window: login and
   cross-lab matching accept the legacy `<seq><YY><F><L>` *and* the new
   `<TYPE>-<YEAR>-<SEQUENCE>-<PHONE>` (and its 3-segment variant).
4. Optional opt-in backfill: a script may *assign a second, new-format number*
   to legacy entities (stored alongside, or the legacy value kept as an alias)
   only if the product decides every entity must have a new-format number. Phase
   1 recommends **lazy** adoption (new entities only) to avoid touching live
   external identifiers. Decision deferred to Phase 2 product sign-off.
5. The migration is reversible at the data level because step 1–3 add behavior
   without destroying the old values.

## 5. Login-by-account-number impact

`/auth/login` matches `identifier` against username, email, and
`platformAccountNumber` (case-insensitive, trimmed; see `auth.ts` ~599–606).
Changes for Phase 2:
- Normalize the identifier before comparison: uppercase the `<TYPE>` letter,
  collapse separators to the canonical hyphen, and compare against the stored
  canonical value. Also still compare case-insensitively against legacy numbers.
- Because the new number can contain a phone segment, ensure the matcher does an
  **exact canonical equality** check (not a prefix/substring match) to avoid one
  user's number matching another's by phone coincidence.

## 6. Cross-lab linking impact

Cross-lab provider matching (`matchAndInviteCrossLabDoctors`) keys off
email/phone today, with the platform account number recorded on the link. With
the new format the phone is *embedded* in the account number:
- Keep matching on normalized **email/phone**, not on the account-number string,
  so legacy and new entities still match each other.
- When displaying/recording links, store the new-format number where available
  and fall back to the legacy value, mirroring the dual-read approach in §4.

## 7. Worked examples

| Entity | TYPE | Year | Seq | Phone | Result |
|---|---|---|---|---|---|
| 3rd lab of 2026, 555-123-4567 | L | 2026 | 3 | 5551234567 | `L-2026-3-5551234567` |
| 1st provider of 2026, no phone | P | 2026 | 1 | — | `P-2026-1` |
| 12th provider of 2026, +1 (212) 555-0000 | P | 2026 | 12 | 2125550000 | `P-2026-12-2125550000` |
