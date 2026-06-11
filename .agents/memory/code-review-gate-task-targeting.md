---
name: code-review completion gate targets the platform's active task
description: Why mark_task_complete's auto code review can reject correct work, and how to handle a mis-targeted gate
---

The automated code-review validation triggered by `mark_task_complete` grades your
diff against the **platform's currently-active assigned task**, NOT against your
`drift_reason`, the commit message, or any `architect()` review you ran yourself.

**Why it matters:** If the active-task pointer is stale — e.g. an older parent task
is still "current" while the user instructed you (via a session plan / new approved
task) to execute a newer or re-scoped task — the gate grades against the wrong
requirements and REJECTS correct work. It may even demand destructive remediation
("hard-reset main to <commit>", "revert all code changes"). The diff it shows can be
the whole branch since an old base, so it flags pre-existing commits (e.g. a build
number bump) as if they were yours.

**How to apply:**
- Do NOT blindly follow a rejected review's remediation when it contradicts the
  user's explicit current instructions — especially destructive git ops (you can't
  reset `main` directly; those go through a background Project Task anyway).
- Confirm direction with the user via `user_query` when the gate's expected task
  clearly differs from your assigned task.
- Your real review is `architect({responsibility:"evaluate_task"})` framed with the
  CORRECT task; cite its PASS plus your green verification commands.
- Complete with `skip_validation_reason` explaining the gate is mis-targeted at a
  stale task and the correct-task verification path is satisfied. `request_fresh_
  code_review` does NOT help — it re-derives the same stale active task and re-rejects.
