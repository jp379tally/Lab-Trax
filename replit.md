# DriveSync Lab

## Overview

DriveSync Lab is a dental laboratory case management application built with Expo (React Native) for the frontend and Express.js for the backend. It allows dental lab users and administrators to track lab cases through various production stations (intake, design, porcelain, QC, shipping, etc.), manage clients, handle invoicing, and receive notifications. The app supports two user roles: **user** (standard user) and **admin** (administrator), with role-based access to pricing, inventory, and administrative features. Provider-type users get a separate Provider Portal dashboard.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: Expo SDK 54 with React Native 0.81, using expo-router for file-based routing
- **Navigation**: Tab-based layout with 5 main tabs (Dashboard, Cases, Scan, Alerts, Profile) plus a case detail screen (`app/case/[id].tsx`)
- **State Management**: React Context (`lib/app-context.tsx`) provides global app state including cases, clients, users, invoices, notifications, and role management. Data is persisted locally using AsyncStorage.
- **Data Layer**: Sample/seed data defined in `lib/data.ts` with TypeScript types for all domain models (LabCase, Client, LabUser, Invoice, Notification)
- **Styling**: React Native StyleSheet with a centralized color theme in `constants/colors.ts` (light theme only currently defined)
- **Fonts**: Inter font family (400, 500, 600, 700 weights) via `@expo-google-fonts/inter`
- **Key UI Libraries**: expo-haptics for tactile feedback, expo-linear-gradient for gradient backgrounds, expo-image-picker for the scan/intake feature, react-native-gesture-handler, react-native-reanimated for animations

### Backend Architecture
- **Framework**: Express.js v5 running on Node.js with TypeScript (compiled via tsx for dev, esbuild for production)
- **API Pattern**: RESTful routes registered in `server/routes.ts`, prefixed with `/api`
- **Storage**: Currently uses in-memory storage (`server/storage.ts` with `MemStorage` class). The storage interface (`IStorage`) is designed for easy swapping to a database-backed implementation.
- **CORS**: Dynamic CORS configuration supporting Replit development/deployment domains and localhost for Expo web development
- **Static Serving**: In production, the server serves a pre-built Expo web bundle; in development, it proxies to the Expo Metro bundler

### Data Storage
- **Client-side**: AsyncStorage for persistent local state (cases, notifications, settings)
- **Server-side**: In-memory Map-based storage (MemStorage) — designed to be replaced with PostgreSQL via Drizzle ORM
- **Database Schema**: Drizzle ORM schema defined in `shared/schema.ts` with PostgreSQL dialect. Currently only has a `users` table with id, username, and password fields. The Drizzle config expects a `DATABASE_URL` environment variable.
- **Schema Validation**: Zod schemas generated from Drizzle table definitions using `drizzle-zod`

### API Client
- **Data Fetching**: TanStack React Query (v5) configured in `lib/query-client.ts` with a custom `apiRequest` helper that constructs URLs from `EXPO_PUBLIC_DOMAIN` environment variable
- **Fetch**: Uses `expo/fetch` for network requests

### Build & Deployment
- **Development**: Two parallel processes — `expo:dev` for the Expo/Metro bundler and `server:dev` for the Express backend
- **Production Build**: Custom build script (`scripts/build.js`) that bundles the Expo web app, then `esbuild` bundles the server. The production server serves the static Expo build.
- **Database Migrations**: `drizzle-kit push` command configured for schema synchronization

### 3-Portal Architecture
The app has three portals in a hierarchy: Master Admin → Lab Portal / Provider Portal

1. **Master Admin Portal** (userType: `master_admin`)
   - Default user: JPPhillips (password: Master1!, email: john.phillips3@yahoo.com, phone: 850-363-3336)
   - "Control Center" dashboard with gold-themed hero card
   - Full access: Search Groups, All Users, Create Group, Lab Portal Overview, Provider Portal Overview
   - Can add/remove users from groups, create/delete groups
   - Sign out button in header

2. **Lab Portal** (userType: `lab` or default)
   - Admin role: Full access to Admin Master Hub (clients, users, invoices, sales, inventory, shipping, pricing)
   - User role: TechDashboard only, NO admin drawer option, no sales access
   - Admin unlock requires biometric/Face ID authentication

3. **Provider Portal** (userType: `provider`)
   - Admin role: Settings with user management and group creation
   - User role: View own cases, settings menu

### Role-Based Access
- Two roles: `user` (standard user) and `admin` (administrator)
- Admin role requires an additional unlock step (`adminUnlocked` flag) in Lab Portal
- Price information is only visible when role is admin AND admin is unlocked
- Lab users (non-admin role) cannot see the Admin option in the side drawer
- Role switching is available in the Profile tab (Lab Portal only)

### Admin Master Hub Navigation
- Hub → "Clients" group → client-hub (Add Client, Edit Client, Client List, Edit Pricing, Edit Tier Pricing)
- Hub → "Users" group → user-hub (Add User, Edit User with group management)
- Hub → Invoices, Statements, Shipping, Sales, Inventory (direct navigation)

### Inventory Tracking (Admin Only)
- Accessible from Admin Master Hub → Inventory
- Data model: `InventoryItem` (id, name, category, quantity, minQuantity, unit, supplier, lastOrdered, notes)
- Categories: Materials, Supplies, Tools
- Features: Add/edit/remove items, quick +/- quantity adjustment, low stock alerts, category filtering
- Context functions: `addInventoryItem`, `updateInventoryItem`, `removeInventoryItem`

### Provider Portal Dashboard
- Users who sign up as "provider" type see a separate Provider Portal dashboard
- Shows only cases matching the provider's doctor name (filtered by `doctorName` from registration data)
- Active/Completed breakdown, blue-themed hero card
- `userType` stored in auth context ("provider" | "lab"), determines which dashboard renders
- **Settings menu** (gear icon): Change profile picture, change password, sign out
- **Admin section** in settings: Users list (view all users + their groups), Create Group (name, address, type)
- **ChatButton** displayed on Provider Portal header

### Barcode Reader
- Available on Scan tab via "Scan Barcode" button
- Uses expo-camera's CameraView with barcode scanning (QR, Code128, Code39, EAN13, EAN8, UPC-A)
- Scanned barcode data is matched against case IDs/numbers, navigates to case detail if found

### Barcode Assignment System
- `assignedBarcode` field on LabCase model tracks which physical barcode is attached to a case
- After printing a label in scan.tsx, user is prompted to scan a barcode to attach to the case
- Barcode stays assigned until case status reaches COMPLETE, then auto-unassigns
- Context functions: `assignBarcodeToCase`, `unassignBarcode`, `findCaseByBarcode`, `batchLocateCases`
- **Locate by Barcode** (Cases tab): "Use Barcode to Locate Case" button below search box opens scanner, finds case by assigned barcode
- **Batch Locate** (Dashboard): Quick action button scans multiple barcodes, builds list of cases, then user selects a station to batch-move all scanned cases

### Remake Detection Flow
- After duplicate case detected and label printed: "Is this a remake?" → reason selection (Doesn't Fit, Open Margins, Open Contacts, Wrong Shade, Other) → recharge yes/no
- No recharge: case marked isRemake=true, price=0, remakeReason set, auto-invoice removed, case attached to existing invoice
- Recharge: case keeps its own invoice, navigates to chart history
- Context functions: `updateCase`, `removeInvoice`, `attachCaseToInvoice`

### Group-Based Permission System
- Groups identified by practice/lab name + address
- Users auto-assigned to groups on signup based on practice name and address
- Group data model: `Group` (id, name, type, address, members[], createdAt), `GroupMember` (userId, username, role, joinedAt), `GroupInvitation` (id, groupId, groupName, invitedUsername, invitedBy, status, createdAt)
- Admin can add users to groups via invitation flow (Edit User → Group Management)
- Admin can remove users from groups
- Pending group assignments stored in AsyncStorage (`@drivesync_pending_group`) and processed on AppProvider initialization
- Group invitations appear in Notifications tab with Accept/Decline buttons

### Security Features
- **Inactivity Timeout**: 3-minute inactivity timer (`INACTIVITY_TIMEOUT_MS = 180000ms`) managed in `lib/auth-context.tsx`
- **Lock Screen**: `components/LockScreen.tsx` displayed when session is locked
- **Unlock Methods**: Biometric authentication (Face ID / Fingerprint) or password entry
- **Touch Detection**: `PanResponder` in root layout (`app/_layout.tsx`) resets inactivity timer on any user interaction
- **AppState Monitoring**: Timer adjusts when app goes to background/foreground
- **Optional Face ID**: Face ID is NOT auto-prompted on login; users manually tap a biometric button to authenticate
- **Change Password**: Available in Profile → Credentials section, validates current password, enforces password complexity (8+ chars, uppercase, lowercase, special char)

### Global Chat System
- **ChatButton component** (`components/ChatButton.tsx`): Shared component displayed on Dashboard, Cases, Notifications, Profile, and Case Detail pages
- Provides access to conversations list and chat threads with unread badge count
- Uses `useApp` context for conversations, chatMessages, sendChatMessage, markConversationRead, totalUnreadMessages

### Courtesy Text Feature
- Available on case detail page via amber "Courtesy Text" button
- Auto-populates delay notification: "Hello Dr. [name], this is a courtesy text to inform you that patient [name] has a case that was delayed in production..."
- **Negotiation flow**: Client responds yes/no for updated delivery date → Lab admin proposes date/time → Client accepts/declines → Loop until accepted
- Data model: `CourtesyTextRequest` (id, caseId, message, sentBy, sentAt, status, wantsUpdatedDate, proposedDate, proposedTime, responseHistory[])
- All communication auto-documented in case activity log as `courtesy_text` type entries
- Statuses: sent → date_requested → date_proposed → accepted (or back to date_requested if declined)
- Context functions: `sendCourtesyText`, `respondToCourtesyText`, `proposeDeliveryDate`, `respondToProposedDate`

### Profile Groups Display
- Under CREDENTIALS section in Profile tab, displays all groups the user belongs to
- Shows group name with type badge (Provider/Lab) and colored dot indicator

### Provider Account Numbers
- Providers auto-assigned account numbers in YY-N format (e.g., 26-1, 26-2) on registration
- Counter tracked in AsyncStorage (`@drivesync_provider_counter`) as `{ year, count }`
- Year resets count to 1 when a new calendar year begins
- Lab users still get `DS-XXXXXX` format account numbers
- Newly registered providers auto-populate in lab's doctor dropdown as "Dr. [Name] ([YY-N])"
- Pending client data saved to AsyncStorage (`@drivesync_pending_client`) before registration completes

### Shade Selection
- Shade field on new case form is a dropdown (not free text)
- Options: A2, A3, A3.5, A4, B1, B2, B3, B4, C1, C2, C3, C4, D2, D3, D4, 0M1, 0M2, 0M3, BL1, BL2, BL3, Custom, Other

### Case Workflow
Cases follow a production pipeline through stations: INTAKE → DESIGN → WAX → INVEST → CAST → FINISH → PORCELAIN → GLAZE → QC → SHIP → COMPLETE (with HOLD as a special status). Each station transition is recorded in a `routeHistory` array with timestamps.

## External Dependencies

### Database
- **PostgreSQL**: Configured via Drizzle ORM but not yet actively used for app data. The `DATABASE_URL` environment variable must be set for Drizzle to work. Currently the app runs on in-memory storage and AsyncStorage.

### Key NPM Packages
- **expo** (~54.0.27): Core framework for cross-platform mobile/web development
- **express** (^5.0.1): Backend HTTP server
- **drizzle-orm** (^0.39.3) + **drizzle-kit**: Database ORM and migration tooling for PostgreSQL
- **@tanstack/react-query** (^5.83.0): Server state management and data fetching
- **pg** (^8.16.3): PostgreSQL client driver
- **zod** + **drizzle-zod**: Runtime schema validation

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (required for Drizzle)
- `REPLIT_DEV_DOMAIN`: Replit development domain (used for CORS and API URL construction)
- `EXPO_PUBLIC_DOMAIN`: Public domain for API requests from the client
- `REPLIT_INTERNAL_APP_DOMAIN`: Replit deployment domain (used in production builds)