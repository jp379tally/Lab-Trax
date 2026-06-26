---
name: EAS build must run as a persistent workflow
description: Long-running CLI jobs (EAS build/submit) die if backgrounded from bash; run them as a Replit workflow instead. Plus .easignore root-level fix and when an Apple build number is actually consumed.
---

# Run long EAS build/submit jobs as a Replit workflow, never a backgrounded bash process

**Rule:** Launch `scripts/eas-ios-build.sh` (or any multi-minute CLI job that must outlive a tool call) via `configureWorkflow({ outputType: "console", autoStart: true })`, then poll `getWorkflowStatus`. Remove the workflow when finished.

**Why:** A `nohup ... &` background process started inside a `bash` tool call gets **SIGKILLed** when that tool call returns — the process group is torn down. Observed symptom: the EAS build reached "Compressing project files" and then vanished between tool calls. Because it was SIGKILL, the script's `trap ... EXIT` cleanup did **not** run, so the build-number bump in `app.json` was left dangling/uncommitted. Only Replit workflows persist across agent turns.

**How to apply:** For EAS builds, slow imports/exports, or any job >~30s that must survive to the next turn, use a workflow. Don't edit tracked files or install packages while it runs — that restarts the workflow and kills the in-flight build (re-running the script bumps the build number again).

**LabTrax policy override (supersedes the above for the paid builds):** In THIS repo the `replit.md` #1 user preference forbids registering `EAS iOS Build + Submit` / `Desktop Build + Publish` as Replit workflows, because every workflow (and every `setValidationCommand` entry) auto-attaches to the `Project` run aggregate = the Run button (`.replit` `runButton = "Project"`, tasks = typecheck-all/mobile-test/knowledge-test). Confirmed: the EAS workflow does NOT exist in `.replit`; `restart_workflow("EAS iOS Build + Submit")` returns `RUN_COMMAND_NOT_FOUND`. So the agent **cannot** launch the paid build itself — bash tool caps at 120s, backgrounded procs are SIGKILLed on return, and workflow/validation-runner both attach to the Run button. The agent's role is **prep + approve only**: run the full pre-release checklist green, then `touch .local/.eas-build-approved` (and ensure no `.local/.eas-submit-only` for full build+submit). The **user** runs `bash scripts/eas-ios-build.sh` from their persistent Shell (the script consumes the approval token). A "submit to testflight" request therefore bottoms out at a user-run Shell command, not an agent-driven build.

# Root .easignore must explicitly exclude artifacts/labtrax-desktop/

**Rule:** The root `.easignore` (at workspace root) must list `artifacts/labtrax-desktop/` explicitly. The per-project `.easignore` at `artifacts/labtrax/.easignore` is a sub-directory override and does NOT prevent the desktop artifact from being archived from the workspace root.

**Why:** With `EAS_NO_VCS=1`, EAS archives from the monorepo root. `artifacts/labtrax-desktop/` is 566 MB of Electron binaries. Without the explicit root exclusion, EAS "Compressing project files" step consistently exceeds 2 min and times out. After adding it plus `artifacts/api-server/` (31 MB), the archive shrinks to ~1.5 MB and compression completes in seconds.

**How to apply:** After any workspace restructuring, verify `.easignore` at workspace root has all non-mobile artifact directories listed. Also confirm `attached_assets/` is listed — `artifacts/labtrax/attached_assets/` alone is 1.1 GB.

# When an Apple build number is actually consumed

An interrupted upload that never created an EAS build (check `eas build:list` — latest still shows the old number) does **NOT** consume the Apple build number. It is safe to rebuild the same number: discard the dangling bump (working tree had N+1, no build N+1 exists) and let the script bump cleanly to N+1 again. The number is only consumed once the IPA reaches Apple / an EAS build row exists.
