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
- **Data Isolation (HIPAA)**: Cases are strictly filtered by `ownerId === currentUserId`. The `currentUserId` is exposed from `AuthContext` and consumed by `AppProvider` for case ownership filtering and stamping. Users not affiliated with any group see an informational banner but can still access their own cases. Profile pictures are stored per-user (keyed by user ID) and cleared on logout.
- **Duplicate Registration Prevention**: During account creation, email, phone number, and address are checked against existing active accounts to prevent duplicates. Deleted accounts release their information for reuse.
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
- `EXPO_PUBLIC_DOMAIN`: Public domain for client-side API requests (set to `$REPLIT_DEV_DOMAIN:5000` so API requests go directly to the Express backend). `resilientFetch` tries the primary URL first and falls back to portless URL if the response is not JSON.
- `REPLIT_INTERNAL_APP_DOMAIN`: Replit deployment domain for production builds.

### API Proxy (Development)
- **Metro proxy**: `metro.config.js` configures the Expo dev server (port 8081) to proxy `/api` requests to the Express backend (port 5000) using a single shared `http-proxy-middleware` instance with 120s timeout. This ensures API calls work without specifying a port number, matching the production behavior where Express serves both API and static assets on a single port.
- **`.local/` exclusion**: Metro's file watcher excludes `.local/` to prevent ENOENT crashes from transient Replit log files.

### Server Configuration
- **Single instance**: Server listens without `reusePort` to ensure a single process handles all requests. This is critical for in-memory state like verification codes.
- **Body parser limit**: Express JSON body parser is set to 50MB to support base64-encoded prescription photos from the camera.
- **AI prescription scanning**: POST `/api/analyze-prescription` uses GPT-4o vision (with GPT-4o-mini fallback) via Replit's AI integration to extract doctor name, patient name, tooth numbers, shade, material, and notes from scanned dental prescriptions. Images are compressed to max 1024px on the client side before sending (web: canvas resize, native: expo-image-manipulator). The client uses `resilientFetch` with a 90s timeout and shows an Alert on failure instead of failing silently. Server-side post-processing flips "Last, First" names to "First Last" and normalizes case types (Crown/Bridge/Veneer → Restorative).
- **AI document scanning**: POST `/api/crop-document` uses GPT-4o vision to detect document boundaries in photos and `sharp` to crop to just the document, like OneDrive/Adobe Scan. First applies EXIF rotation correction via `sharp.rotate()` to fix sideways photos from phone cameras, then AI detects crop coordinates and any rotation needed to make the document upright. Post-processing includes sharpening and normalization for clean, readable scans.
- **PDF generation**: POST `/api/document-to-pdf` converts scanned document images into a multi-page PDF. Each image is EXIF-corrected, centered on a letter-size page with margins. The frontend "Save PDF" button normalizes file URIs to base64 data URIs before sending, then uses `expo-sharing` to share/save the resulting PDF on native devices or triggers a download on web.
- **Demo Account**: A demo account (`phillipsjohnpaul@yahoo.com` / `Jp#14482726`) is seeded on server startup for App Store review purposes. The account is created with `userType: "lab"` and `role: "admin"` if it doesn't already exist.
- **App Store Readiness**: Bundle identifier is `com.allieddl.labtrax`, URL scheme is `labtrax`. iOS `infoPlist` declares all required permission descriptions: camera, photo library, microphone, location (when in use), and Face ID. Privacy Policy and Terms of Service are accessible both as in-app screens (`/privacy-policy`, `/terms-of-service`) and as web-accessible HTML pages served by the backend at the same paths. Legal links appear on the login screen and in Settings > LEGAL section. Camera permission requests are preceded by a pre-permission `Alert.alert()` explaining usage before the system prompt.
- **Registration**: Sign-up flow collects address in 3 fields (street, city, zip code) with GPS auto-fill, plus a license number (labeled "Lab License Number" for labs, "Dental License Number" for providers).
- **Case management features**: Case detail includes "Locate Case" (station selection), "Reprint Lab Slip" (view/print), and "Assign Barcode" buttons. Cases list supports long-press to locate cases. Barcode scan flow: scanning an unknown barcode auto-navigates to the new case form with the barcode pre-attached; on case creation, the barcode is auto-assigned and the label modal shows directly. The label modal "Done" button navigates to the cases list when a barcode was already attached (skipping the redundant attach prompt).
- **Smile Preview AI**: Provider portal has an AI-powered smile enhancement feature at `/smile-preview`. Uses OpenAI's gpt-image-1 model via POST `/api/smile-process` for three modes: teeth whitening, symmetry restoration, and both combined. The screen captures a photo with the device camera and sends it to the server for AI processing. Results are displayed as clean processed images (no CSS overlays). Supports retake, original view, and re-processing with different modes.
- **Sharp**: Used for server-side image cropping (document detection). Installed as a Node.js dependency.