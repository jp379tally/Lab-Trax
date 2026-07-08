---
name: ASC API direct build-status check
description: How to query App Store Connect for TestFlight build processing/beta state from the workspace, and the p8 key format quirk.
---

# ASC API direct build-status check

You can verify a TestFlight build's state without the user by calling the App Store Connect API directly with a self-signed ES256 JWT (kid/issuer are in `scripts/eas-ios-submit-only.sh`).

- `GET /v1/builds?filter[app]=<appId>&sort=-uploadedDate` → `processingState` (`VALID` = processing done).
- `GET /v1/buildBetaDetails?filter[build]=<buildId>` → `internalBuildState` (`IN_BETA_TESTING` = live in TestFlight for internal testers) / `externalBuildState`.

**Key format quirk:** the `ASC_API_KEY_P8` env var stores the key with **spaces instead of newlines** — Node's `crypto.createSign` fails with `ERR_OSSL_UNSUPPORTED` / "DECODER routines::unsupported" until you strip the header/footer, remove whitespace, and re-wrap the base64 body at 64 chars with real newlines. Also use `dsaEncoding: "ieee-p1363"` for the JWT ES256 signature.

**How to apply:** any task that needs to confirm "did the build reach TestFlight?" — check via ASC API first; only the actual feature behavior needs the user's physical device.
