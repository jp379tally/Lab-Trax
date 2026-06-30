---
name: Duplicate-doctor pre-create checkpoint
description: The rule for catching near-duplicate doctor names before a case is saved, and which create paths it applies to.
---

# Duplicate-doctor pre-create checkpoint

A "doctor" is just a `(doctorName, providerOrganizationId)` pair on case rows — there is no doctor entity/table. Catching duplicates is purely name-similarity within one practice.

## The rule
When creating a case, if the typed doctor name is similar (≥ the lab's
threshold) to an existing doctor name in the SAME lab+practice, the server
**rejects with HTTP 409 `DOCTOR_CONFIRMATION_REQUIRED`** (body carries the
candidate matches) until the client re-submits with a "confirm new doctor"
flag. That 409 is the authoritative, unavoidable gate.

- **Literal-exact** (case-insensitive, trimmed) names are NEVER flagged — the user is reusing a known doctor.
- **Normalized-equal** names like "Kanesha Cole" vs "Dr. Kanesha Cole" ARE flagged: the matcher strips a leading `dr` token, so they normalize-equal while staying different literals.
- **Remakes** skip the check (name is inherited, not typed).
- The **iTero auto-import** paths cannot 409 (no human at create time), so instead they **auto-merge**: shared helper `resolveIteroDoctorAutoMerge()` (reuses `findSimilarDoctorsInPractice`) adopts an existing near-duplicate name in the SAME practice when `>=` the lab threshold, records a `doctor_auto_merged_from_itero` case event, and leaves below-threshold names verbatim (still surfaced via the 0.4 `suggestedDoctorName` banner). Must be threaded into ALL THREE iTero create paths (rx route, zip route, poller helper `processOneIteroZipFile`) — same fan-out as `itero-parallel-case-create-paths.md`. Thread the merged name into BOTH pricing resolution and the case insert in each.

## Two client layers, one gate
Clients also do a pre-submit similarity probe for nicer UX, but must STILL
handle the 409 on the create call itself (probe can fail, be skipped, or go
stale between probe and save). Both desktop and mobile open the same
"which doctor do you mean?" confirmation from the 409 body, then re-submit
with the confirm flag.

**Why:** the probe is best-effort; only the server 409 guarantees the
checkpoint is unavoidable. A code review rejected an earlier cut that did the
probe but dropped the 409 into a generic error toast.

## One shared matcher — keep in sync
The bigram-Jaccard matching + per-lab threshold lives in a single shared
module. It powers THREE surfaces that must agree: the duplicate-doctor
clusters/merge panel, the AI "did you mean?" suggestion path (which keeps its
own lower threshold), and this pre-create checkpoint. Don't fork the
normalization — divergence makes the panel and the checkpoint disagree on
what counts as a duplicate.
