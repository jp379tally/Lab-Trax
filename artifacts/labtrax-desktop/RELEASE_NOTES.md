# LabTrax Desktop Release Notes

<!--
  HOW TO ADD A NEW ENTRY BEFORE EACH RELEASE
  ============================================
  1. Add a new H2 heading in the form "## vX.Y.Z" at the TOP of the entries
     section below (keep the most-recent version first).
  2. Write bullet points describing what changed. Plain text only — no nested
     headings or HTML.
  3. Commit the file with the release. The build and upload pipeline reads
     this file automatically and populates the in-app download page.

  FORMAT RULES
  ============
  - Heading MUST be exactly "## vX.Y.Z" — two hashes, a space, then a "v"
    followed by a semver version number (e.g. "## v1.2.0").
  - Each version block ends when the next "## v" heading begins (or at the
    end of the file).
  - Leading/trailing blank lines within a block are stripped automatically.
  - Keep individual entries concise — one bullet point per change.
-->

## v1.0.1

- Added an in-app signup flow so new labs can create an account from the desktop client.
- New Check-for-updates UI with auto-release support: see when an update is available, downloading, or ready, and restart to install.
- Added admin PIN entry as an alternative to the full platform-admin secret.
- Added a Lab Slip tab for printing case slips.
- Added a manual refresh control to pull the latest cases on demand.
- More graceful handling of network drops with clearer error messaging.
- Refreshed branding and application icon.
- Added desktop push notifications for new messages.

## v1.0.0

- Initial release of LabTrax Desktop for Windows and macOS.
- Case tracking with full attachment and media support.
- AI-assisted Rx import from the iTero Lab Review queue.
- Offline-capable desktop client with automatic update notifications.
