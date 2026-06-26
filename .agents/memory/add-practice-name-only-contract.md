---
name: Add Practice name-only contract
description: Provider practice creation requires only name (+ parent-lab routing); city/state/ZIP are optional server-side — do not client-gate on them.
---

# Add Practice: name-only is valid, address is optional

The server `createOrgSchema` (POST /api/organizations) requires only `name` +
`type` for a provider practice. `city`/`state`/`zip` are **optional** (zod
optional, DB columns nullable). A name-only practice (e.g. "Dr. Jane Doe") is
a real, intentional workflow used from Customer Center.

There is a protected regression test pinning this:
`artifacts/labtrax-desktop/src/pages/__tests__/practices-add-practice-name-only.test.tsx`
— it asserts the Add Practice submit button is enabled with just a name and that
the POST omits city/state/zip.

**Rule:** Do NOT add client-side hard-requirements (required markers / button
gating / submit blocks) for city/state/zip in `AddPracticeDialog`
(`artifacts/labtrax-desktop/src/pages/practices.tsx`). Gate only on what the API
enforces: `name`, plus a parent-lab choice when the admin manages >1 lab
(otherwise the practice can't be routed). Address fields may be shown but must
never block submission.

**Why:** A prior fix deliberately *removed* the address requirement because it
caused the "adding a practice silently fails" symptom (button stayed disabled /
submit no-op'd). A later task brief asked to re-require city/state/zip under the
belief the server returns 400 on missing address — that premise is wrong (it
reflects possible prod schema drift, where `wrapDbError` maps a DB notNull
violation to a 400). Re-adding the requirement regresses the name-only workflow
and breaks the protected test.

**How to apply:** If a task says "require city/state/zip for practices,"
first confirm the server contract and check the name-only regression test before
changing client gating. The reliability win is error surfacing (keep dialog open
on 400/409/403; 409 names `details.conflictingOrg`) + refreshing
`["organizations"]` on success — not stricter client validation. The desktop
practices list and the cases practice picker both key on `["organizations"]`.
