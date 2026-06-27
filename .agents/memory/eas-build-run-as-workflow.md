---
name: EAS build must run as a persistent workflow
description: Long-running CLI jobs (EAS build/submit) die if backgrounded from bash; run them as a Replit workflow instead. Plus .easignore root-level fix and when an Apple build number is actually consumed.
---

# Run long EAS build/submit jobs as a Replit workflow, never a backgrounded bash process

**Rule:** Launch `scripts/eas-ios-build.sh` (or any multi-minute CLI job that must outlive a tool call) via `configureWorkflow({ outputType: "console", autoStart: true })`, then poll `getWorkflowStatus`. Remove the workflow when finished.

**Why:** A `nohup ... &` background process started inside a `bash` tool call gets **SIGKILLed** when that tool call returns — the process group is torn down. Observed symptom: the EAS build reached "Compressing project files" and then vanished between tool calls. Because it was SIGKILL, the script's `trap ... EXIT` cleanup did **not** run, so the build-number bump in `app.json` was left dangling/uncommitted. Only Replit workflows persist across agent turns.

**How to apply:** For EAS builds, slow imports/exports, or any job >~30s that must survive to the next turn, use a workflow. Don't edit tracked files or install packages while it runs — that restarts the workflow and kills the in-flight build (re-running the script bumps the build number again).

**LabTrax policy override (supersedes the above for the paid builds):** In THIS repo the `replit.md` #1 user preference forbids registering `EAS iOS Build + Submit` / `Desktop Build + Publish` as Replit workflows, because every workflow (and every `setValidationCommand` entry) auto-attaches to the `Project` run aggregate = the Run button. Confirmed mechanics: those two entries appear in `listWorkflows`/`configureWorkflow`'s error list but are **non-runnable phantoms** — `restart_workflow("EAS iOS Build + Submit")` returns `RUN_COMMAND_NOT_FOUND` ("run command doesn't exist in config"), and `configureWorkflow` (new OR same-name reuse) is hard-blocked because the project sits at **11/10 workflows** (already over the cap, grandfathered; you'd have to delete ≥2 user workflows to add one, and it would recreate the Run-button foot-gun). So the **workflow route is a dead end** for the agent.

**BUT the agent CAN drive the paid build itself — use `--no-wait`** (this supersedes the old "agent cannot launch it" conclusion). The 120s bash cap and SIGKILL-on-return only bite if you *wait* for the ~6–40 min build in-process. Instead, replicate the script's env and let EAS infra do the work asynchronously:
1. Bump: `pnpm --filter @workspace/scripts run bump-build-number` (edits app.json only; commit is separate — checkpoint at loop end captures it, no `[skip ci]` needed since no push-triggered mobile CI exists).
2. Build (returns in seconds, runs on EAS): from `artifacts/labtrax`, `EAS_NO_VCS=1 EAS_BUILD_NO_EXPO_GO_WARNING=true npx --yes eas-cli build --platform ios --profile production --non-interactive --no-wait`. Prints a build id; poll with `eas-cli build:list --limit 1` (Status in queue→in progress→finished). `build:view`/`submission:list` are NOT supported on the installed outdated eas-cli (~v16).
3. Submit (keep build & submit SEPARATE — do NOT use `--auto-submit`; the script's collision-loop comment explains why): `python3 scripts/write-asc-key.py` then export the ASC vars (EXPO_ASC_API_KEY_PATH=/tmp/AuthKey_RV23AJ8V62.p8, EXPO_ASC_KEY_ID, EXPO_ASC_ISSUER_ID, EXPO_APPLE_TEAM_ID, EXPO_APPLE_TEAM_TYPE) and `eas-cli submit --platform ios --id <buildId> --non-interactive --no-wait`.
4. Poll submission status via **EAS GraphQL** (CLI can't): `curl -s https://api.expo.dev/graphql -H "Authorization: Bearer $EXPO_TOKEN" --data '{"query":"query($id:ID!){submissions{byId(submissionId:$id){status error{errorCode message}}}}","variables":{"id":"<subId>"}}'` → status IN_QUEUE→IN_PROGRESS→FINISHED, `error:null` = healthy (a non-null error / the account-block in eas-submit-account-block.md is the failure to watch). Note: the `code_execution` JS sandbox has NO `process.env`, so the token is only reachable from bash/curl.

Prereq still required: green pre-release checklist + `touch .local/.eas-build-approved`. The agent flow above bypasses `eas-ios-build.sh` so it does NOT auto-consume that token — `rm -f .local/.eas-build-approved` yourself after the build is confirmed queued. The user-run `bash scripts/eas-ios-build.sh` from Shell remains the fully-tested alternative.

# Root .easignore must explicitly exclude artifacts/labtrax-desktop/

**Rule:** The root `.easignore` (at workspace root) must list `artifacts/labtrax-desktop/` explicitly. The per-project `.easignore` at `artifacts/labtrax/.easignore` is a sub-directory override and does NOT prevent the desktop artifact from being archived from the workspace root.

**Why:** With `EAS_NO_VCS=1`, EAS archives from the monorepo root. `artifacts/labtrax-desktop/` is 566 MB of Electron binaries. Without the explicit root exclusion, EAS "Compressing project files" step consistently exceeds 2 min and times out. After adding it plus `artifacts/api-server/` (31 MB), the archive shrinks to ~1.5 MB and compression completes in seconds.

**How to apply:** After any workspace restructuring, verify `.easignore` at workspace root has all non-mobile artifact directories listed. Also confirm `attached_assets/` is listed — `artifacts/labtrax/attached_assets/` alone is 1.1 GB.

# When an Apple build number is actually consumed

An interrupted upload that never created an EAS build (check `eas build:list` — latest still shows the old number) does **NOT** consume the Apple build number. It is safe to rebuild the same number: discard the dangling bump (working tree had N+1, no build N+1 exists) and let the script bump cleanly to N+1 again. The number is only consumed once the IPA reaches Apple / an EAS build row exists.
