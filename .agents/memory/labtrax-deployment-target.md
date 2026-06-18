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

**Detection (do this first when the recurring ~83%-single-outage uptime alert fires):** `.replit` saying `vm` does NOT mean the live deployment is vm — they drift. Always confirm the LIVE type with `getDeploymentInfo()` (`deploymentType` field). Seen repeatedly: `.replit` = `vm` but `getDeploymentInfo()` returns `autoscale`, because the last publish went out as autoscale (or predates the vm config change) and was never re-published. The fix is then NOT a code/config edit (config is already correct) — it is a re-publish with **Reserved VM explicitly selected** in the Publishing pane (the UI selection is authoritative; clicking Publish without changing it can re-ship autoscale). Note prod deployment-log retention is short (~hours), so a midday/overnight outage window is usually already rolled off — diagnose from `getDeploymentInfo()` + the uptime-alert fingerprint, not from logs.
