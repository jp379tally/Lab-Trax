# DriveSync Lab

## Overview

DriveSync Lab is a dental laboratory case management application built with Expo (React Native) for the frontend and Express.js for the backend. It allows dental lab technicians and administrators to track lab cases through various production stations (intake, design, wax-up, casting, finishing, etc.), manage clients, handle invoicing, and receive notifications. The app supports two user roles: **tech** (lab technician) and **admin** (lab administrator), with role-based access to pricing and administrative features.

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

### Role-Based Access
- Two roles: `tech` (technician) and `admin` (administrator)
- Admin role requires an additional unlock step (`adminUnlocked` flag)
- Price information is only visible when role is admin AND admin is unlocked
- Role switching is available in the Profile tab

### Admin Master Hub Navigation
- Hub → "Clients" group → client-hub (Add Client, Edit Client, Client List, Edit Pricing, Edit Tier Pricing)
- Hub → "Users" group → user-hub (Add User, Edit User with group management)
- Hub → Invoices, Statements, Shipping, Sales (direct navigation)

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