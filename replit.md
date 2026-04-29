# LabTrax

## Overview

LabTrax is a comprehensive dental laboratory case management application designed to streamline operations for dental labs and provide a dedicated portal for dental providers. Its core purpose is to track dental lab cases through various production stages, manage clients, handle invoicing, and facilitate communication via notifications and a global chat system. The application supports role-based access for standard users, administrators, and providers, offering tailored functionalities such as inventory tracking, client management, and detailed case workflow visualization. The business vision is to enhance efficiency, transparency, and communication within the dental lab ecosystem, ultimately improving service delivery and client satisfaction.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: Expo SDK with React Native, utilizing `expo-router` for file-based routing.
- **Navigation**: Adaptive navigation with tab-based layouts for mobile and a `DesktopSidebar` for web, adjusting layouts based on screen size.
- **State Management**: React Context with AsyncStorage for local persistence.
- **Styling**: React Native StyleSheet with a centralized color theme.
- **Data Fetching**: TanStack React Query.
- **Authentication**: JWT tokens stored via AsyncStorage.

### Backend
- **Framework**: Express.js on Node.js with TypeScript.
- **API Pattern**: RESTful API.
- **Authentication**: JWT-based (access and refresh tokens) with sessions in the database.
- **Password Security**: bcrypt hashing.
- **Role-Based Access Control (RBAC)**: Organization membership-based roles (owner, admin, user, billing, read_only).
- **Audit Logging**: Significant actions logged to the `audit_logs` table.
- **CORS**: Dynamically configured.
- **Static Serving**: Serves pre-built Expo web bundle in production.
- **Landing Page**: Dynamic marketing page with placeholders for customization.

### Data Storage
- **Server-side**: PostgreSQL via Drizzle ORM.
- **Client-side**: AsyncStorage for local persistence.
- **Database Schema**: Defined using Drizzle ORM with Zod schemas.

### Key Features and Design Patterns
- **3-Portal Architecture**: Differentiated access for Master Admin, Lab Portal, and Provider Portal.
- **Case Workflow**: Tracks cases through predefined stations and includes remake detection.
- **Barcode System**: Supports scanning for case intake and processing.
- **Lab-Based Membership & Sharing**: Users belong to a lab, and cases/data are synced across lab members. Includes join request and invite mechanisms.
- **Multi-Device Sync**: Ensures consistent data across user devices.
- **Data Isolation (HIPAA)**: Cases filtered by lab membership for privacy.
- **Client Management**: Tools for managing provider accounts, including addition and deactivation.
- **Security**: Inactivity timeouts, biometric/password lock screens, and robust password recovery.
- **Work Status**: Persistent per-user work status displayed across the application.
- **Lab Channel Chat**: Group chat scoped to each lab for real-time communication.
- **File Drop Zone**: Enables drag-and-drop file uploads for patient files, with admin review and assignment to cases.
- **Invoices Hub**: Centralized management for generating, editing, and sending invoices, with detailed line-item editing and provider reassignment.
- **Financial Hub (QB-Style)**: Dashboard with key financial metrics (AR, Overdue, Collected YTD) and reports (Receive Payment, A/R Aging Summary, P&L Report, Sales by Item).
- **Statements Hub**: Centralized management for generating and sending client statements.
- **AI Integration**:
    - **Prescription Scanning**: Uses GPT-5.1 vision to extract data from prescriptions, including client-side image processing and PDF conversion. Automatically adds new providers even if dismissed.
    - **Document Scanning**: Uses GPT-5.1 vision and `sharp` for document boundary detection, rotation correction, and enhancement.
    - **Smile Preview**: AI-powered feature for teeth whitening and symmetry restoration using OpenAI's gpt-image-1 model.
    - **AI Proxy**: Replit AI integration proxy is used for all OpenAI API calls.
- **Admin Backup**: Admin-only endpoints for local and OneDrive backups, streaming a ZIP archive of data and files.
- **Appliance Subcategories & Pricing**: Multi-step wizard for adding appliance types with dynamic pricing based on client custom pricing or tier pricing.

### Server Route Modules
- `auth.ts`: Handles registration, login, user management, and organization creation/joining.
- `organizations.ts`: Manages organizations, members, invites, join requests, and connections.
- `cases.ts`: Provides CRUD operations for normalized case data.
- `invoices.ts`: Manages invoice generation, CRUD, payments, and sales reports.

### Server Utility Modules
- `http.ts`: HTTP error handling and response helpers.
- `crypto.ts`: Cryptographic utilities for hashing and token generation.
- `auth.ts`: JWT signing, verification, and token extraction.
- `audit.ts`: Functionality for writing audit logs.
- `rbac.ts`: Role-based access control checks.
- `case.ts`: Case-related calculation helpers.
- `async-handler.ts`: Express async error wrapper.
- `auth.ts`: JWT authentication middleware.

## External Dependencies

### Database
- **PostgreSQL**: Primary data store, managed with Drizzle ORM.

### Key NPM Packages
- **expo**: Core framework for the frontend.
- **express**: Backend HTTP server framework.
- **drizzle-orm** & **drizzle-kit**: Object-Relational Mapper for database interaction.
- **@tanstack/react-query**: For server state management and data fetching.
- **pg**: PostgreSQL client.
- **zod** & **drizzle-zod**: For schema validation.
- **sharp**: Server-side image processing library.
- **jsonwebtoken**: For JWT token handling.
- **bcryptjs**: For password hashing.
- **archiver**: For ZIP archive generation during backups.

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: Secret for JWT signing.
- `REPLIT_DEV_DOMAIN`, `EXPO_PUBLIC_DOMAIN`, `REPLIT_INTERNAL_APP_DOMAIN`: For deployment and domain configuration.
- SMTP credentials (optional): For email recovery.
- Twilio credentials (optional): For SMS notifications.

### AI Services
- **OpenAI API**: Utilized for GPT-5.1 vision (prescription/document scanning), chat, and gpt-image-1 (smile preview). Accessed via the Replit AI integration proxy at `localhost:1106/modelfarm/openai`.