Upload option 1 (recommended): labtrax-publish-hotfix-v3-2026-04-27.zip
- Extract into the Replit project root.
- This includes .replit, server/index.ts, server/routes.ts, and server/lib/onedrive.ts.

Then publish again.

What changed in v3:
- Keeps scheduled backups disabled in the deployment web process by default.
- Adds /status and /health readiness endpoints.
- Avoids generating 127.0.0.1 URLs during deployment health checks.
- Keeps OneDrive timeout hardening and scheduled-backup safety behavior.

Optional full replacement zip:
- labtrax-source-publish-fix-v3-2026-04-27.zip
