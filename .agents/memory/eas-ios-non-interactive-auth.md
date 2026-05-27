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

**How to apply:** when adding/fixing an EAS iOS build workflow, set all five env vars on the `eas build` invocation. With them in place, eas-cli auto-syncs capabilities, registers App Groups on the App ID, and regenerates provisioning profiles with no human intervention — solving the recurring "Provisioning profile … doesn't support the group.* App Group" failure mode for share extensions and other entitled targets.
