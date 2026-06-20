import type { KnowledgeSection } from "../types";

/**
 * LabTrax platform knowledge: how-to / FAQ for the product's own features and
 * workflows. General reference only — contains no patient data.
 */
export const LABTRAX_SECTIONS: KnowledgeSection[] = [
  {
    id: "labtrax.cases",
    group: "labtrax",
    title: "Cases & case tracking",
    keywords: [
      "case", "cases", "case tracking", "work order", "case number", "pan",
      "barcode", "patient", "tooth", "restoration", "status", "worklist",
    ],
    body: "A case is the core record in LabTrax: it represents one patient's lab work for a doctor/practice. Each case has a case number, the patient name, the ordering doctor, a due date, a priority, one or more restorations (tooth number, restoration type, material, shade, quantity), staff notes, and attachments. Cases move through statuses as work progresses (e.g. new/active → in production → ready/shipped → complete). Staff find cases on the worklist, which can be filtered by status, doctor, and due date. Cases can carry a printable PAN barcode that is unique per lab. Use case notes for internal lab communication and the attachments area for photos, scans, and documents.",
  },
  {
    id: "labtrax.prescriptions",
    group: "labtrax",
    title: "Prescriptions (Rx) & AI Reader",
    keywords: [
      "prescription", "rx", "ai reader", "rx parsing", "import", "scan rx",
      "lab slip", "intake", "extract", "ocr",
    ],
    body: "A prescription (Rx) is the doctor's written order for a case. LabTrax can create a case from an uploaded Rx using the AI Reader, which extracts the patient, doctor, and restorations (type, material, shade, tooth numbers) from a photo or PDF and pre-fills the case for staff to review. AI-imported cases are flagged for review so a human confirms the extracted details before the case proceeds. The AI Reader is a separate surface from AI Chat/Agent: it only parses prescriptions, it does not answer questions. Always verify extracted material and shade against the original Rx before saving.",
  },
  {
    id: "labtrax.invoicing",
    group: "labtrax",
    title: "Invoicing & billing the practice",
    keywords: [
      "invoice", "invoicing", "invoices", "line item", "charge", "price",
      "pricing tier", "pricing", "bill", "balance due", "discount",
    ],
    body: "Invoices bill a doctor/practice for completed lab work. An invoice has line items, each with a description, quantity, and rate; rates come from the lab's pricing tiers and any per-doctor pricing overrides. Invoice line items can be rebuilt from a case's restorations, so persistent automatic charges (e.g. precious-alloy surcharges) should be modeled as restoration rows, not hand-added lines, so they survive a resync. Voiding, marking paid, and applying payments adjust the balance due. When a case is deleted its invoice is kept (frozen, with a zero balance) so financial history is never lost.",
  },
  {
    id: "labtrax.scheduling",
    group: "labtrax",
    title: "Scheduling, due dates & turnaround",
    keywords: [
      "schedule", "scheduling", "due date", "due", "turnaround", "delivery",
      "expected delivery", "deadline", "rush", "priority",
    ],
    body: "Every case has a required due date that drives the worklist and reminders; an optional expected-delivery date can be set and cleared independently. Priority (normal vs rush) helps staff triage. Use due dates to sort the worklist so the lab works the most urgent cases first. Turnaround expectations vary by restoration type and material — communicate realistic dates to the practice and update the case if a date slips.",
  },
  {
    id: "labtrax.customers",
    group: "labtrax",
    title: "Doctors, practices & customers",
    keywords: [
      "doctor", "doctors", "practice", "practices", "customer", "customers",
      "provider", "account number", "link labs", "cross-lab",
    ],
    body: "Customers are the doctors and practices a lab serves. Each provider gets a platform-wide account number so the same doctor can be recognized across multiple labs. When a second lab adds a doctor who already exists on the platform, LabTrax can link the accounts (via SMS invite or manual linking) so the doctor sees a unified worklist and invoices across all linked labs. Pricing can be set per doctor through pricing tiers and overrides. Keep customer records de-duplicated; the doctor picker on cases is sourced from names already used on the lab's cases.",
  },
  {
    id: "labtrax.production",
    group: "labtrax",
    title: "Production & status tracking",
    keywords: [
      "production", "status", "stage", "workflow", "in production", "ready",
      "shipped", "complete", "pan", "tracking", "progress",
    ],
    body: "Status tracking shows where each case is in the production workflow. As staff complete steps they advance the case status; the worklist and dashboards reflect counts per status so a manager can see load at a glance. Status changes on canonical cases go through the case update endpoint and are auditable. Keep statuses current so reminders, dashboards, and the practice-facing status view stay accurate.",
  },
  {
    id: "labtrax.notifications",
    group: "labtrax",
    title: "Notifications & alerts",
    keywords: [
      "notification", "notifications", "alert", "alerts", "email", "sms",
      "reminder", "reminders", "notify",
    ],
    body: "LabTrax sends notifications for key events (e.g. invites, status updates, billing, backups, and operational alerts) via email and SMS. All outgoing mail flows through a central, guarded send path so test/automation traffic never reaches real inboxes. Notification preferences are managed in Settings. Operational alerts (such as backup or cleanup issues) are deduplicated so a recurring failure does not flood an inbox.",
  },
  {
    id: "labtrax.reporting",
    group: "labtrax",
    title: "Reporting & dashboards",
    keywords: [
      "report", "reporting", "reports", "dashboard", "metrics", "analytics",
      "statement", "statements", "summary", "kpi",
    ],
    body: "Dashboards summarize lab activity: case counts by status, due/overdue work, and financial figures. Monthly statements roll up a practice's invoices for billing. Reports help managers spot bottlenecks (e.g. cases stuck in a stage) and track revenue. Reporting is read-only and respects the requesting user's role and lab membership.",
  },
  {
    id: "labtrax.billing",
    group: "labtrax",
    title: "Subscriptions & account billing",
    keywords: [
      "subscription", "subscriptions", "trial", "billing", "plan", "stripe",
      "revenuecat", "past due", "grace", "locked", "upgrade",
    ],
    body: "LabTrax itself is sold as a free-trial-then-subscription product (separate from invoicing practices). New orgs start a free trial; after that an active subscription is required for full access. Statuses include trialing, active, past_due (full access during a grace window), grace (read-only), and locked/canceled (no access). Desktop/web subscriptions use Stripe hosted checkout; iOS/Android use in-app purchases via RevenueCat. Subscription management lives in Settings.",
  },
  {
    id: "labtrax.mobile",
    group: "labtrax",
    title: "Mobile app workflows",
    keywords: [
      "mobile", "app", "phone", "expo", "ios", "android", "camera", "photo",
      "share", "share sheet", "biometric", "offline",
    ],
    body: "The LabTrax mobile app lets lab staff and doctors track cases on the go: view the worklist, open a case, add photos from the camera, capture an Rx, and update status. It supports a biometric lock and can receive shared files from other apps via the system share sheet. Photos are resized before upload for reliability. Mobile uses the same API and case data as the desktop app, so changes sync across devices.",
  },
  {
    id: "labtrax.permissions",
    group: "labtrax",
    title: "Roles & permissions",
    keywords: [
      "role", "roles", "permission", "permissions", "admin", "owner",
      "billing", "user", "member", "access", "rbac",
    ],
    body: "Access is governed by per-lab membership roles: owner and admin have full management rights; billing can manage finance; user (staff) handles day-to-day case work; read-only views without editing. Admin-only areas include team/user management, backups, templates, vocabulary/catalog, and the AI Assistant glossary. Every action is scoped to the lab the user belongs to — a user can never see or change another lab's data. Server-side checks enforce these rules regardless of what the client shows.",
  },
  {
    id: "labtrax.audit",
    group: "labtrax",
    title: "Audit logs & data protection",
    keywords: [
      "audit", "audit log", "history", "deleted", "soft delete", "restore",
      "data protection", "deletion", "recover", "trash",
    ],
    body: "Sensitive records (cases, invoices, users, organizations, memberships, pricing, bank transactions) are never hard-deleted — they are soft-deleted (marked deleted with who/when) and can be restored, and every deletion is written to an audit log. Case-media files are moved to a trash folder rather than removed outright. Admins can review the deletion audit log and recover deleted cases in Settings. This protects labs from accidental or malicious data loss.",
  },
  {
    id: "labtrax.ai",
    group: "labtrax",
    title: "AI Chat & AI Agent",
    keywords: [
      "ai", "ai chat", "ai agent", "assistant", "chatbot", "ask", "agent",
      "glossary", "memory", "preferences",
    ],
    body: "LabTrax has two conversational AI surfaces. AI Chat answers questions about the lab's own cases, pricing, and profile using real-time data. AI Agent can also take actions (e.g. mark an invoice paid) and always pauses for the user to confirm any data-changing action. Both are grounded in curated knowledge about LabTrax, the dental-lab domain, and HIPAA, plus the lab's own glossary and preferences (its memory). Admins manage that glossary/preferences in Settings → AI Assistant; terms a lab adds are reflected in that lab's AI answers only.",
  },
];
