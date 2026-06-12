---
name: EAS build must run as a persistent workflow
description: Long-running CLI jobs (EAS build/submit) die if backgrounded from bash; run them as a Replit workflow instead. Plus when an Apple build number is actually consumed.
---

# Run long EAS build/submit jobs as a Replit workflow, never a backgrounded bash process

**Rule:** Launch `scripts/eas-ios-build.sh` (or any multi-minute CLI job that must outlive a tool call) via `configureWorkflow({ outputType: "console", autoStart: true })`, then poll `getWorkflowStatus`. Remove the workflow when finished.

**Why:** A `nohup ... &` background process started inside a `bash` tool call gets **SIGKILLed** when that tool call returns — the process group is torn down. Observed symptom: the EAS build reached "Compressing project files" and then vanished between tool calls. Because it was SIGKILL, the script's `trap ... EXIT` cleanup did **not** run, so the build-number bump in `app.json` was left dangling/uncommitted. Only Replit workflows persist across agent turns.

**How to apply:** For EAS builds, slow imports/exports, or any job >~30s that must survive to the next turn, use a workflow. Don't edit tracked files or install packages while it runs — that restarts the workflow and kills the in-flight build (re-running the script bumps the build number again).

# When an Apple build number is actually consumed

An interrupted upload that never created an EAS build (check `eas build:list` — latest still shows the old number) does **NOT** consume the Apple build number. It is safe to rebuild the same number: discard the dangling bump (working tree had N+1, no build N+1 exists) and let the script bump cleanly to N+1 again. The number is only consumed once the IPA reaches Apple / an EAS build row exists.
