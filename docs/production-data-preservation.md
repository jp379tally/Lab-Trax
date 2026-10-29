# Production data preservation release policy

**A successful build is not approval to publish.** LabTrax records, accounting
history, attachment links, and stored media must remain unchanged by a release.
Except for the specific owner-authorized backup-repair exception below, if any
item below is unverified or the exact migration is destructive, do not
recommend or perform the release. Do not use a Publish option that replaces
data, restores a backup, copies development data, or seeds demo records.

## Required review before every production publish

- [ ] Review the exact development-to-production schema diff shown by Replit.
  Reject any table/column/data drop, `TRUNCATE`, lossy type conversion,
  development-data replacement, or unapproved data rewrite. An additive
  migration still needs review for compatibility and its effects on existing
  rows.
- [ ] Confirm the deployment remains bound to the intended production
  database. The production identity preflight must pass against the committed
  fingerprint. Never change the binding to make a failing check pass.
- [ ] Verify a recent off-site production backup in OneDrive before release,
  unless this is the explicitly authorized backup-repair rollout below.
  The required protection cadence is every 15 minutes. Confirm the actual
  cloud object exists and its returned size matches the uploaded bytes; confirm
  it contains both the database and case media and has a successful integrity
  or restore check. A “success” history row, a local copy, or a source-code
  mirror is not evidence.
- [ ] Confirm the Publish flow is not configured to replace, reset, restore,
  seed, or copy data from development.
- [ ] Do not run a production schema push. Replit-managed production schema
  changes must use the reviewed Publish migration only.
- [ ] Keep any historical data repair separate from publishing. It requires
  its own exact scope, evidence, backup, review, and authorization.

If the pending migration cannot be compared to the exact reviewed diff, stop.
Record that migration safety is **unverified**; do not infer safety from the
current schema, a successful build, or a passing identity check.

## Owner-authorized backup-repair rollout exception (2026-10-20)

The owner explicitly authorized completing and integrating the existing backup
repair, and republishing it, before a successful live off-site backup exists.
Requiring the repaired production backup to run before deploying that repair
would be circular. For this repair only, implementation completion means saved,
integrated source and applicable synthetic/isolated prepublication checks;
live provider read-back and production recovery proof follow the owner's
republish. Do not hold code-task completion solely on those later checks.
This applies to the first deployment of this bounded backup repair, not to
unrelated changes or subsequent ordinary releases.

This exception defers **only live backup freshness/verification**. It does not
authorize publication by an agent, a production restore, destructive SQL,
database replacement/rebinding, development-data copying, seeding, deletion of
records or files, or any relaxation of archive integrity/reference checks.
The exact pending managed schema diff and unchanged production binding still
need operator review. No environment variable or runtime bypass is introduced.

Unreadable required references remain an explicit operational failure. Preserve
the records and existing bytes, repair storage access or recover verified exact
originals, then retry. Never omit them, manufacture substitutes, mark an
incomplete archive complete, or advance verified-backup status on a failure.
After republishing, confirm the deployed staging path, run the backup from the
app, verify the actual private destination object and coverage, and rehearse
restore only in isolated resources. Until then, production recovery protection
is **unverified**, even though the repair implementation can be complete.
The normal backup policy and protection cadence remain unchanged.

## Startup and release-triggered mutation audit

The API's historical startup writers are held behind an explicit
`NODE_ENV=development` gate. Each scheduled entry point has its own guard as
well, so a direct production call cannot bypass the registration gate.

| Operation | Production behavior |
| --- | --- |
| Infer bank-transaction/vendor links; normalize lab-inbox storage paths | Deferred; existing links and media references are not rewritten. |
| Clear expected-delivery dates; collapse duplicate removable restorations | Deferred; no case dates or restoration rows are changed and no invoice sync follows. |
| Reconstruct recent case invoices; convert legacy draft invoice statuses; fill historical invoice issue dates | Deferred; existing invoices remain as they are. |
| Backfill legacy case-media ownership and restore files from trash | Deferred; existing database references and stored files are not rebound or moved. |
| Infer and consolidate duplicate provider accounts | Recurring consolidation is disabled unless the process is explicitly development. |
| Seed demo users | Requires both explicit development mode and the demo-seed flag. |
| Restore/recovery endpoints and backup restore | Remain explicit operator actions; they are not called by startup. |

Required startup integrity work remains active: ownership and invoice
accounting triggers are installed without the old database-wide invoice
baseline/reconciliation writes; missing invoice history is initialized from
the pre-edit state on the first accounting-relevant edit. The case-list
projection setup/backfill touches only derived projection fields and retains
read-time fallback. Legacy case-media table/index creation is additive DDL.

The daily orphaned-media cleanup remains a normal recurring workflow. Startup
only arms its timer for the configured cleanup hour; it does not run cleanup
or recover stuck cleanup-run records immediately. Scheduled backups,
statements, billing, and other established recurring jobs are likewise not
startup repair scripts and remain enabled.

## What the code enforces

- A publishing-only exception preserves the exact committed legacy archival
  cohort without removing or reassigning live records. It verifies every
  original archived case field against its canonical PostgreSQL row hash and
  refuses missing/changed records or any other unresolved case ownership.
  Original column names are pinned so later additive columns do not change
  the archival comparison. This is not a runtime access exception, a general
  ownership bypass, or approval of the managed migration or backup evidence.

- The API production build runs a read-only production identity and schema
  preflight. Production identity mismatches or unreadable identity evidence
  fail the command. Missing columns remain advisory because Replit applies its
  managed migration after the build stage.
- The optional `PUBLISH_SCHEMA_DIFF_PATH` check rejects common destructive SQL
  patterns in a supplied diff. It is a conservative text scan, not a SQL
  parser or an approval of the deployment.
- Production and ambiguous runtime environments defer historical startup
  repairs, inferred provider-account consolidation, demo seeds, invoice
  rewrites, date clearing, and legacy media backfill/restoration. Required
  integrity triggers, projection setup, and additive media-ledger table
  creation remain enabled. The ordinary time-based backup, billing, statement,
  and case-media cleanup services remain scheduled; their work is not run as
  an immediate startup repair.

## What the code cannot enforce

The current production build configuration provides no input containing the
exact platform-managed pending migration diff, and no supported review signal
is wired into the build. The build therefore reports migration safety as
**unverified** when no diff file is supplied. Replit's Publish interface,
production database binding settings, backup destination, and any
replace/restore/copy choice also require operator review. The build does not
claim that those platform actions are protected.

Do not publish while any of those checks is missing, except that live backup
verification alone may be deferred for the explicitly authorized repair rollout
above. Review the exact diff and applicable evidence in the platform before
promotion. This policy is a release
requirement, not a claim that the application controls the Publish button.
