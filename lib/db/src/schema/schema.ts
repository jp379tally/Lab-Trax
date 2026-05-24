import { relations, sql } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable(
  "users",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    username: text("username").notNull().unique(),
    password: text("password").notNull(),
    email: text("email"),
    phone: text("phone"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    initials: text("initials"),
    userType: text("user_type").default("lab"),
    role: text("role").default("user"),
    isActive: boolean("is_active").default(true).notNull(),
    licenseNumber: text("license_number"),
    practiceName: text("practice_name"),
    doctorName: text("doctor_name"),
    practiceAddress: text("practice_address"),
    practicePhone: text("practice_phone"),
    phoneContactName: text("phone_contact_name"),
    accountNumber: text("account_number"),
    // Platform-wide account number (Task #320). Format: <seq><YY><F><L>
    // (e.g. "2926JW"). Unique across the entire platform. Allocated for
    // every provider user; allocated lazily/never for non-providers.
    platformAccountNumber: text("platform_account_number"),
    wantsUpdates: boolean("wants_updates").default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    workStatus: text("work_status").default("available"),
    // Per-user email notification preferences (Task #611).
    // Nullable — missing keys default to true (opt-in matches previous behaviour).
    // Keys: caseNoteNotifications, orgInviteNotifications, statementEmails, billingReminders
    emailPreferences: jsonb("email_preferences"),
    // Two-factor authentication (Task #825). twoFactorSecret is AES-256-GCM
    // encrypted using a key derived from JWT_SECRET. twoFactorBackupCodes is a
    // JSONB array of bcrypt-hashed one-time-use codes (8 codes generated on
    // enable). Plain-text codes are returned exactly once at setup time.
    twoFactorSecret: text("two_factor_secret"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    twoFactorBackupCodes: jsonb("two_factor_backup_codes"),
    createdAt: timestamp("created_at").defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    platformAccountNumberUnique: uniqueIndex(
      "users_platform_account_number_unique"
    )
      .on(table.platformAccountNumber)
      .where(sql`platform_account_number IS NOT NULL`),
  })
);

export const labCases = pgTable("lab_cases", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  organizationId: varchar("organization_id"),
  caseData: text("case_data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
  deletedBy: varchar("deleted_by"),
});

export const labPendingFiles = pgTable(
  "lab_pending_files",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull(),
    uploaderUserId: varchar("uploader_user_id").notNull(),
    uploaderName: text("uploader_name"),
    fileUrl: text("file_url").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    notes: text("notes"),
    notesUpdatedAt: timestamp("notes_updated_at", { withTimezone: true }),
    notesEditedByUserId: varchar("notes_edited_by_user_id"),
    notesEditedByName: text("notes_edited_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("lab_pending_files_org_idx").on(table.organizationId),
  })
);

// Append-only audit log of every edit made to a pending file's free-text
// notes. We never UPDATE rows here — each note save inserts a new entry so
// admins can reconstruct the full timeline of who changed what and when,
// even after the underlying pending file is gone.
export const labPendingFileNoteEdits = pgTable(
  "lab_pending_file_note_edits",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    pendingFileId: varchar("pending_file_id").notNull(),
    editorUserId: varchar("editor_user_id").notNull(),
    editorName: text("editor_name"),
    oldNotes: text("old_notes"),
    newNotes: text("new_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    fileIdx: index("lab_pending_file_note_edits_file_idx").on(
      table.pendingFileId
    ),
  })
);

export const organizations = pgTable(
  "organizations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text("type").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    billingEmail: text("billing_email"),
    phone: text("phone"),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    isActive: boolean("is_active").default(true).notNull(),
    defaultBankAccountId: varchar("default_bank_account_id"),
    // Public URL of the lab's logo image (PNG/JPG/SVG/WebP), shown in
    // the desktop app header, on invoices, and in PDFs. Uploaded via
    // Settings → Profile → "Add a logo" and stored in App Storage.
    // Null when the lab hasn't uploaded one yet.
    logoUrl: text("logo_url"),
    // Which documents/emails should include the lab logo.
    // null = unset — treated as all-placements-enabled when logoUrl is set
    // (preserves existing behavior for orgs that had a logo before this
    // feature), or as empty for new orgs (opt-in required).
    // Valid values: "invoices" | "statements" | "sms" | "emails" |
    // "case_exports" | "quotes" | "welcome_emails" | "payment_receipts"
    logoplacements: text("logo_placements").array(),
    // Size of the logo in generated PDFs. null = default ("medium").
    // Valid values: "small" | "medium" | "large"
    logoPdfSize: text("logo_pdf_size"),
    // Per-lab visual invoice-layout template (Task #751). JSON shape is
    // defined by `InvoiceTemplate` in lib/invoice-template. Null = use
    // the built-in default layout (preserves existing behavior for labs
    // that have not opened the layout editor). Edited via Settings →
    // Invoice Layout in the desktop app.
    invoiceTemplate: jsonb("invoice_template"),
    // Provider organizations are created by a specific lab. We persist the
    // creating lab's id here (nullable for non-provider orgs / legacy rows)
    // so account-number uniqueness can be scoped per lab.
    parentLabOrganizationId: varchar("parent_lab_organization_id"),
    // Stable, lab-scoped account number for provider organizations. Either
    // server-derived from the practice address + doctor initials, or a custom
    // value supplied by a lab admin. Unique within (parentLabOrganizationId).
    accountNumber: text("account_number"),
    // Platform-wide account number (Task #320). Format: <seq><YY><F><L>
    // (e.g. "2926JW"). Unique across the entire platform. Allocated for
    // every provider organization at creation time; null for lab orgs and
    // legacy rows pending backfill.
    platformAccountNumber: text("platform_account_number"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // When true, the automated statement-email engine will skip this practice
    // even if it has activity and a billing email. Labs set this once per
    // practice instead of manually deselecting the practice each month.
    statementEmailOptOut: boolean("statement_email_opt_out")
      .default(false)
      .notNull(),
    // Per-lab bigram-similarity threshold (0.5–0.95) used to flag "Suggested
    // merges" / "Suggested duplicates" clusters in the Doctors and Practices
    // pages. Null = use the application default (0.7). Only meaningful on
    // type="lab" rows; ignored on provider organizations.
    duplicateSuggestionThreshold: decimal("duplicate_suggestion_threshold", {
      precision: 4,
      scale: 3,
    }),
    // How many days a trusted device token remains valid before the user must
    // pass the 2FA challenge again. Null = fall back to the global
    // TRUSTED_DEVICE_TTL_DAYS env var (default 30). Valid range: 1–365.
    // Only meaningful on type="lab" rows; ignored on provider organizations.
    trustedDeviceTtlDays: integer("trusted_device_ttl_days"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    parentLabAccountNumberUnique: uniqueIndex(
      "organizations_parent_lab_account_number_unique"
    )
      .on(table.parentLabOrganizationId, table.accountNumber)
      .where(
        sql`${table.parentLabOrganizationId} is not null and ${table.accountNumber} is not null`
      ),
    organizationsPlatformAccountNumberUnique: uniqueIndex(
      "organizations_platform_account_number_unique"
    )
      .on(table.platformAccountNumber)
      .where(sql`platform_account_number IS NOT NULL`),
  })
);

/**
 * Per-(year, entity_type) monotonic sequence used by the platform-account-
 * number allocator (Task #320). Locked with `SELECT ... FOR UPDATE` inside a
 * transaction so concurrent allocations get strictly increasing values.
 * `entity_type` is one of "user" | "org".
 */
export const platformAccountSequences = pgTable(
  "platform_account_sequences",
  {
    year: integer("year").notNull(),
    entityType: text("entity_type").notNull(),
    nextSeq: integer("next_seq").default(1).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    pk: uniqueIndex("platform_account_sequences_pk").on(
      table.year,
      table.entityType
    ),
  })
);

/**
 * Cross-lab doctor identity links (Task #320). Each row links two provider
 * user ids that have been confirmed as the same human doctor (e.g. the same
 * doctor working with two different labs). `userIdLow` is always the
 * lexicographically smaller user id so the unique index covers the unordered
 * pair. `linkedVia` records how the link was confirmed: "sms_yes" (Twilio
 * YES reply), "manual" (provider clicked Link in the mobile portal), or
 * "admin_backfill".
 */
export const doctorAccountLinks = pgTable(
  "doctor_account_links",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userIdLow: varchar("user_id_low")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userIdHigh: varchar("user_id_high")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    linkedVia: text("linked_via").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pairUnique: uniqueIndex("doctor_account_links_pair_unique").on(
      table.userIdLow,
      table.userIdHigh
    ),
    lowIdx: index("doctor_account_links_low_idx").on(table.userIdLow),
    highIdx: index("doctor_account_links_high_idx").on(table.userIdHigh),
  })
);

/**
 * Outbound Twilio SMS invites sent to existing platform doctors when a new
 * lab adds a matching email/phone doctor (Task #320). Used for both
 * idempotency (don't re-SMS the same pair) and for routing inbound YES
 * replies back to the originating link request.
 */
export const accountLinkInvites = pgTable(
  "account_link_invites",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Newly-created provider user (the "second lab" copy).
    newUserId: varchar("new_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Existing platform doctor we matched to.
    existingUserId: varchar("existing_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchedOn: text("matched_on").notNull(),
    sentToPhone: text("sent_to_phone"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: text("status").default("pending").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    twilioMessageSid: text("twilio_message_sid"),
    twilioErrorCode: text("twilio_error_code"),
    twilioErrorMessage: text("twilio_error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    pairUnique: uniqueIndex("account_link_invites_pair_unique").on(
      table.newUserId,
      table.existingUserId
    ),
    pendingByPhoneIdx: index("account_link_invites_pending_phone_idx").on(
      table.sentToPhone,
      table.status
    ),
  })
);

export const organizationMemberships = pgTable(
  "lab_memberships",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labId: varchar("lab_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").default("active").notNull(),
    invitedByUserId: varchar("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedByUserId: varchar("approved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    uniqueMemberPerOrg: uniqueIndex("memberships_org_user_unique")
      .on(table.labId, table.userId)
      .where(sql`deleted_at IS NULL`),
    orgIdx: index("memberships_org_idx").on(table.labId),
    userIdx: index("memberships_user_idx").on(table.userId),
  })
);

export const organizationJoinRequests = pgTable(
  "join_requests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labId: varchar("lab_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedRole: text("requested_role").notNull(),
    message: text("message"),
    status: text("status").default("pending").notNull(),
    reviewedByUserId: varchar("reviewed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    pendingUnique: uniqueIndex("join_requests_pending_unique")
      .on(table.labId, table.userId)
      .where(sql`status = 'pending'`),
  })
);

export const organizationInvites = pgTable(
  "lab_invites",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labId: varchar("lab_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email"),
    phone: text("phone"),
    roleToAssign: text("role_to_assign"),
    token: text("token"),
    status: text("status").default("pending").notNull(),
    invitedByUserId: varchar("invited_by_user_id")
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedByUserId: varchar("accepted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("lab_invites_token_unique").on(
      table.token
    ),
  })
);

export const organizationConnections = pgTable(
  "organization_connections",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").default("pending").notNull(),
    tierName: text("tier_name"),
    requestedByOrgId: varchar("requested_by_org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: varchar("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedByUserId: varchar("approved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    uniqueConnection: uniqueIndex("organization_connections_unique").on(
      table.labOrganizationId,
      table.providerOrganizationId
    ),
  })
);

export const cases = pgTable(
  "cases",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    caseNumber: text("case_number").notNull(),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientFirstName: text("patient_first_name").notNull(),
    patientLastName: text("patient_last_name").notNull(),
    externalPatientId: text("external_patient_id"),
    doctorName: text("doctor_name").notNull(),
    status: text("status").default("received").notNull(),
    priority: text("priority").default("normal").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    needsAiReview: boolean("needs_ai_review").default(false).notNull(),
    aiImportSource: text("ai_import_source"),
    remakeOfCaseId: varchar("remake_of_case_id"),
    remakeReason: text("remake_reason"),
    remakeCharged: boolean("remake_charged"),
    suggestedDoctorName: text("suggested_doctor_name"),
    suggestedProviderOrgId: varchar("suggested_provider_org_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    casePanBarcode: text("case_pan_barcode"),
    bridgeConnectors: text("bridge_connectors"),
  },
  (table) => ({
    caseNumberUnique: uniqueIndex("cases_case_number_unique").on(
      table.caseNumber
    ),
    casesDeletedAtIdx: index("cases_deleted_at_idx").on(table.deletedAt),
    caseLabIdx: index("cases_lab_idx").on(table.labOrganizationId),
    caseProviderIdx: index("cases_provider_idx").on(
      table.providerOrganizationId
    ),
    casesRemakeOfIdx: index("cases_remake_of_idx").on(table.remakeOfCaseId),
  })
);

/**
 * Per-organization dedup table for cases imported automatically from iTero
 * "Lab Review". Each row marks one upstream iTero order as already-imported
 * for a given lab organization, so background pollers don't re-create the
 * same case on every cycle. This table is dedup-only — no protected lab data
 * lives here, so it is intentionally NOT part of PROTECTED_TABLES.
 */
export const iteroImportedOrders = pgTable(
  "itero_imported_orders",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    iteroOrderId: text("itero_order_id").notNull(),
    createdCaseId: varchar("created_case_id").references(() => cases.id, {
      onDelete: "set null",
    }),
    importedByUserId: varchar("imported_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    batchId: text("batch_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    iteroOrderUnique: uniqueIndex("itero_imported_orders_unique").on(
      table.labOrganizationId,
      table.iteroOrderId
    ),
  })
);

// One row per import call (rx, zip, or zip-batch). Each batch produces exactly
// one session row with aggregate counts so the history endpoint can report
// accurate created / deduped / errored totals even for orders that were
// de-duplicated (and therefore never got a new itero_imported_orders row).
export const iteroImportSessions = pgTable("itero_import_sessions", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  importedByUserId: varchar("imported_by_user_id").references(
    () => users.id,
    { onDelete: "set null" }
  ),
  importedAt: timestamp("imported_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdCount: integer("created_count").notNull().default(0),
  dedupedCount: integer("deduped_count").notNull().default(0),
  erroredCount: integer("errored_count").notNull().default(0),
  caseIds: text("case_ids").array(),
  batchId: text("batch_id"),
});

export const caseRestorations = pgTable("case_restorations", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  toothNumber: text("tooth_number").notNull(),
  restorationType: text("restoration_type").notNull(),
  restorationSubtype: text("restoration_subtype"),
  material: text("material"),
  shade: text("shade"),
  notes: text("notes"),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  priceSource: text("price_source"),
  priceSourceId: varchar("price_source_id"),
  priceSourceName: text("price_source_name"),
  priceKey: text("price_key"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const caseEvents = pgTable(
  "case_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    caseId: varchar("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorOrganizationId: varchar("actor_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    actorInitials: text("actor_initials"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    caseEventsIdx: index("case_events_case_idx").on(table.caseId),
  })
);

export const caseNotes = pgTable("case_notes", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  authorUserId: varchar("author_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  authorOrganizationId: varchar("author_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  noteText: text("note_text").notNull(),
  visibility: text("visibility").default("shared_with_provider").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const caseAttachments = pgTable("case_attachments", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  uploadedByUserId: varchar("uploaded_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  uploadedByOrganizationId: varchar("uploaded_by_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  fileType: text("file_type").notNull(),
  visibility: text("visibility").default("shared_with_provider").notNull(),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
});

export const caseLocations = pgTable("case_locations", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  locationCode: text("location_code").notNull(),
  locationName: text("location_name").notNull(),
  movedByUserId: varchar("moved_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  movedAt: timestamp("moved_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  notes: text("notes"),
});

export const caseSubmissionQueue = pgTable("case_submission_queue", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  submittedByUserId: varchar("submitted_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  submittedByOrganizationId: varchar("submitted_by_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  submissionType: text("submission_type").notNull(),
  payloadJson: jsonb("payload_json").default({}).notNull(),
  status: text("status").default("pending_review").notNull(),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    invoiceNumber: text("invoice_number").notNull(),
    caseId: varchar("case_id").references(() => cases.id, {
      onDelete: "set null",
    }),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: text("status").default("draft").notNull(),
    subtotal: decimal("subtotal", { precision: 10, scale: 2 })
      .default("0.00")
      .notNull(),
    tax: decimal("tax", { precision: 10, scale: 2 }).default("0.00").notNull(),
    discount: decimal("discount", { precision: 10, scale: 2 })
      .default("0.00")
      .notNull(),
    total: decimal("total", { precision: 10, scale: 2 })
      .default("0.00")
      .notNull(),
    balanceDue: decimal("balance_due", { precision: 10, scale: 2 })
      .default("0.00")
      .notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    notes: text("notes"),
    displayMetadataJson: jsonb("display_metadata_json"),
    aiGenerated: boolean("ai_generated").default(false).notNull(),
    aiPricingWarning: text("ai_pricing_warning"),
    aiReviewedAt: timestamp("ai_reviewed_at", { withTimezone: true }),
    aiReviewedByUserId: varchar("ai_reviewed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: varchar("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    voidKind: text("void_kind"),
    sourceInvoiceId: varchar("source_invoice_id"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    invoiceNumberUnique: uniqueIndex("invoices_invoice_number_unique").on(
      table.invoiceNumber
    ),
    invoicesDeletedAtIdx: index("invoices_deleted_at_idx").on(table.deletedAt),
    invoicesProviderOrgIdx: index("invoices_provider_org_idx").on(
      table.providerOrganizationId,
    ),
    invoicesLabOrgIdx: index("invoices_lab_org_idx").on(
      table.labOrganizationId,
    ),
    invoicesAiGeneratedIdx: index("invoices_ai_generated_idx").on(
      table.aiGenerated,
    ),
  })
);

export const invoiceAttachments = pgTable(
  "invoice_attachments",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").default(0).notNull(),
    includeInPdf: boolean("include_in_pdf").default(false).notNull(),
    uploadedByUserId: varchar("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    invoiceAttachmentsInvoiceIdx: index(
      "invoice_attachments_invoice_idx",
    ).on(table.invoiceId),
  }),
);

export const invoiceCredits = pgTable(
  "invoice_credits",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: varchar("source_id"),
    note: text("note"),
    appliedByUserId: varchar("applied_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByUserId: varchar("reversed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (table) => ({
    invoiceCreditsInvoiceIdx: index("invoice_credits_invoice_idx").on(
      table.invoiceId,
    ),
    invoiceCreditsProviderIdx: index("invoice_credits_provider_idx").on(
      table.providerOrganizationId,
    ),
  }),
);

export const practiceStatements = pgTable(
  "practice_statements",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    invoiceCount: integer("invoice_count").default(0).notNull(),
    totalBilled: decimal("total_billed", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    totalPaid: decimal("total_paid", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    balanceDue: decimal("balance_due", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    invoiceIdsJson: jsonb("invoice_ids_json").default([]).notNull(),
    pdfStorageKey: text("pdf_storage_key"),
    pdfFileName: text("pdf_file_name"),
    pdfFileSize: integer("pdf_file_size"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => ({
    practiceStatementsProviderIdx: index(
      "practice_statements_provider_idx",
    ).on(table.providerOrganizationId),
    practiceStatementsLabIdx: index("practice_statements_lab_idx").on(
      table.labOrganizationId,
    ),
  }),
);

export const practiceStatementSends = pgTable(
  "practice_statement_sends",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    statementId: varchar("statement_id")
      .notNull()
      .references(() => practiceStatements.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    status: text("status").default("sent").notNull(),
    errorMessage: text("error_message"),
    sentByUserId: varchar("sent_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    practiceStatementSendsStatementIdx: index(
      "practice_statement_sends_statement_idx",
    ).on(table.statementId),
  }),
);

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  caseRestorationId: varchar("case_restoration_id").references(
    () => caseRestorations.id,
    { onDelete: "set null" }
  ),
  toothNumber: integer("tooth_number"),
  description: text("description").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  lineTotal: decimal("line_total", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payments = pgTable("payments", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
  recordedByUserId: varchar("recorded_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});

export const pricingTiers = pgTable(
  "pricing_tiers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pricesJson: jsonb("prices_json").default({}).notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    pricingTiersLabIdx: index("pricing_tiers_lab_idx").on(
      table.labOrganizationId
    ),
    pricingTiersLabNameUnique: uniqueIndex("pricing_tiers_lab_name_unique")
      .on(table.labOrganizationId, table.name)
      .where(sql`deleted_at IS NULL`),
    pricingTiersDeletedAtIdx: index("pricing_tiers_deleted_at_idx").on(
      table.deletedAt
    ),
  })
);

export const pricingOverrides = pgTable(
  "pricing_overrides",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    doctorName: text("doctor_name").notNull(),
    practiceName: text("practice_name"),
    providerOrganizationId: varchar("provider_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    tierName: text("tier_name"),
    pricesJson: jsonb("prices_json").default({}).notNull(),
    notes: text("notes"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    pricingOverridesLabIdx: index("pricing_overrides_lab_idx").on(
      table.labOrganizationId
    ),
    pricingOverridesLabDoctorUnique: uniqueIndex(
      "pricing_overrides_lab_doctor_unique"
    )
      .on(
        table.labOrganizationId,
        table.doctorName,
        table.providerOrganizationId
      )
      .where(sql`deleted_at IS NULL`),
    pricingOverridesDeletedAtIdx: index(
      "pricing_overrides_deleted_at_idx"
    ).on(table.deletedAt),
  })
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    organizationId: varchar("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    auditCreatedIdx: index("audit_logs_created_idx").on(table.createdAt),
  })
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    deviceName: text("device_name"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("user_sessions_token_hash_unique").on(
      table.tokenHash
    ),
  })
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMemberships),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships),
}));

export const organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMemberships.labId],
      references: [organizations.id],
    }),
    user: one(users, {
      fields: [organizationMemberships.userId],
      references: [users.id],
    }),
  })
);

export const notifications = pgTable("notifications", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  dataJson: jsonb("data_json"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    institution: text("institution"),
    last4: text("last4"),
    openingBalance: decimal("opening_balance", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    openingDate: timestamp("opening_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    currency: text("currency").default("USD").notNull(),
    isArchived: boolean("is_archived").default(false).notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    bankAccountsLabIdx: index("bank_accounts_lab_idx").on(
      table.labOrganizationId
    ),
  })
);

export const transactionCategories = pgTable(
  "transaction_categories",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").default("expense").notNull(),
    color: text("color"),
    isArchived: boolean("is_archived").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    txnCatLabIdx: index("transaction_categories_lab_idx").on(
      table.labOrganizationId
    ),
    txnCatUnique: uniqueIndex("transaction_categories_unique").on(
      table.labOrganizationId,
      table.name
    ),
  })
);

export const recurringTransactions = pgTable(
  "recurring_transactions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: varchar("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    payee: text("payee"),
    memo: text("memo"),
    categoryId: varchar("category_id").references(
      () => transactionCategories.id,
      { onDelete: "set null" }
    ),
    direction: text("direction").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }),
    estimateMethod: text("estimate_method").default("fixed").notNull(),
    frequency: text("frequency").default("monthly").notNull(),
    dayOfMonth: integer("day_of_month").default(1).notNull(),
    startDate: timestamp("start_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endDate: timestamp("end_date", { withTimezone: true }),
    autoCreate: boolean("auto_create").default(true).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    lastGeneratedFor: text("last_generated_for"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    recurringLabIdx: index("recurring_transactions_lab_idx").on(
      table.labOrganizationId
    ),
  })
);

export const reconciliations = pgTable(
  "reconciliations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: varchar("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    statementDate: timestamp("statement_date", { withTimezone: true }).notNull(),
    startingBalance: decimal("starting_balance", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    endingBalance: decimal("ending_balance", { precision: 14, scale: 2 })
      .notNull(),
    clearedTotal: decimal("cleared_total", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    difference: decimal("difference", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    status: text("status").default("completed").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    reconLabIdx: index("reconciliations_lab_idx").on(table.labOrganizationId),
    reconAcctIdx: index("reconciliations_account_idx").on(table.bankAccountId),
  })
);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: varchar("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    txnDate: timestamp("txn_date", { withTimezone: true }).notNull(),
    type: text("type").default("other").notNull(),
    checkNumber: text("check_number"),
    payee: text("payee"),
    memo: text("memo"),
    categoryId: varchar("category_id").references(
      () => transactionCategories.id,
      { onDelete: "set null" }
    ),
    debitAmount: decimal("debit_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    creditAmount: decimal("credit_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    netAmount: decimal("net_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    cleared: boolean("cleared").default(false).notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    reconciled: boolean("reconciled").default(false).notNull(),
    reconciliationId: varchar("reconciliation_id").references(
      () => reconciliations.id,
      { onDelete: "set null" }
    ),
    status: text("status").default("posted").notNull(),
    source: text("source").default("manual").notNull(),
    recurringRuleId: varchar("recurring_rule_id").references(
      () => recurringTransactions.id,
      { onDelete: "set null" }
    ),
    importBatchId: text("import_batch_id"),
    transferGroupId: varchar("transfer_group_id"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    bankTxnLabIdx: index("bank_transactions_lab_idx").on(
      table.labOrganizationId
    ),
    bankTxnAcctIdx: index("bank_transactions_account_idx").on(
      table.bankAccountId
    ),
    bankTxnDateIdx: index("bank_transactions_date_idx").on(table.txnDate),
    bankTxnTransferIdx: index("bank_transactions_transfer_idx").on(
      table.transferGroupId
    ),
    bankTxnDeletedAtIdx: index("bank_transactions_deleted_at_idx").on(
      table.deletedAt
    ),
  })
);

export const bankTransactionInvoices = pgTable(
  "bank_transaction_invoices",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bankTransactionId: varchar("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "cascade" }),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => ({
    bankTxnInvoiceUnique: uniqueIndex("bank_transaction_invoices_unique").on(
      table.bankTransactionId,
      table.invoiceId
    ),
    bankTxnInvoiceInvoiceIdx: index(
      "bank_transaction_invoices_invoice_idx"
    ).on(table.invoiceId),
  })
);

export const reconciliationItems = pgTable(
  "reconciliation_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reconciliationId: varchar("reconciliation_id")
      .notNull()
      .references(() => reconciliations.id, { onDelete: "cascade" }),
    transactionId: varchar("transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "cascade" }),
    amount: decimal("amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    reconItemUnique: uniqueIndex("reconciliation_items_unique").on(
      table.reconciliationId,
      table.transactionId
    ),
  })
);

export const statementSchedules = pgTable(
  "statement_schedules",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(false).notNull(),
    // dayOfMonth = 0 means "last day of month" (fires on the true last calendar
    // day, regardless of how many days the month has). Values 1–31 fire on that
    // numbered day, clamped to the month's actual last day when needed.
    dayOfMonth: integer("day_of_month").default(1).notNull(),
    emailSubject: text("email_subject"),
    emailBody: text("email_body"),
    emailReplyTo: text("email_reply_to"),
    // Optional per-practice filter. When null (or empty), the scheduler sends
    // to every practice with activity — matching the default "all" behaviour.
    // When set, only practices whose id appears in this list receive a statement.
    includedOrgIds: text("included_org_ids").array(),
    lastSentForMonth: text("last_sent_for_month"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    inProgressForMonth: text("in_progress_for_month"),
    inProgressLeasedAt: timestamp("in_progress_leased_at", { withTimezone: true }),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orgUnique: uniqueIndex("statement_schedules_org_unique").on(
      table.labOrganizationId
    ),
  })
);

export const statementSendRuns = pgTable(
  "statement_send_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    practiceOrganizationId: varchar("practice_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    practiceName: text("practice_name").notNull(),
    practiceEmail: text("practice_email"),
    periodMonth: text("period_month").notNull(),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    invoiceCount: integer("invoice_count").default(0).notNull(),
    totalBilled: decimal("total_billed", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    openBalance: decimal("open_balance", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    triggeredBy: text("triggered_by").notNull(),
    triggeredByUserId: varchar("triggered_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    attemptCount: integer("attempt_count").default(1).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    labIdx: index("statement_send_runs_lab_idx").on(table.labOrganizationId),
    labPeriodIdx: index("statement_send_runs_lab_period_idx").on(
      table.labOrganizationId,
      table.periodMonth
    ),
    nextAttemptIdx: index("statement_send_runs_next_attempt_idx").on(
      table.nextAttemptAt
    ),
  })
);

export const mediaCleanupRuns = pgTable(
  "media_cleanup_runs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    dryRun: boolean("dry_run").default(false).notNull(),
    status: text("status").default("ok").notNull(),
    errorMessage: text("error_message"),
    scannedFiles: integer("scanned_files").default(0).notNull(),
    referencedFiles: integer("referenced_files").default(0).notNull(),
    orphanCount: integer("orphan_count").default(0).notNull(),
    removedCount: integer("removed_count").default(0).notNull(),
    freedBytes: integer("freed_bytes").default(0).notNull(),
    errorCount: integer("error_count").default(0).notNull(),
    triggeredBy: text("triggered_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    startedAtIdx: index("media_cleanup_runs_started_at_idx").on(table.startedAt),
    oneRunningAtATime: uniqueIndex("media_cleanup_runs_one_running_idx")
      .on(table.status)
      .where(sql`status = 'running'`),
  })
);

export const systemSettings = pgTable("system_settings", {
  key: varchar("key").primaryKey(),
  value: text("value"),
  updatedAt: updatedAt(),
});

export const installerChangelog = pgTable(
  "installer_changelog",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    downloadUrl: text("download_url").notNull(),
    version: text("version"),
    releaseNotes: text("release_notes"),
    savedByUserId: varchar("saved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    savedByUsername: text("saved_by_username"),
    createdAt: createdAt(),
  },
  (table) => ({
    createdAtIdx: index("installer_changelog_created_at_idx").on(table.createdAt),
  }),
);

export const installerUploads = pgTable(
  "installer_uploads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sizeBytes: integer("size_bytes").notNull(),
    version: text("version"),
    checksumSha256: text("checksum_sha256"),
    uploadedByUserId: varchar("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    uploadedByUsername: text("uploaded_by_username"),
    createdAt: createdAt(),
  },
  (table) => ({
    createdAtIdx: index("installer_uploads_created_at_idx").on(table.createdAt),
  }),
);

/**
 * Per-lab admin-configurable display labels for each standard price key
 * (e.g. `zirconia_crown` → "Zirconia Crown"). When a row is present its
 * `label` is used on every invoice line item generated for that lab;
 * otherwise the static default label from `DEFAULT_TIER_ITEMS` is used as
 * fallback. Kept separate from pricing tiers so the same display name
 * applies regardless of which tier is active for a given doctor.
 */
export const labItemLabels = pgTable(
  "lab_item_labels",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    priceKey: text("price_key").notNull(),
    label: text("label").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labPriceKeyUnique: uniqueIndex("lab_item_labels_lab_price_key_unique").on(
      table.labOrganizationId,
      table.priceKey
    ),
    labIdx: index("lab_item_labels_lab_idx").on(table.labOrganizationId),
  })
);

/**
 * Subscription lifecycle for labs and providers (Task #416).
 *
 * Subject identity:
 *   - Lab: subjectType = "lab_org",      subjectId = lab organization id
 *   - Provider with org: subjectType = "provider_org", subjectId = provider org id
 *   - Provider without org: subjectType = "provider_user", subjectId = user id
 *
 * Status FSM:
 *   trialing → active (payment on file, renewal succeeds)
 *   trialing → grace  (trial expired, no payment / first failure)
 *   grace    → locked (grace period elapsed)
 *   active   → past_due (renewal failed)
 *   past_due → active  (payment recovered)
 *   past_due → grace   (retries exhausted)
 *   active / past_due / grace → canceled
 *   legacy_free = existing accounts before billing cutover
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subjectType: text("subject_type").notNull(),
    subjectId: varchar("subject_id").notNull(),
    provider: text("provider").default("none").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    revenueCatAppUserId: text("revenue_cat_app_user_id"),
    status: text("status").default("trialing").notNull(),
    trialStartAt: timestamp("trial_start_at", { withTimezone: true }),
    trialEndAt: timestamp("trial_end_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    paymentMethodOnFile: boolean("payment_method_on_file")
      .default(false)
      .notNull(),
    lastReminderSentAt: timestamp("last_reminder_sent_at", {
      withTimezone: true,
    }),
    lastReminderKind: text("last_reminder_kind"),
    gracePeriodStartAt: timestamp("grace_period_start_at", {
      withTimezone: true,
    }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    subjectUnique: uniqueIndex("subscriptions_subject_unique").on(
      table.subjectType,
      table.subjectId
    ).where(sql`deleted_at IS NULL`),
    stripeCustomerIdx: index("subscriptions_stripe_customer_idx").on(
      table.stripeCustomerId
    ),
    stripeSubIdx: index("subscriptions_stripe_sub_idx").on(
      table.stripeSubscriptionId
    ),
    rcUserIdx: index("subscriptions_rc_user_idx").on(
      table.revenueCatAppUserId
    ),
    statusIdx: index("subscriptions_status_idx").on(table.status),
    trialEndIdx: index("subscriptions_trial_end_idx").on(table.trialEndAt),
  })
);

/**
 * Append-only log of every billing webhook / state-change event.
 * Never delete rows from this table — it is the audit trail for all billing events.
 */
export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subscriptionId: varchar("subscription_id").references(
      () => subscriptions.id,
      { onDelete: "set null" }
    ),
    subjectType: text("subject_type"),
    subjectId: varchar("subject_id"),
    eventType: text("event_type").notNull(),
    provider: text("provider"),
    externalEventId: text("external_event_id"),
    statusBefore: text("status_before"),
    statusAfter: text("status_after"),
    rawPayloadJson: jsonb("raw_payload_json"),
    createdAt: createdAt(),
  },
  (table) => ({
    subIdx: index("subscription_events_sub_idx").on(table.subscriptionId),
    subjectIdx: index("subscription_events_subject_idx").on(table.subjectId),
    eventTypeIdx: index("subscription_events_event_type_idx").on(
      table.eventType
    ),
    createdAtIdx: index("subscription_events_created_at_idx").on(
      table.createdAt
    ),
    externalEventUnique: uniqueIndex(
      "subscription_events_external_event_unique"
    )
      .on(table.provider, table.externalEventId)
      .where(
        sql`external_event_id IS NOT NULL AND provider IS NOT NULL`
      ),
  })
);

export const vendors = pgTable(
  "vendors",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    vendorType: text("vendor_type", { enum: ["vendor", "employee", "item"] }).notNull().default("vendor"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    vendorLabIdx: index("vendors_lab_idx").on(table.labOrganizationId),
  })
);

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: serial("id").primaryKey(),
    triggeredBy: text("triggered_by").notNull(),
    destination: text("destination").notNull(),
    path: text("path"),
    fileName: text("file_name"),
    sizeBytes: integer("size_bytes"),
    status: text("status").notNull().default("success"),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    completedAtIdx: index("backup_runs_completed_at_idx").on(table.completedAt),
  })
);

/**
 * Per-lab alias mapping: when a user manually picks a practice after the AI
 * extracted a doctor/practice name that didn't match, they can teach the
 * system to auto-select that practice the next time the same Rx name appears.
 *
 * `rx_name` is stored normalized (trimmed + lowercased) so lookups are
 * case-insensitive. The unique index on (lab_organization_id, rx_name)
 * enforces one mapping per Rx name per lab and enables efficient upserts.
 */
export const rxPracticeNameAliases = pgTable(
  "rx_practice_name_aliases",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    rxName: text("rx_name").notNull(),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    createdByUserId: varchar("created_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
  },
  (table) => ({
    labRxNameUnique: uniqueIndex(
      "rx_practice_name_aliases_lab_rx_name_unique"
    ).on(table.labOrganizationId, table.rxName),
    labIdx: index("rx_practice_name_aliases_lab_idx").on(
      table.labOrganizationId
    ),
  })
);

/**
 * Trusted devices for 2FA skip (Task #863).
 * After passing a 2FA challenge the user can tick "Trust this device for 30 days".
 * We store a SHA-256 hash of the opaque token sent back to the client. The
 * token is presented on subsequent logins (via the Authorization body or a
 * custom header) so the server can skip the TOTP challenge for recognised
 * devices.
 *
 * Indexed by userId (list all devices for a user) and tokenHash (verify a
 * presented token in O(1)).
 */
export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    deviceName: text("device_name"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("trusted_devices_user_idx").on(table.userId),
    tokenHashUnique: uniqueIndex("trusted_devices_token_hash_unique").on(table.tokenHash),
  })
);

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type LabCaseRow = typeof labCases.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type TrustedDevice = typeof trustedDevices.$inferSelect;
