---
name: Invoice "INV-<caseNumber>" collision adoption
description: How a canonical case can adopt a foreign patient's invoice, and the correct repair direction (metadata is truth, detach the case).
---

## What goes wrong
Invoice numbers are derived from case numbers (`INV-<caseNumber>`). Case numbers are
reused across the legacy-mobile (`lab_cases`) and canonical (`cases`) spaces, so a
canonical case's generate-invoice can match a pre-existing **orphaned** invoice
(caseId=null) that actually belongs to a **different patient** — adopting it by setting
`caseId` and dragging in the case's `providerOrganizationId`, while leaving the real
owner's `display_metadata_json` (patientName/billTo) in place. Symptom: the invoice
shows a correct Rx Summary (read from the linked case) but the WRONG patient/practice
header (the stale snapshot), or the right patient under the wrong practice.

## Repair direction (got this BACKWARDS once)
`display_metadata_json` is the **true identity** of the invoice. The foreign `caseId` +
the `providerOrganizationId` it dragged in are the corruption. The correct fix is to
**UN-ADOPT**: detach the foreign case (`caseId -> null`), restore/clear the true
provider org, and **preserve** `display_metadata_json`. Do NOT realign metadata to the
linked case — that destroys the real identity.

**Why:** the linked case is a stranger; only the snapshot carries who the invoice was
actually for.

## How to apply
- Production data repairs are operator-run: dev and prod are **separate DBs**, and the
  read replica is read-only, so the drifted rows exist only in prod. Deliver a
  dry-run-default script with an explicit, audited whitelist of invoice IDs (no fuzzy
  provider matching on financial records); verify identity + true patient before
  writing; guard the final `UPDATE` WHERE + assert exactly one row; idempotent.
- A merged generate-invoice guard now refuses (409) to adopt an orphan invoice whose
  stored patient mismatches the case. Known limitation: a canonical case whose number
  collides with a foreign legacy invoice can never mint its own `INV-<number>` until a
  follow-up implements non-colliding numbering (deterministic suffix). Don't reopen
  unsafe adoption to "fix" that.
