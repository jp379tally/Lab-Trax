Upload option 1 (recommended): labtrax-publish-hotfix-v4-2026-04-27.zip
- Extract into the Replit project root.
- This includes .replit, server/index.ts, server/routes.ts, and server/lib/onedrive.ts.

Then publish again.

What changed in v4:
- Keeps scheduled backups disabled in the deployment web process by default.
- Adds /status and /health readiness endpoints.
- Avoids generating loopback URLs during deployment responses.
- Serves a tiny homepage on Replit's janeway deployment-preview host so publish health checks do not wait on the full landing page or third-party scripts.
- Keeps OneDrive timeout hardening and scheduled-backup safety behavior.

Optional full replacement zip:
- labtrax-source-publish-fix-v4-2026-04-27.zip
