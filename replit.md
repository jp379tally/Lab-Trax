# LabTrax

## Overview

LabTrax is a comprehensive dental laboratory case management application designed to streamline operations for dental labs and provide a dedicated portal for dental providers. Its core purpose is to track dental lab cases through various production stages, manage clients, handle invoicing, and facilitate communication via notifications and a global chat system. The application supports role-based access for standard users, administrators, and providers, offering tailored functionalities such as inventory tracking, client management, and detailed case workflow visualization. The business vision is to enhance efficiency, transparency, and communication within the dental lab ecosystem, ultimately improving service delivery and client satisfaction.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: Expo SDK 54 with React Native 0.81, using `expo-router` for file-based routing.
- **Navigation**: Tab-based layouts for lab users (5 tabs) and providers (4 tabs), with a dedicated case detail screen. On desktop web (viewport >= 768px), a custom `DesktopSidebar` component replaces the bottom tab bar with a left sidebar navigation (220px wide) featuring LabTrax branding. The `isDesktop` pattern (`Platform.OS === "web" && windowWidth >= 768`) is used across all screens to adjust padding and layout for full-screen desktop use.
- **State Management**: React Context for global state, persisted locally with AsyncStorage.
- **Styling**: React Native StyleSheet with a centralized color theme.
- **Data Fetching**: TanStack React Query for server state management and data fetching.
- **Auth**: JWT tokens (access + refresh) stored via AsyncStorage, injected as Bearer headers on all API requests via `lib/query-client.ts`.

### Backend
- **Framework**: Express.js v5 on Node.js with TypeScript.
- **API Pattern**: RESTful API under `/api`.
- **Authentication**: JWT-based (15m access tokens, 7d refresh tokens). Sessions stored in `user_sessions` DB table. Middleware: `server/middleware/auth.ts` (requireAuth/optionalAuth).
- **Password Security**: bcrypt hashing (12 rounds). Legacy plain-text passwords auto-upgraded to bcrypt on first login.
- **RBAC**: Organization membership-based roles (owner, admin, user, billing, read_only). Guards in `server/lib/rbac.ts`.
- **Audit Logging**: All significant actions logged to `audit_logs` table via `server/lib/audit.ts`.
- **CORS**: Dynamically configured for Replit and local development. Allows `Authorization` header.
- **Static Serving**: Serves pre-built Expo web bundle in production.
- **Landing Page**: Full-featured marketing page at `server/templates/landing-page.html` with Inter font, feature grid (9 cards), workflow steps, QR code for mobile, and compliance section. Placeholders replaced at serve time: `APP_NAME_PLACEHOLDER`, `EXPS_URL_PLACEHOLDER`, `BASE_URL_PLACEHOLDER`.

### Data Storage
- **Server-side**: PostgreSQL via Drizzle ORM.
- **Client-side**: AsyncStorage for local persistence.
- **Database Schema**: Defined using Drizzle ORM with Zod schemas in `shared/schema.ts`.

### Database Tables
- **Core**: `users`, `user_sessions`
- **Lab Management**: `organizations`, `lab_memberships` (labId, userId, role, status), `join_requests` (labId, userId, requestedRole), `lab_invites` (labId, invitedUserId, invitedPhone, role), `organization_connections`, `notifications` (userId, type, title, body, dataJson)
- **Cases (Normalized)**: `cases`, `case_restorations`, `case_events`, `case_notes`, `case_attachments`, `case_locations`, `case_submission_queue`
- **Invoices**: `invoices`, `invoice_line_items`, `payments`
- **Audit**: `audit_logs`
- **Legacy**: `lab_cases` (JSON blob storage, still used by frontend app-context), `chat_conversations`, `chat_messages`
- **Membership & Requests**: `lab_memberships`, `join_requests`, `lab_invites`, `notifications`

### Admin Backup
- **Local Backup Endpoint**: `GET /api/admin/backup` — admin-only. Streams a ZIP archive (v2.0) containing: `manifest.json`, and JSON exports of ALL 11 database tables: `users` (no passwords), `lab_cases`, `organizations`, `memberships`, `join_requests`, `invites`, `invoices`, `invoice_line_items`, `payments`, `audit_logs`, `notifications`, plus all `uploads/case-media/` files.
- **OneDrive Backup Endpoint**: `POST /api/admin/backup/onedrive` — admin-only. Generates the same full ZIP in-memory, uploads to the connected Microsoft OneDrive account via the Replit OneDrive connector (`ccfg_onedrive_default_org_up4ad9`). Uses `server/lib/onedrive.ts` which calls Microsoft Graph API directly with OAuth tokens via Replit connector proxy. Supports simple upload (≤4 MB) and chunked upload sessions (5 MB chunks). Files land in "LabTrax Backups" folder on OneDrive. Filename includes timestamp (not just date) so each backup is retained separately.
- **Nightly Server-Side Scheduler**: `server/index.ts` schedules an automatic OneDrive backup 2 minutes after server start, then every 24 hours — runs whether or not any user has the app open. Logs `[Nightly Backup] Success/Failed` to server console. Shared backup logic via `gatherBackupData()` and `buildBackupArchive()` helpers in `server/routes.ts`.
- **Client UI**: Accessible from Admin Vault → "Backup Data". Two buttons: "Local / Thumb Drive" (share sheet on mobile, file download on web) and "Save to OneDrive" (blue Microsoft button). After a successful OneDrive upload, a tappable success card shows the filename and links directly to the file in OneDrive. Shows what's included, HIPAA security note, and last backup timestamp.
- **Package**: Uses `archiver` npm package for ZIP stream generation on the server.

### Key Features and Design Patterns
- **3-Portal Architecture**: Differentiated access for Master Admin, Lab Portal, and Provider Portal based on `userType`.
- **Role-Based Access**: `user`, `admin` roles with additional `adminUnlocked` state for sensitive actions.
- **Case Workflow**: Tracks cases through predefined stations (INTAKE, DESIGN, etc.) with `routeHistory`.
- **Barcode System**: Supports scanning for case intake, location, and batch processing.
- **Remake Detection**: Specific flow for identifying and managing remakes.
- **Lab-Based Membership & Sharing**: Users belong to a lab based on server-side `lab_memberships`. Cases are synced between local storage and server for all lab members. **Important**: The automatic case deletion that previously fired whenever `activeLabAffiliationKey` transitioned to null (including on server restarts or network errors) has been removed. Case cleanup now ONLY happens inside `leaveLab()` (explicit user-initiated action). The `.catch()` handler in `syncActiveLabAffiliationState` no longer clears membership state on network errors — it keeps the current state and retries on the next interval. Join requests are persisted server-side via the `join_requests` DB table (with optional `message` field). New lab users auto-create an `organizations` record on registration. Users joining an existing lab send a server-side join request. The server automatically syncs `practiceName`, `practiceAddress`, `practicePhone`, and `role` on the `users` table whenever: org is created (owner sync), org is updated (all members sync), join request approved (requester sync), invite accepted (user sync), membership removed (profile cleared). This ensures correct multi-device display without relying on local state.
- **Multi-Device Sync**: `fetchServerJoinRequestsAndInvites` uses `/api/auth/me` to get memberships directly (not fragile `practiceName` matching). Admins see pending join requests for any lab they own/admin. Settings "Add Lab" search uses `/api/labs/groups` API (not local state). `GET /api/labs/groups` correctly counts members via `labId` (not `organizationId`) column.
- **Join Request Idempotency**: The approve and reject endpoints are fully idempotent. Approve: if already approved → returns existing membership (200 OK); if non-pending/non-approved → 409. Reject: if already rejected → returns the request unchanged (200 OK); if non-pending/non-rejected → 409. DB constraint: old `join_requests_lab_user_status_unique` index on `(lab_id, user_id, status)` replaced by a partial unique index `join_requests_pending_unique` on `(lab_id, user_id) WHERE status = 'pending'` — allows multiple historical rows but enforces only one pending request per pair. Startup migration deduplicates any existing duplicate pending rows before creating the index.
- **iOS Native Bundle Safety**: `lib/pdfToImages.ts` (base stub), `lib/pdfToImages.native.ts` (stub), and `lib/pdfToImages.web.ts` (real pdfjs-dist implementation) implement platform-specific PDF conversion. `metro.config.cjs` blocks all pdfjs-dist imports on native builds via two layers: (1) module name check (`"pdfjs-dist"` and all `"pdfjs-dist/*"` sub-paths), (2) origin module path check — any static import originating from within `node_modules/pdfjs-dist` is also blocked, preventing pdfjs-dist's internal `import("https")`, `import("url")` from reaching the native Hermes bundle.
- **Data Isolation (HIPAA)**: Cases filtered by lab membership.
- **Client Management**: Admins can delete or deactivate clients, with safeguards for open invoices.
- **Duplicate Registration Prevention**: Checks for existing accounts by email, phone, and address during sign-up.
- **Security**: Inactivity timeouts, biometric/password lock screens, robust password recovery via email (with optional SMTP configuration).
- **Work Status**: Persistent per-user work status ("available", "break", "out_of_office") stored in the `work_status` column on the `users` table. Saved via `PATCH /api/auth/me/status`. Displayed as colored dots in the chat conversation list and thread header. Profile tab allows the user to change their own status (saved immediately to server). Status is initialized from `registeredUsers` hydration data on app load.
- **Lab Channel Chat**: Group chat channel scoped to each lab. The `GET /api/legacy/chat` endpoint includes a `lab:<orgId>` thread for each of the user's active org memberships, pinned at the top of the conversation list. Sending to a lab channel uses `POST /api/legacy/chat/send` with `labChannelId` parameter; the server resolves all active org members as participants and stores messages under the channel thread. Lab channels are visually distinct (blue chatbubbles icon, "CHANNEL" badge) and non-deletable via swipe. Sender names are shown for messages from others in the group thread.
- **Case Pull-to-Refresh (Full Sync)**: `fullRefreshCases()` in `app-context.tsx` fully replaces `allCases` from the server response (rather than merging). The pull-to-refresh on the Cases tab and the web refresh button both call `fullRefreshCases()` to ensure stale cases are cleared.
- **Global Chat System**: Real-time messaging with unread indicators (DM and lab channel).
- **Courtesy Text Feature**: Automates delay notifications and delivery date negotiations.
- **Inventory Tracking**: Manage items, categories, quantities, and low-stock alerts.
- **Provider Account Numbers**: Automated assignment of unique IDs.
- **File Drop Zone**: Dashboard bar where lab members can drag & drop or tap to upload patient files (photos/screenshots/videos). Admins see pending file count and can open a review modal to assign files to cases via provider → patient autocomplete flow. Files stored per-user in AsyncStorage (`components/LabFileDropZone.tsx`). 5MB limit per file. Uses `addCasePhoto` to attach to cases.
- **Invoices Hub**: Centralized management for viewing, generating, and sending invoices. Admins can directly edit invoices.
  - **Edit Invoice** (`renderEditInvoice`, `AdminView: "edit-invoice"`): QBO-style full-screen editor. Editable header (Bill To/Provider autocomplete, Patient Name, Case Type, Teeth, Shade, Case Notes/Memo). Line items table with per-row Qty/Item/Description/Rate inputs; Amount auto-calculates as Qty×Rate; rows can be added or deleted. Credits/Payments Applied field; Balance Due = Subtotal − Credits. Save & Close calls `updateInvoice(Partial<Invoice>)` and recalculates `invoice.amount`; Cancel returns to detail view without saving. Invoice # and Date are read-only. All changes reflected in statements. **Provider Reassignment**: "Bill To / Provider" field is a live autocomplete — typing filters the clients list by practice name, lead doctor, or additional providers; selecting a result updates `clientId`, `clientName`, and `billTo` on save. A green checkmark and "Assigned to: …" confirmation appear when a provider is matched.
- **Financial Hub (QB-Style)** — Enhanced QB-style dashboard with 3-metric hero card (AR, Overdue, Collected YTD). 8 navigation items including all new reports below.
  - **Receive Payment** (`renderReceivePayment`, `AdminView: "receive-payment"`): QB "Receive Payment" flow. Lists clients with open balances; select client → view open invoices with checkboxes; "Select All" shortcut; payment method pills (Check, ACH, Credit Card, Cash, Wire Transfer, Zelle); Reference # field; Amount auto-fills to selected total (editable); Save applies payment to selected invoices via `updateInvoice({ status: "paid", credits })`.
  - **A/R Aging Summary** (`renderARAgingReport`, `AdminView: "ar-aging"`): Full aging matrix table. Buckets: Current (0–30), 31–60, 61–90, 90+ days from `dueAt`. Rows sorted by oldest first. Grand total row, mini summary tiles per bucket. Empty state "All Caught Up".
  - **P&L Report** (`renderPLReport`, `AdminView: "pl-report"`): Period selector (MTD/QTD/YTD/Custom with date inputs). Income section: Total Billed, Credits/Memos, Net Revenue. Collections section: Collected, Outstanding AR, Collection Rate %. Monthly breakdown bar chart (dual bar: billed vs collected). Expense tracking placeholder note.
  - **Sales by Item** (`renderSalesByItem`, `AdminView: "sales-by-item"`): Aggregates all `lineItems` across all invoices by item name. Columns: Item/Service, Qty, Amount, % of total. Progress bars per row. Grand total footer. Sorted by revenue descending.
- **Statements Hub**: Centralized management for generating, viewing, and sending client statements.
- **AI Integration**:
    - **Prescription Scanning**: Uses GPT-5.1 vision to extract data from dental prescriptions, with client-side image compression. On web/desktop, camera is replaced with "Upload RX" file picker (supports JPG, PNG, PDF, HEIC, TIFF, BMP, WebP); camera remains on mobile. PDFs are converted client-side to PNG images via `pdfjs-dist` (CDN worker) before sending to OpenAI vision API. **Auto-add provider on "No"**: When a scanned prescription detects a doctor not in the provider list and the user dismisses the "Would you like to add them?" prompt with "No", the provider is still automatically added to the provider/client list with the scanned name, practice, address, and phone (tier "Standard", discountRate 0). Choosing "Yes" opens the full editable add-provider form.
    - **Document Scanning**: Uses GPT-5.1 vision and `sharp` to detect and crop document boundaries, correct rotation, and enhance quality.
    - **PDF Generation**: Converts scanned images into multi-page PDFs.
    - **Smile Preview**: AI-powered feature for teeth whitening and symmetry restoration using OpenAI's gpt-image-1 model.
    - **AI Proxy**: Replit AI integration proxy at `localhost:1106/modelfarm/openai`. The OpenAI SDK uses `/chat/completions` (NOT `/v1/chat/completions`) from that base URL. Use `max_completion_tokens` (not `max_tokens`) with gpt-5.x models.
- **App Store Readiness**: Includes required permission descriptions, privacy policy/terms of service, and secure account deletion.
- **Registration**: Collects detailed address and license number.
- **Case Management Enhancements**: Features like "Locate Case," "Reprint Lab Slip," and barcode assignment flows.

## Server Route Modules

- `server/routes/auth.ts` — Register (with optional org creation/join), login (JWT), refresh, logout, /me, user CRUD (profile update allows lab admins to update same-lab members), password change, lab-creator check, delete-lab
- `server/routes/organizations.ts` — CRUD orgs, members, invites, join requests, connections (all require JWT auth)
- `server/routes.ts` — Composes all route modules + legacy endpoints + AI/utility/SMS routes; public `GET /api/labs/groups` endpoint (no auth)
- `server/routes/cases.ts` — Normalized case CRUD with restorations, notes, events, locations, submissions (all require JWT auth)
- `server/routes/invoices.ts` — Generate from case restorations, CRUD, payments, sales reports (all require JWT auth)

## Server Utility Modules

- `server/lib/http.ts` — HttpError class, ok() response helper
- `server/lib/crypto.ts` — bcrypt hash/verify, random token generation
- `server/lib/auth.ts` — JWT sign/verify, Bearer token extraction, invite tokens
- `server/lib/audit.ts` — writeAuditLog to DB
- `server/lib/rbac.ts` — Organization membership checks, role guards (ADMIN_ROLES, BILLING_ROLES)
- `server/lib/case.ts` — Line total calculation, money summation
- `server/middleware/async-handler.ts` — Express async error wrapper
- `server/middleware/auth.ts` — requireAuth/optionalAuth JWT middleware

## External Dependencies

### Database
- **PostgreSQL**: Primary data store, managed with Drizzle ORM.

### Key NPM Packages
- **expo**: Core framework.
- **express**: Backend HTTP server.
- **drizzle-orm** & **drizzle-kit**: ORM for database.
- **@tanstack/react-query**: Server state management.
- **pg**: PostgreSQL client.
- **zod** & **drizzle-zod**: Schema validation.
- **sharp**: Server-side image processing.
- **jsonwebtoken**: JWT token signing/verification.
- **bcryptjs**: Password hashing.

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: Secret for JWT signing (has dev fallback, must be set in production).
- `REPLIT_DEV_DOMAIN`: Replit dev domain.
- `EXPO_PUBLIC_DOMAIN`: Public domain for client API.
- `REPLIT_INTERNAL_APP_DOMAIN`: Replit deployment domain.
- SMTP credentials (optional): `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_FROM` for email recovery.
- Twilio credentials (optional): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` for SMS.

### API Proxy (Development)
- **Metro proxy**: Configures Expo dev server to proxy `/api` requests to Express backend.

### AI Services
- **OpenAI API**: Used for GPT-5.1 vision (prescription and document scanning), chat (gpt-5.1), and gpt-image-1 (smile preview). All accessed via Replit AI integration proxy at `localhost:1106/modelfarm/openai`. Note: use `max_completion_tokens` (not `max_tokens`) with gpt-5.x models.

## Per-Provider Contact Info
- `ProviderContact` interface in `lib/data.ts`: `{ name, email?, phone?, address? }`
- `Client.providerContacts?: ProviderContact[]` — indexed to match `leadDoctor` (0) and `additionalProviders` (1+)
- Edit Provider form: each provider (lead + up to 5 additional) gets its own card with name, email, phone, address fields
- Statement generation (`generatePreviewForClients`): multi-provider practices produce one statement per doctor; per-provider contact info overrides practice-level fallback; invoices matched to doctor via `caseIds → cases.doctorName`
- "Clients" renamed to "Providers" throughout admin UI; "Add Client" → "Add Provider"; "Edit Client" → "Edit Provider"

## Appliance Subcategories & Pricing
- Appliance case type in the add-item modal (`app/case/[id].tsx`) uses a multi-step wizard:
  1. **Type**: Night Guard | Retainer | Snore Guard | Sports Guard
  2. **Arch** (Night Guard & Retainer only): Upper | Lower | Both — "Both" creates 2 invoice line items
  3. **Variant**: Night Guard → Hard / Soft / Hard-Soft; Retainer → Hawley / Hard / Lingual
  - Snore Guard and Sports Guard skip arch/variant and add directly (1 line item each)
- 8 new pricing keys in `lib/data.ts` (`DEFAULT_TIER_ITEMS` + `DEFAULT_PRICING_TIERS`): `night_guard_hard`, `night_guard_soft`, `night_guard_hard_soft`, `retainer_hawley`, `retainer_hard`, `retainer_lingual`, `snore_guard`, `sports_guard`
- Price lookup priority: client `customPricing[key]` > tier `prices[key]`; helpers `getAppliancePriceKey()`, `getApplianceUnitPrice()`, `addApplianceToInvoice()` in `case/[id].tsx`
- Admin pricing editor in the Providers/Clients tab automatically shows the new keys (no code change needed there)

## Version Info
- **Version**: 1.0.7, build **52**
- **Safe area**: All admin screens use `paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16`
- **ESM config files**: All CommonJS config files must use `.cjs` extension
- **Web app**: `static-build/` serves Expo web export; `baseUrl: "/app"` in app.json
