# LabTrax

## Overview

LabTrax is a dental laboratory case management application designed to streamline operations for dental labs and provide a dedicated portal for dental providers. Built with Expo (React Native) for the frontend and Express.js for the backend, its core purpose is to track dental lab cases through various production stages, manage clients, handle invoicing, and facilitate communication through notifications and a global chat system. The application supports role-based access for standard users, administrators, and providers, offering tailored functionalities such as inventory tracking, client management, and detailed case workflow visualization. The business vision is to enhance efficiency, transparency, and communication within the dental lab ecosystem, ultimately improving service delivery and client satisfaction.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: Expo SDK 54 with React Native 0.81, utilizing `expo-router` for file-based routing.
- **Navigation**: Features tab-based layouts customized for lab users (5 tabs) and providers (4 tabs), with a dedicated case detail screen.
- **State Management**: Global application state (cases, clients, users, invoices, notifications) is managed via React Context and persisted locally using AsyncStorage.
- **Styling**: React Native StyleSheet with a centralized color theme.
- **Data Fetching**: TanStack React Query for server state management and data fetching, using `expo/fetch` for network requests.

### Backend Architecture
- **Framework**: Express.js v5 on Node.js with TypeScript.
- **API Pattern**: RESTful API with routes registered under `/api`.
- **Storage**: Designed with an interface (`IStorage`) to easily switch between in-memory storage (for development) and database-backed solutions.
- **CORS**: Dynamically configured to support Replit and local development environments.
- **Static Serving**: Serves a pre-built Expo web bundle in production.

### Data Storage
- **Server-side Database**: PostgreSQL database via Drizzle ORM.
- **Authentication**: Handles user login and registration with accounts persisted in PostgreSQL.
- **Database Schema**: Defined using Drizzle ORM with Zod schemas for validation.
- **Client-side Persistence**: AsyncStorage is used for local storage of persistent application state.

### Key Features and Design Patterns
- **3-Portal Architecture**: Differentiates access and features for Master Admin, Lab Portal, and Provider Portal users based on `userType`.
- **Role-Based Access**: Two primary roles (`user`, `admin`) with additional `adminUnlocked` state for sensitive actions in the Lab Portal. Price information and administrative sections are role-gated.
- **Case Workflow**: Cases transition through predefined stations (INTAKE, DESIGN, SCAN, MILL, PORCELAIN, QC, COMPLETE, SHIP) with `routeHistory` tracking. Case and invoice numbers follow a chronological YY-N format.
- **Barcode System**: Supports barcode scanning for case intake, location, and batch processing, linking physical barcodes to digital case records.
- **Remake Detection**: Implements a specific flow for identifying and managing remakes, including reason selection and recharge options.
- **Group-Based Permissions**: Organizes users into groups (e.g., practice/lab) with associated members and invitation mechanisms.
- **Security**: Incorporates inactivity timeouts, biometric/password-based lock screens, and robust password change mechanisms.
- **Global Chat System**: Facilitates communication between users and labs with real-time messaging and unread message indicators.
- **Courtesy Text Feature**: Automates delay notifications and negotiation flows for updated delivery dates directly from case details.
- **Inventory Tracking**: Allows administrators to manage inventory items, categories, quantities, and receive low-stock alerts.
- **Provider Account Numbers**: Automates assignment of unique account numbers to providers upon registration.

## External Dependencies

### Database
- **PostgreSQL**: Used for persistent data storage, managed with Drizzle ORM. Requires `DATABASE_URL` environment variable.

### Key NPM Packages
- **expo**: Core framework for cross-platform development.
- **express**: Backend HTTP server.
- **drizzle-orm** & **drizzle-kit**: ORM for database interaction and migrations.
- **@tanstack/react-query**: For server state management and data fetching.
- **pg**: PostgreSQL client.
- **zod** & **drizzle-zod**: For runtime schema validation.

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string.
- `REPLIT_DEV_DOMAIN`: Replit development domain for CORS and API URL construction.
- `EXPO_PUBLIC_DOMAIN`: Public domain for client-side API requests (port is stripped by `getApiUrl()` so all requests use default HTTPS port 443).
- `REPLIT_INTERNAL_APP_DOMAIN`: Replit deployment domain for production builds.

### API Proxy (Development)
- **Metro proxy**: `metro.config.js` configures the Expo dev server (port 8081) to proxy `/api` requests to the Express backend (port 5000) using a single shared `http-proxy-middleware` instance with 120s timeout. This ensures API calls work without specifying a port number, matching the production behavior where Express serves both API and static assets on a single port.
- **`.local/` exclusion**: Metro's file watcher excludes `.local/` to prevent ENOENT crashes from transient Replit log files.

### Server Configuration
- **Single instance**: Server listens without `reusePort` to ensure a single process handles all requests. This is critical for in-memory state like verification codes.
- **Body parser limit**: Express JSON body parser is set to 50MB to support base64-encoded prescription photos from the camera.
- **AI prescription scanning**: POST `/api/analyze-prescription` uses GPT-4o-mini vision via Replit's AI integration to extract doctor name, patient name, tooth numbers, shade, material, and notes from scanned dental prescriptions.