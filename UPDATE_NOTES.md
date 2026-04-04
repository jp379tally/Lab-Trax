# LabTrax - Build Update Notes

**Version:** 1.0.3
**Build:** 31
**Date:** April 4, 2026

---

### New Features

#### Client Deletion & Deactivation (Admin)
- **Delete Client Button** — A new "Delete Client" button has been added to the bottom of the Edit Client page, available to lab admin users.
- **Open Invoice Warning** — When deleting a client that has open or overdue invoices, the system displays a warning modal with three options:
  - **Make Inactive** — Moves the client to inactive status, preserving all data and invoices. The client is removed from the active client list but can be reactivated at any time.
  - **Delete Anyway** — Permanently removes the client. Any open invoices are archived and moved to the Deleted Client Invoices section.
  - **Cancel** — Dismisses without any changes.
- **Clients without open invoices** receive a simple delete confirmation prompt.

#### Inactive Clients List (Admin Master Hub)
- New "Inactive Clients" section added to the Admin Master Hub menu.
- Displays all clients that have been set to inactive status with their practice name, lead doctor, account number, and any remaining open balance.
- Each inactive client has a **Reactivate Client** button to restore them to active status.
- Inactive clients are filtered out of the main Clients list and the Edit Client selection, keeping the active workspace clean.

#### Deleted Client Invoices Archive (Admin Master Hub)
- New "Deleted Client Invoices" section added to the Admin Master Hub menu.
- Displays all open/overdue invoices that were preserved when a client was deleted.
- Shows the total archived amount at the top along with a note confirming these amounts are excluded from sales and open invoice totals.
- Each archived invoice shows the invoice number, amount, original client name, patient name, status, deletion date, and line item details.

#### Financial Reporting Exclusion
- Open invoices from deleted clients are automatically excluded from:
  - Monthly sales calculations
  - Open invoice count on the Master Hub
  - Client hub open balance totals
- This ensures accurate financial reporting without losing historical records.

---

### Bug Fixes

#### Lab Case Sharing Fix
- Fixed an issue where newly accepted lab members could not see shared cases until the app was restarted.
- After an admin accepts a lab join request, the user list now refreshes immediately so both the admin and the new member see shared cases right away.
- Added background sync (every 30 seconds) so the newly accepted user's app also picks up their updated lab membership automatically.

#### Alerts Tab Crash Fix
- Resolved a crash on the Alerts/Notifications tab caused by references to removed group invitation functions.

#### TestFlight Crash Fix
- Fixed a crash on app launch by removing incompatible NativeTabs and expo-glass-effect imports.

#### Settings Screen Updates
- Added STATUS section with 5 status options (Active, Inactive, On Lunch, Out of Office, On Break) persisted locally.
- Added ACCOUNT section with Change Password modal including validation and success animation.
- Fixed "GROUP" label to correctly display "LAB".

---

### Technical Notes
- Invoice-client matching now uses both `clientId` and `clientName/practiceName` to ensure all invoices are correctly identified regardless of how they were originally linked.
- Archived invoices are persisted in AsyncStorage under a dedicated key and survive app restarts.
- The `Client` data type now includes an optional `status` field ("active" or "inactive"), defaulting to active for all existing clients.
