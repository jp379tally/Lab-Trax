---
name: LabTrax deployment target
description: Why LabTrax production must run on Reserved VM (vm), not autoscale.
---

# LabTrax must deploy as Reserved VM (`vm`), not autoscale

**Rule:** Keep `deploymentTarget = "vm"` in `.replit` for this project. Do not revert to `autoscale`.

**Why:** The api-server is stateful and long-running, which autoscale fights:
- In-process scheduled jobs (OneDrive backup ~07:00 UTC, orphaned-media cleanup ~08:00 UTC, installer health check ~06:00 UTC, billing checks) only fire if an instance is awake at that hour — autoscale scales to zero and silently skips them.
- Autoscale scales to zero at low traffic; overnight the uptime monitor's probes hit slow cold starts (heavy ~5.6 MB bundle + DB connect + startup legacy-media backfill) that time out and register as a multi-hour outage block (observed: a single ~83%-uptime overnight outage; SIGTERM with no restart in logs).
- Local-disk uploads are ephemeral/segregated per instance (the photo-loss problem; mitigated by object-storage mirroring but autoscale keeps making disk state fragile).
- The startup backfill re-runs on every cold start.

**How to apply:** Changing the target is config-only; the user must re-publish for it to take effect. Edit `.replit` via the `verifyAndReplaceDotReplit` callback (signature: `{ tempFilePath, dotReplitPath }`) — direct edits to `.replit` are blocked. Reserved VM bills a fixed always-on rate (cost tradeoff the user accepted).
