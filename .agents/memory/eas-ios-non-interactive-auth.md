---
name: EAS iOS non-interactive auth
description: eas-cli env vars required for `--non-interactive` iOS builds with App Store Connect API key; without them the CLI silently prompts and hangs forever in CI/workflow logs.
---

# Required env vars for `eas build --platform ios --non-interactive`

When using an ASC API key for credential management (not just for submit), the CLI reads these five env vars from `process.env`. If ANY are missing, `--non-interactive` does NOT prevent the prompt — eas-cli hangs at an `inquirer` prompt waiting forever, which looks like a stuck build with no error.

- `EXPO_ASC_API_KEY_PATH` — absolute path to the `.p8` file
- `EXPO_ASC_KEY_ID` — short key ID (e.g. `RV23AJ8V62`)
- `EXPO_ASC_ISSUER_ID` — **not** `EXPO_ASC_KEY_ISSUER_ID` (common mistake). Issuer UUID.
- `EXPO_APPLE_TEAM_ID` — 10-char Apple Team ID (e.g. `2D9XT8L3D2`)
- `EXPO_APPLE_TEAM_TYPE` — one of `IN_HOUSE`, `COMPANY_OR_ORGANIZATION`, `INDIVIDUAL` (not the human-readable label)

**Why:** authoritative env var names live in `eas-cli/build/credentials/ios/appstore/resolveCredentials.js` — grep that file when names drift between releases. `eas.json`'s `submit.ios.ascApi*` keys do NOT cover build-time credential management; they only authenticate the `eas submit` step.

**How to apply:** when adding/fixing an EAS iOS build workflow, set all five env vars on the `eas build` invocation. With them in place, eas-cli builds non-interactively and regenerates provisioning profiles for capabilities **that are already enabled** on the App IDs.

## CORRECTION (verified June 2026): API-key auth does NOT sync NEW capabilities / App Groups

The earlier claim that the API-key path "auto-syncs capabilities and registers App Groups with no human intervention" is **wrong**. The ASC API-key credential path explicitly **skips capability syncing**. If an App ID is missing a capability/App Group (e.g. a brand-new share extension needing `group.app.replit.labtrax.sdr` linked to BOTH `app.replit.labtrax` and `app.replit.labtrax.share-extension`), API-key builds fail with "Provisioning profile … doesn't support the App Group" and CANNOT fix it themselves.

To enable/link a NEW capability or App Group you need a **one-time interactive Apple-ID (cookie) login** (`eas build` with the `EXPO_ASC_*` env vars UNSET so eas-cli falls back to Apple-ID auth), OR do it manually in the Apple Developer Portal (Identifiers → enable App Groups on each App ID → Configure → check the group). Once linked at Apple, the capability persists, and subsequent API-key non-interactive builds work fine.

**Driving the interactive 2FA in a Replit workflow (PTY relay) — gotchas that cost hours:**
- Run the interactive `eas build` as a persistent **workflow** (only workflows survive across agent turns; tmux daemons and plain bash calls do not). Relay the 6-digit code and any prompt answers through small `/tmp` files; never edit tracked files or install packages while it's live (that restarts the workflow and invalidates the in-flight code).
- The "How do you want to validate your account? device / sms" prompt is a **horizontal** select — move with the **RIGHT arrow** (`\x1b[C`), not Down. Down does nothing, silently leaving the default "device".
- After choosing sms, Apple may list **multiple trusted phone numbers**, and the **default highlighted one is not necessarily the user's**. Picking the wrong number means every code the user reads off their real phone reads as "Invalid" forever. Always confirm the masked last-two digits with the user and navigate the vertical list to THEIR number before sending.
- Verify each selection by inspecting the raw PTY log with `cat -v` (the highlighted choice renders cyan+underline) BEFORE pressing Enter — blind arrow presses through the relay are unreliable.
