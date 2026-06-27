# Environment Variables

Full environment-variable reference for LabTrax. The `replit.md` overview keeps
only the production-required and core-feature vars inline; everything else lives
here.

## Required in production

- `JWT_SECRET` — auth token signing; defaults to insecure value in dev
- `PLATFORM_ADMIN_SECRET` — must be sent as `X-Platform-Admin-Secret` to access all `/api/admin/*` endpoints; if unset, all admin endpoints return 403

## Optional — core features

- `EXPO_PUBLIC_DOMAIN` — set automatically from `$REPLIT_DEV_DOMAIN` in the labtrax dev script
- `AI_INTEGRATIONS_OPENAI_API_KEY` — enables AI features (Rx parsing, AI chat, smile preview)
- `LABTRAX_ENABLE_DEMO_SEEDS` — set `"true"` to seed demo users on startup
- `PLATFORM_ADMIN_PIN` — short numeric PIN alternative to `PLATFORM_ADMIN_SECRET` via `X-Platform-Admin-Pin`; requires a signed-in `role:"admin"` user (PIN alone cannot authenticate)

## SMS (Vonage)

- `VONAGE_API_KEY` — Vonage API key for SMS
- `VONAGE_API_SECRET` — Vonage API secret for SMS
- `VONAGE_PHONE_NUMBER` — sender phone number for outbound SMS (must be registered with Vonage)

## Backup / OneDrive

- `ONEDRIVE_*` — OneDrive integration credentials. Settings → Backup shows status via `GET /api/admin/backup/onedrive-status` and a Reconnect button at `POST /api/admin/backup/onedrive-reconnect`.
- `BACKUP_HOUR_UTC` — UTC hour for nightly OneDrive backup (default: `7`)
- `BACKUP_HISTORY_RETENTION_DAYS` — days of `backup_runs` to keep (default: `90`; overridable per-lab)
- `BACKUP_HISTORY_MAX_ROWS` — max `backup_runs` rows (default: `500`; overridable per-lab)

## AI memory candidate cleanup

- `AI_MEMORY_CANDIDATE_RETENTION_DAYS` — reviewed (approved/rejected) `ai_memory_candidates` rows older than this are pruned by the nightly billing job (default: `90`). De-dup (skip re-proposing rejected keys) is preserved within this window; rejected rows only become eligible for re-proposal after they age out.
- `AI_MEMORY_CANDIDATE_MAX_PENDING_PER_LAB` — max pending candidates kept per lab; oldest pending rows beyond the cap are dropped (default: `500`).

## Cleanup

- `CLEANUP_HOUR_UTC` — UTC hour for nightly orphaned media cleanup (default: `8`)
- `CLEANUP_ALERT_MIN_REMOVED` — min files removed before alert email (default: `1`)
- `CLEANUP_ALERT_MIN_FREED_MB` — min MB freed before alert email (default: `0`, disabled)
- `CLEANUP_HISTORY_RETENTION_DAYS` — days of `media_cleanup_runs` to keep (default: `365`)
- `CLEANUP_HISTORY_MAX_ROWS` — max `media_cleanup_runs` rows (default: `1000`)
- `MEDIA_CLEANUP_JOB_TOKEN` / `MEDIA_CLEANUP_API_URL` — for standalone cleanup script (scheduled deployment only)

## Desktop installer (code-signing)

- `CSC_LINK` — base64-encoded PFX certificate (OV or EV) for Windows code-signing. Encode with `base64 -w 0 certificate.pfx`. When set alongside `CSC_KEY_PASSWORD`, electron-builder signs the installer automatically, removing the SmartScreen "Windows protected your PC" warning. Absent → unsigned build (SmartScreen warning present).
- `CSC_KEY_PASSWORD` — password protecting the `CSC_LINK` PFX. Must be set together with `CSC_LINK`. Signing config (sha256, RFC 3161 via Sectigo) lives in `artifacts/labtrax-desktop/electron-builder.yml` under `signtoolOptions`.
- `CSC_EXPECTED_PUBLISHER` — optional but strongly recommended. Exact CN (Common Name) from the code-signing certificate (e.g. `"Acme Dental Software LLC"`). When set, `desktop-build-publish.sh` verifies the built EXE's signer subject contains this string after `signtool verify /pa` passes — catches wrong-cert scenarios (expired cert renewed under a new name, dev cert used in production, etc.). Absent → publisher-name check is skipped.

## Desktop installer

- `DESKTOP_INSTALLER_VERSION` — version string in Desktop App settings panel (default: `"1.0.0"`)
- `DESKTOP_INSTALLER_URL` — download URL (default: `/downloads/LabTrax-Setup.exe`); switch to `/downloads/LabTrax-Windows-Portable.zip` (portable ZIP fallback) or `/downloads/LabTrax.dmg` for those slots
- `INSTALLER_HEALTH_CHECK_HOUR_UTC` — UTC hour for nightly installer health check (default: `6`)
- `INSTALLER_HEALTH_BASE_URL` — base URL for the download HEAD probe (e.g. `https://your.replit.app`); if unset, reachability probe is skipped
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — App Storage config (auto-set when provisioned)
- `GITHUB_REPO_URL` — optional; shows Actions tab link in Settings → Desktop App
- `BUILD_BOT_TOKEN` — fine-grained GitHub PAT (Contents: Read & Write + bypass branch protection) used by CI to push incremented build counters to protected branches; falls back to `github.token` if unset

## Billing

- `SUBSCRIPTION_TRIAL_DAYS` — free trial length (default: `30`). Changed from 14 → 30 days. Existing in-flight trials keep their original end date.
- `SUBSCRIPTION_GRACE_DAYS` — grace period after trial/payment failure before locking (default: `7`)
- `STRIPE_PRICE_ID` — default Stripe price ID (fallback); run `pnpm --filter @workspace/scripts run seed-stripe-products` to create all four plans
- `STRIPE_PRICE_ID_LAB_MONTHLY` — Lab plan, monthly billing ($99/mo) — output by seed-stripe-products
- `STRIPE_PRICE_ID_LAB_ANNUAL` — Lab plan, annual billing ($990/yr) — output by seed-stripe-products
- `STRIPE_PRICE_ID_PROVIDER_MONTHLY` — Provider plan, monthly billing ($49/mo) — output by seed-stripe-products
- `STRIPE_PRICE_ID_PROVIDER_ANNUAL` — Provider plan, annual billing ($490/yr) — output by seed-stripe-products
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret (store in Stripe Replit integration connector)
- `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` / `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` — RevenueCat public keys for IAP

## GitHub backup env overrides

See [`github-backup.md`](github-backup.md) for `GITHUB_PUSH_TOKEN`,
`GITHUB_BACKUP_REPO_URL`, `GITHUB_BACKUP_BRANCH`, `GITHUB_BACKUP_CHUNK_SIZE`,
and `GITHUB_BACKUP_TIME_BUDGET_MS`.
