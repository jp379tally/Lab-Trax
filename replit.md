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

### Backend
- **Framework**: Express.js v5 on Node.js with TypeScript.
- **API Pattern**: RESTful API under `/api`.
- **Storage**: Pluggable storage interface, supporting in-memory and PostgreSQL.
- **CORS**: Dynamically configured for Replit and local development.
- **Static Serving**: Serves pre-built Expo web bundle in production.

### Data Storage
- **Server-side**: PostgreSQL via Drizzle ORM.
- **Client-side**: AsyncStorage for local persistence.
- **Database Schema**: Defined using Drizzle ORM with Zod schemas.

### Key Features and Design Patterns
- **3-Portal Architecture**: Differentiated access for Master Admin, Lab Portal, and Provider Portal based on `userType`.
- **Role-Based Access**: `user`, `admin` roles with additional `adminUnlocked` state for sensitive actions.
- **Case Workflow**: Tracks cases through predefined stations (INTAKE, DESIGN, etc.) with `routeHistory`.
- **Barcode System**: Supports scanning for case intake, location, and batch processing.
- **Remake Detection**: Specific flow for identifying and managing remakes.
- **Lab-Based Membership & Sharing**: Users belong to a lab based on `practiceName`, enabling shared case visibility and join requests. Cases are synced between local storage and server for all lab members.
- **Data Isolation (HIPAA)**: Cases filtered by lab membership.
- **Client Management**: Admins can delete or deactivate clients, with safeguards for open invoices.
- **Duplicate Registration Prevention**: Checks for existing accounts by email, phone, and address during sign-up.
- **Security**: Inactivity timeouts, biometric/password lock screens, robust password recovery via email (with optional SMTP configuration).
- **Global Chat System**: Real-time messaging with unread indicators.
- **Courtesy Text Feature**: Automates delay notifications and delivery date negotiations.
- **Inventory Tracking**: Manage items, categories, quantities, and low-stock alerts.
- **Provider Account Numbers**: Automated assignment of unique IDs.
- **Invoices Hub**: Centralized management for viewing, generating, and sending invoices. Admins can directly edit invoices.
- **Statements Hub**: Centralized management for generating, viewing, and sending client statements.
- **AI Integration**:
    - **Prescription Scanning**: Uses GPT-4o vision to extract data from dental prescriptions, with client-side image compression.
    - **Document Scanning**: Uses GPT-4o vision and `sharp` to detect and crop document boundaries, correct rotation, and enhance quality.
    - **PDF Generation**: Converts scanned images into multi-page PDFs.
    - **Smile Preview**: AI-powered feature for teeth whitening and symmetry restoration using OpenAI's gpt-image-1 model.
- **App Store Readiness**: Includes required permission descriptions, privacy policy/terms of service, and secure account deletion.
- **Registration**: Collects detailed address and license number.
- **Case Management Enhancements**: Features like "Locate Case," "Reprint Lab Slip," and barcode assignment flows.

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

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string.
- `REPLIT_DEV_DOMAIN`: Replit dev domain.
- `EXPO_PUBLIC_DOMAIN`: Public domain for client API.
- `REPLIT_INTERNAL_APP_DOMAIN`: Replit deployment domain.
- SMTP credentials (optional): `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_FROM` for email recovery.

### API Proxy (Development)
- **Metro proxy**: Configures Expo dev server to proxy `/api` requests to Express backend.

### AI Services
- **OpenAI API**: Used for GPT-4o vision (prescription and document scanning) and gpt-image-1 (smile preview).