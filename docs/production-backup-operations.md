# Production backup operations

Application backups protect the bound production database and original user files. Users choose a destination, not a production/development scope. Development-backed application capture and schedule changes are rejected. Explicit operator database exports remain separate and must not be described as complete records/media recovery points.

## Initial operator copies

Run artifacts/api-server/src/jobs/direct-database-export.ts with the production argument to read PROD_DATABASE_URL, verify protected-lab lineage in a repeatable-read snapshot, export a custom PostgreSQL dump, encrypt it and upload to Apps/LabTrax Backups/direct-initial/database-exports/production. The development argument uses the distinct development binding and separate folder. Both authenticate downloaded OneDrive bytes and compare the recovered dump checksum. These copies include no original media and do not initialize the scheduled media chain. A pg_restore listing is an archive check, not a full restore rehearsal. Preserve the configured backup encryption key separately through the existing secure credential system.

## Production records and media baseline

Run artifacts/api-server/src/jobs/direct-production-initial.ts with tsx from the API package. Set LABTRAX_PG_BIN_DIR to an installed compatible PostgreSQL tool directory when necessary. The job binds only its own process to the configured production connection, requires snapshot lineage verification, uses the same production-content namespace as scheduled jobs and never impersonates a deployed process. It holds the existing full-backup and production-protection database locks; a competing job is left untouched. Retention deletion is disabled for this operator path.

The worker streams originals to independently encrypted chunks, checks stored content, then commits a recovery point. It updates shared production-protection status. It does not require a Settings tab or authenticated browser download, but its Replit workspace process must remain running. Its 12-hour deadline is finite. Missing originals create a retained partial point with warnings and never advance complete protection. Do not report a complete recovery point based only on a database export or upload response.

## Scheduled protection

Scheduled protection verifies the previous recovery point and provider content-version metadata, fingerprints source rows, and uploads changed row bodies and new/changed original-file chunks. Deletions and retained dependencies remain represented. Unchanged media bytes are not downloaded/uploaded again when their authenticated version evidence remains valid. Comparison, metadata checks and changed content still take time. Overlapping intervals are skipped/coalesced.

PRODUCTION_RECORD_REFERENCE_PROTOCOL changes only when recoveryReferences semantics change. UI/source revisions alone must not reset record comparison. An older point using the previous source-revision-bound contract may require one record rebaseline; its authenticated media remains reusable.

Use Production Backup settings to save a 15-minute OneDrive schedule after checking the initial result and coverage warnings. Retain all verification failures and partial-point warnings. Never restore a backup onto production for a test; use the guarded isolated restore workflow.
