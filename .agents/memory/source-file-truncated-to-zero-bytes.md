---
name: Source file truncated to 0 bytes mid-session
description: A tracked source file can end up empty (0 bytes) after a concurrent vitest/validation crash; recover from the platform auto-commit, don't rewrite from scratch.
---

# Source file silently truncated to 0 bytes

**Symptom:** A full `pnpm run typecheck` fails with a cascade of `TS2306: File 'X' is not a module` errors in every file that imports `X` — while a *targeted* typecheck of the same package passed minutes earlier. The importing files are unrelated to your change; the common thread is they all import one file. That one file is empty: `wc -l` reports `0`.

**Why it happens:** A large source file can be truncated to 0 bytes by a crash/OOM during a concurrent run (e.g. desktop jsdom vitest + api-server vitest + validation firing together). The file you read with full content earlier in the same session is now empty. Worse: the platform's end-of-attempt auto-commit then commits the empty file, so `git status` shows the working tree "clean" and `git show HEAD:<path>` is also empty.

**How to recover (do NOT rewrite the file from scratch):**
1. Confirm: `wc -l <path>` → 0.
2. Find a good copy in history. The platform commits once per `mark_task_complete` attempt, so an *earlier* auto-commit usually still has the full file:
   `git --no-optional-locks log --oneline -6`
   then for each candidate ref: `git --no-optional-locks show <ref>:<path> | wc -l` and grep for a token you know you added (e.g. a state var name) to find the commit that has BOTH the full file and your edits.
3. Restore: `git --no-optional-locks show <ref>:<path> > <path>` (read-only git show piped to disk — does not change branch or commit).
4. Re-run `pnpm --filter <pkg> run typecheck` then full `pnpm run typecheck`.

**Prevention:** Avoid running multiple heavy vitest suites in parallel with the validation runner against the same workspace. Prefer the validation runner serially for one heavy suite at a time.
