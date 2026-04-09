# LabTrax

## Overview

LabTrax is a comprehensive dental laboratory case management application designed to streamline operations for dental labs and provide a dedicated portal for dental providers. Its core purpose is to track dental lab cases through various production stages, manage clients, handle invoicing, and facilitate communication via notifications and a global chat system. The application supports role-based access for standard users, administrators, and providers, offering tailored functionalities such as inventory tracking, client management, and detailed case workflow visualization. The business vision is to enhance efficiency, transparency, and communication within the dental lab ecosystem, ultimately improving service delivery and client satisfaction.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: Expo SDK 54 with React Native 0.81, using `expo-router` for file-based routing.
- **Navigation**: Tab-based layouts for lab users (5 tabs) and providers (4 tabs), with a dedicated case detail screen.
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
- **Organizations**: `organizations`, `organization_memberships`, `organization_join_requests`, `organization_invites`, `organization_connections`
- **Cases (Normalized)**: `cases`, `case_restorations`, `case_events`, `case_notes`, `case_attachments`, `case_locations`, `case_submission_queue`
- **Invoices**: `invoices`, `invoice_line_items`, `payments`
- **Audit**: `audit_logs`
- **Legacy**: `lab_cases` (JSON blob storage, still used by frontend app-context), `chat_conversations`, `chat_messages`

### Key Features and Design Patterns
- **3-Portal Architecture**: Differentiated access for Master Admin, Lab Portal, and Provider Portal based on `userType`.
- **Role-Based Access**: `user`, `admin` roles with additional `adminUnlocked` state for sensitive actions.
- **Case Workflow**: Tracks cases through predefined stations (INTAKE, DESIGN, etc.) with `routeHistory`.
- **Barcode System**: Supports scanning for case intake, location, and batch processing.
- **Remake Detection**: Specific flow for identifying and managing remakes.
- **Lab-Based Membership & Sharing**: Users belong to a lab based on `practiceName`, enabling shared case visibility and join requests. Cases are synced between local storage and server for all lab members. Join requests are persisted server-side via the `organization_join_requests` DB table. New lab users auto-create an `organizations` record on registration. Users joining an existing lab send a server-side join request during signup.
- **Data Isolation (HIPAA)**: Cases filtered by lab membership.
- **Client Management**: Admins can delete or deactivate clients, with safeguards for open invoices.
- **Duplicate Registration Prevention**: Checks for existing accounts by email, phone, and address during sign-up.
- **Security**: Inactivity timeouts, biometric/password lock screens, robust password recovery via email (with optional SMTP configuration).
- **Global Chat System**: Real-time messaging with unread indicators.
- **Courtesy Text Feature**: Automates delay notifications and delivery date negotiations.
- **Inventory Tracking**: Manage items, categories, quantities, and low-stock alerts.
- **Provider Account Numbers**: Automated assignment of unique IDs.
- **File Drop Zone**: Dashboard bar where lab members can drag & drop or tap to upload patient files (photos/screenshots/videos). Admins see pending file count and can open a review modal to assign files to cases via provider → patient autocomplete flow. Files stored per-user in AsyncStorage (`components/LabFileDropZone.tsx`). 5MB limit per file. Uses `addCasePhoto` to attach to cases.
- **Invoices Hub**: Centralized management for viewing, generating, and sending invoices. Admins can directly edit invoices.
- **Statements Hub**: Centralized management for generating, viewing, and sending client statements.
- **AI Integration**:
    - **Prescription Scanning**: Uses GPT-4o vision to extract data from dental prescriptions, with client-side image compression. On web/desktop, camera is replaced with "Upload RX" file picker (supports JPG, PNG, PDF, HEIC, TIFF, BMP, WebP); camera remains on mobile. PDFs are converted client-side to PNG images via `pdfjs-dist` (CDN worker) before sending to OpenAI vision API.
    - **Document Scanning**: Uses GPT-4o vision and `sharp` to detect and crop document boundaries, correct rotation, and enhance quality.
    - **PDF Generation**: Converts scanned images into multi-page PDFs.
    - **Smile Preview**: AI-powered feature for teeth whitening and symmetry restoration using OpenAI's gpt-image-1 model.
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
- **OpenAI API**: Used for GPT-4o vision (prescription and document scanning) and gpt-image-1 (smile preview).

## Version Info
- **Version**: 1.0.6, build **59**
- **Safe area**: All admin screens use `paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16`
- **ESM config files**: All CommonJS config files must use `.cjs` extension
- **Web app**: `static-build/` serves Expo web export; `baseUrl: "/app"` in app.json
