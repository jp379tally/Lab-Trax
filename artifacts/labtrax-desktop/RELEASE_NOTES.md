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

## v1.0.5

- Stats dashboard: export cases to CSV or PDF for your accountant, plus per-material and per-case revenue metrics and an owner/admin Remakes section.
- Sales Forecaster (owner-only) with a sales-pace trend indicator and average daily revenue.
- Invoices: added a "$0 balance" status filter, column totals shown at the top of every amount column, and filters/bulk actions now stay visible while scrolling.
- Shift-click to select a range of rows on the Cases page and the bulk invoice lists.
- Statements: per-row Download PDF and Resend actions, resend a statement to a different email address, and a "last emailed" indicator.
- Customer Center: new tabs on the account slide-in window, merging of legacy/providerless doctor names, and the ability to dismiss duplicate-doctor suggestions.
- Case photos: fixed viewing through the Electron media bridge, and mobile-uploaded documents that were previously unopenable now open on desktop.
- Maynard AI assistant: resume voice mode where you left off, turn voice mode off without resuming first, mic fixes on desktop web, and clearer error handling.
- New case content (photos, videos, files, notes) now defaults to Lab Only.
- Case deletion and admin PIN reset now use email verification instead of SMS.

## v1.0.3

- Barcode field in AI intake panel: scan or type a case pan barcode when creating a case from an Rx.
- Autocomplete comboboxes for doctor and provider search in the AI intake form.
- Practice-matching banner: the intake panel now highlights when a matched practice is found.
- Continuous integration: desktop builds now publish automatically after every code merge touching desktop-relevant files.

## v1.0.2

- Incremental bugfixes and dependency updates.

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
