# LabTrax Mobile — Release Notes

<!--
  HOW TO USE THIS FILE
  ====================
  - This file is the in-repo, full changelog for the LabTrax mobile app.
  - The "App Store Connect — What's New" block at the top is the trimmed,
    customer-friendly copy to paste into the "What's New in This Version"
    field in App Store Connect for each submission.
  - The fuller, area-grouped list below it is for the team's reference.
-->

## App Store Connect — What's New (v1.0.9, build 152)

This update is a big one, with improvements across the whole app:

- Unified case timeline with photos, videos, and notes, plus progress bars
  and a days-remaining / overdue countdown.
- Automatic QR code on every case, smoother barcode scanning, and manual
  barcode entry.
- A context-aware AI assistant — ask questions about any case, get more
  accurate handwritten Rx reading, and preview smile whitening & straightening.
- New Messages tab with a real-time inbox, chat, and file/image attachments.
- Smarter invoicing: nested sub-items with subtotals, send by email or SMS,
  and overhauled statements.
- More reliable media uploads with a crash-safe offline queue, faster loading,
  and sturdier syncing between mobile and desktop.

Thanks for using LabTrax!

---

## v1.0.9 (build 152) — full changelog (since build 103)

### Cases & tracking
- Unified case-history timeline showing photos, videos, notes, and always the creation date.
- Progress bars with a days-remaining / overdue countdown across mobile and desktop.
- Automatic QR code on every case (desktop, mobile, and the invoice PDF).
- Pan barcode assignment and lookup, manual barcode entry on all platforms, and a smoother scanner.
- Multi-page Rx capture for AI intake.
- Editable expected delivery date, plus provider delivery-date requests with lab accept/counter.
- View mobile-created cases on desktop and desktop cases on mobile, with cross-platform sync fixes.
- Add photos, videos, and notes to desktop-created cases from mobile.
- Faster case creation and customizable case/print layouts with custom image uploads.

### AI assistant
- Context-aware AI assistant on mobile and desktop, with "Ask AI" on the case list and case detail.
- Multi-case AI chat context, persistent chat history, and cost rate-limiting.
- More accurate handwritten Rx reading.
- AI smile whitening & straightening preview.
- Same-material AI Rx restorations grouped into one invoice line item.

### Messaging
- New Messages tab with a real-time inbox and chat on mobile.
- File and image attachments in chat.
- Push notifications for new messages.

### Invoicing & finance
- Nested invoice sub-items with group subtotals on screen and in PDFs.
- Send invoices by email or SMS.
- Bank register upgrades: inline date editing, sticky/day-group date headers, and undo for blank rows.
- Vendor/employee links on transactions and recurring rules, plus merge duplicate payees.
- Lists management (Vendors, Employees, Items, Categories) with CSV import/export.
- Invoice layout presets: apply, duplicate, preview, and per-invoice selection.
- Statement generation overhauled to match desktop, with period notes and due dates.

### Communications
- SMS and email communication preference toggles.
- Phone numbers auto-formatted with +1 and extensions.
- Admin system-alert notification toggles.

### Reliability & backups
- Backups stream directly to users for local, network (UNC/SMB), and scheduled runs.
- Crash-safe offline upload queue for mobile media and notes.
- Sturdier database connection handling and faster startup.
- Faster load via code splitting / lazy loading.
- Removed the legacy OneDrive integration.
