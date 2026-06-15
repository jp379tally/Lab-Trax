---
name: Validation runner for long checks
description: How to run checks that exceed the 120s bash limit in this environment
---

Some checks in this monorepo legitimately run longer than the bash tool's 120s
cap and cannot be completed from a plain bash call here:
- `pnpm --filter @workspace/labtrax-desktop run typecheck` (large Electron+React
  project; no incremental cache → multi-minute cold typecheck).
- A single heavy api-server vitest file (transform ~150s + import ~290s for the
  whole app graph) — even one file can blow the 120s cap.

**Don't** try to detach with `setsid`/`nohup` to dodge the cap: the detached
process still gets killed (OOM / session cleanup) and you get an empty log.

**Do** run them through the validation skill from the code_execution sandbox:
`setValidationCommand({name, command})` then `startValidationRun({commandIds:[name]})`.
The validation runner executes as a workflow with **no 120s timeout**, returns a
status + log path, and reliably completes these. Clean up afterwards with
`clearValidationCommand({name})` so the slow command isn't left as a persistent
gate (it would make `mark_task_complete` validation time out).

**Why:** the bash 120s limit and detached-process kills are environment
constraints, not code problems; the validation runner is the only in-environment
path that finishes these without being killed.
