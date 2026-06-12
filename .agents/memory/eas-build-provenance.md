---
name: EAS build provenance verification
description: How to tell whether THIS task's iOS build actually ran vs a stale prior-task build still sitting in the logs
---

The `/tmp/logs/EAS_iOS_Build_+_Submit_*.log` filename timestamp is the log
*capture* time (when refresh_all_logs wrote the file), NOT when the build ran.
A finished EAS workflow's old log can be re-captured much later and look
current — a build submitted at 17:02 showed up in a file named `...182035...`.

To decide whether the build in the log belongs to the current task:
- Check git for the `chore: bump iOS build number to NNN [skip ci]` commit.
  eas-ios-build.sh commits the bump RIGHT AFTER a successful build, so that
  commit's timestamp ≈ build completion, and its position relative to your
  task's commits tells you which task produced it.
- Compare the submit log's "Build Date" line against your runtime files'
  mtimes. If your source was modified AFTER the Build Date, that build does
  NOT contain your work.
- If no new bump commit exists for a higher build number, no build has run
  since the last one — your task still needs its build.

**Why:** a stale log nearly produced a false "build already done, skip the
build" conclusion (the logged build belonged to the prior task). Getting this
wrong either wastes the one allowed credit-limited build or ships without the
task's work.

**How to apply:** before running OR skipping the one-shot EAS build, verify
provenance via the bump commit + submit "Build Date" + file mtimes — never the
log filename timestamp. Harmless build-number gaps (e.g. an interrupted bash
attempt leaving app.json bumped) are fine; only Apple CFBundleVersion
collisions matter.
