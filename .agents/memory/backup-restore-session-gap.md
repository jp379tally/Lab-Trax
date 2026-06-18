---
name: Backup-restore session gap fix
description: Gap-free session preservation during pg_restore: exclude user_sessions entirely via filtered TOC + FK drop.
---

## The Problem

`backup-restore.test.ts` runs 20 pg_restore cycles concurrently with other test workers (maxWorkers=2). pg_restore --clean drops `user_sessions` early (before `users`, because FK dependency). Sessions created between our pre-restore SELECT and pg_restore's DROP TABLE user_sessions were unrecoverable ("gap"). With ~40 test files creating sessions in beforeAll, ~95% chance of a failure per run.

The `onDelete: "cascade"` on `user_sessions.userId → users.id` means pg_restore's DROP TABLE users cascades to user_sessions even without explicit CASCADE.

## The Fix (backup.ts)

1. Query the FK constraint name via `pg_constraint` (the FK is named by Drizzle; query it dynamically).
2. `ALTER TABLE user_sessions DROP CONSTRAINT "<name>"` — removes the FK so pg_restore can DROP users without cascade.
3. `pg_restore --list dumpfile` → filter TOC: comment out all lines matching `/\buser_sessions\b/` that start with a digit.
4. `pg_restore --use-list=<filtered_toc> --clean --if-exists ...` — user_sessions is never touched; live sessions survive intact.
5. `DELETE FROM user_sessions WHERE user_id NOT IN (SELECT id FROM users)` — remove orphan sessions.
6. `ALTER TABLE user_sessions ADD CONSTRAINT "<name>" <condef>` — re-add FK using `pg_get_constraintdef(c.oid, true)`.

**Why:** user_sessions is excluded from pg_restore entirely, so no DROP TABLE user_sessions ever runs. The gap is zero.

## Test Updates Required

- **Test 12** assertion: changed from `TRUNCATE TABLE USER_SESSIONS` to `DELETE FROM user_sessions` (orphan cleanup replaces TRUNCATE+re-insert).
- **Test 7** race: capture case count in `beforeAll` alongside the backup build (not at test-execution time), otherwise concurrent workers creating cases cause off-by-one.

## What NOT to Try

- `--exclude-table=user_sessions`: pg_restore still DROPs users CASCADE, cascading to user_sessions. Broken.
- Pre-restore SELECT + TRUNCATE + re-insert: gap still exists (sessions created between SELECT and DROP are lost).
- `beforeEach` on all 40+ test files: works but is 40+ edits; the backup.ts fix is systemic.
