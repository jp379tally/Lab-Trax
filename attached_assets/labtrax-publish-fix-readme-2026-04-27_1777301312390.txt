LabTrax publish fix package

Primary file:
Upload labtrax-source-publish-fix-2026-04-27.zip to the Replit project root and extract it there.

Smaller alternative:
Upload labtrax-publish-hotfix-2026-04-27.zip and extract it into the Replit project root.

After extracting, publish again.

What changed:
- Production web server no longer starts scheduled backups by default during publish.
- First backup is delayed when explicitly enabled.
- OneDrive auth/upload calls now fail fast instead of hanging longer.
- Local backup success is preserved even when remote OneDrive upload fails.

If you later want scheduled backups running inside the web server anyway, set:
LABTRAX_ENABLE_SCHEDULED_BACKUPS=true

Optional tuning vars:
LABTRAX_BACKUP_INITIAL_DELAY_MS
LABTRAX_ONEDRIVE_CONNECTOR_TIMEOUT_MS
LABTRAX_ONEDRIVE_GRAPH_TIMEOUT_MS
