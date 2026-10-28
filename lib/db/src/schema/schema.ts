import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
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
    // Platform-wide account number. New rows use twelve ASCII digits:
    // 7 + ten-digit permuted presentation of one global sequence + Luhn digit,
    // displayed 4-4-4. Issued values exclude Luhn's 09/90 transposition gap;
    // legacy values remain grandfathered.
    platformAccountNumber: text("platform_account_number"),
    wantsUpdates: boolean("wants_updates").default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    workStatus: text("work_status").default("available"),
    // Per-user email notification preferences (Task #611).
    // Nullable — missing keys default to true (opt-in matches previous behaviour).
    // Keys: caseNoteNotifications, orgInviteNotifications, statementEmails, billingReminders
    emailPreferences: jsonb("email_preferences"),
    // Per-user SMS notification preferences.
    // Nullable — missing keys default to true (opt-in matches previous behaviour).
    // Keys: accountLinkInvites, caseNoteNotifications, billingReminders
    smsPreferences: jsonb("sms_preferences"),
    // Per-user in-app (bell) notification preferences (Task #3696).
    // Nullable — missing keys default to true (opt-in matches previous behaviour).
    // Keys: caseNoteNotifications
    inAppPreferences: jsonb("in_app_preferences"),
    // Account-wide provider doctor preferences. Nullable so existing accounts
    // and non-provider users do not need a placeholder record.
    doctorPreferences: jsonb("doctor_preferences"),
    // Durable email/phone verification state (Account epic Phase 2).
    // Null = unverified. Set the moment a one-time code is confirmed for the
    // account's own contact value. Enforced server-side: unverified users are
    // blocked from PHI routes (cases/invoices/finance/statements).
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    profilePhotoUrl: text("profile_photo_url"),
    // Provenance for provider-account creation. Only three triggers may mint a
    // provider account (and therefore an account number): a provider signing
    // up on the provider portal, a lab-side signup, or a lab deliberately
    // creating an account for a provider. Every insert routed through the
    // provider-account gate stamps which trigger ran, who the actor was, and
    // which practice the account was created for, so an unexpected account can
    // be traced back to its origin.
    accountCreationTrigger: text("account_creation_trigger"),
    accountCreatedByUserId: varchar("account_created_by_user_id"),
    accountCreatedForOrganizationId: varchar(
      "account_created_for_organization_id"
    ),
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
    usernameCaseInsensitiveIdx: index("users_username_lower_idx").on(
      sql`lower(${table.username})`
    ),
    emailCaseInsensitiveIdx: index("users_email_lower_trim_idx").on(
      sql`lower(trim(${table.email}))`
    ),
  })
);

export const labCases = pgTable(
  "lab_cases",
  {
    id: varchar("id").primaryKey(),
    ownerId: varchar("owner_id").notNull(),
    organizationId: varchar("organization_id"),
    caseData: text("case_data").notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
    deletedAt: timestamp("deleted_at"),
    deletedBy: varchar("deleted_by"),
    // ── Projected list fields (Task #4371) ──────────────────────────────────
    // The case lists used to re-extract these values out of `case_data` with a
    // regex pass per field, per row, on every request — multi-megabyte blobs
    // (embedded base64 photos) made a 10-row page take seconds. They are now
    // computed once per write by the `lab_cases_project_list_fields` trigger
    // installed in `lib/lab-case-projection.ts`, which owns their extraction
    // rules; `projectionVersion` records which revision of those rules
    // produced the row, so the rules can change and stale rows be recomputed.
    // A row whose projection is missing or outdated is still read the old way
    // by the lists, so correctness never depends on the backfill.
    //
    // Every projected value is derived from `case_data` ALONE. Anything that
    // also depends on a live column (the lists' `receivedAt`, and `createdAt`
    // when the blob has no timestamp, both fall back to `updatedAt`) is
    // resolved at query time instead, so an ordinary `updatedAt` touch cannot
    // leave a stale value behind.
    projectionVersion: integer("projection_version"),
    projectedCaseNumber: text("projected_case_number"),
    projectedPatientFirstName: text("projected_patient_first_name"),
    projectedPatientLastName: text("projected_patient_last_name"),
    projectedDoctorName: text("projected_doctor_name"),
    // Compact, normalized identity document used by legacy worklist search.
    // Keeping this separate from case_data prevents the trigram index from
    // copying multi-megabyte embedded media into its posting tree.
    projectedSearchDocument: text("projected_search_document"),
    projectedStatus: text("projected_status"),
    projectedPriority: text("projected_priority"),
    projectedBarcode: text("projected_barcode"),
    projectedDueDate: timestamp("projected_due_date", { withTimezone: true }),
    projectedCreatedAt: timestamp("projected_created_at", {
      withTimezone: true,
    }),
    projectedTotalPrice: decimal("projected_total_price"),
    projectedCategory: text("projected_category"),
    projectedTaxonomyType: text("projected_taxonomy_type"),
    // Compact copy of the handful of blob keys the list rows display
    // (restorations pruned to the four fields used, plus caseType/material/
    // teeth/step/barcode/location/remake markers). Null means the blob is not
    // parseable as JSON by PostgreSQL — the lists then fall back to parsing
    // that row's `case_data` in Node, exactly as they always did.
    projectedSummary: jsonb("projected_summary"),
  },
  (table) => ({
    // Worklist candidates are always tenant-scoped and ordered by the only
    // structured legacy timestamp available before decoding case_data.
    organizationUpdatedIdx: index("lab_cases_organization_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
    organizationDeletedIdx: index("lab_cases_organization_deleted_idx").on(
      table.organizationId,
      table.deletedAt,
    ),
    // Drives both the "does this tenant still have unprojected rows?" check on
    // the read path and the startup backfill's batch selection.
    projectionVersionIdx: index("lab_cases_projection_stale_v2_idx").on(
      table.projectionVersion,
    ).where(sql`projection_version IS DISTINCT FROM 2`),
    // NOTE: there is deliberately no trigram index here. Replit Publish does
    // not migrate the pg_trgm extension to production, so an extension-backed
    // index makes the otherwise portable schema migration fail. Searching this
    // compact document still avoids scanning multi-megabyte case_data blobs.
  }),
);

/**
 * Fences installation of the versioned legacy-case projection SQL across
 * concurrently starting API instances.
 */
export const labCaseProjectionInstallation = pgTable(
  "lab_case_projection_installation",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    version: integer("version").notNull(),
  },
  (table) => ({
    singletonCheck: check(
      "lab_case_projection_installation_singleton_check",
      sql`${table.singleton} = true`,
    ),
  }),
);

// Tenant-binding ledger for media files referenced by legacy mobile cases
// (rows in `lab_cases`). Those cases CANNOT have `case_attachments` rows —
// that table's `case_id` has a hard FK to `cases.id` (canonical desktop
// cases only). Without this ledger the file-serving route has no record to
// authorize against, so legacy-case photos 404 (blank thumbnails), and the
// nightly orphan-media cleanup treats the files as unreferenced and trashes
// them. Binding is FIRST-WRITER-WINS (fileName PK, insert ON CONFLICT DO
// NOTHING): the first legacy case that references a filename owns it, so a
// later crafted caseData cannot rebind another tenant's file.
export const legacyCaseMedia = pgTable(
  "legacy_case_media",
  {
    fileName: varchar("file_name").primaryKey(),
    labCaseId: varchar("lab_case_id").notNull(),
    organizationId: varchar("organization_id"),
    ownerId: varchar("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    labCaseIdx: index("legacy_case_media_lab_case_idx").on(table.labCaseId),
    orgIdx: index("legacy_case_media_org_idx").on(table.organizationId),
  })
);

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
    billingAddressLine1: text("billing_address_line_1"),
    billingAddressLine2: text("billing_address_line_2"),
    billingCity: text("billing_city"),
    billingState: text("billing_state"),
    billingZip: text("billing_zip"),
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
    // Named invoice-template presets (Task templates feature). JSON shape:
    // Array<{id:string, name:string, template:InvoiceTemplate, savedAt:string}>
    invoiceTemplatePresets: jsonb("invoice_template_presets"),
    // Per-lab visual statement-layout template (Task #906). JSON shape is
    // defined by `StatementTemplate` in lib/statement-template. Null = use
    // the built-in default layout.
    statementTemplate: jsonb("statement_template"),
    // Per-lab visual case-print-label template (advanced layout editor).
    // JSON shape is defined by `CasePrintTemplate` in lib/case-print-template.
    // Null = labs that haven't opened the advanced editor — falls back to
    // the legacy field-list `PrintLayoutConfig` from local storage.
    casePrintTemplate: jsonb("case_print_template"),
    // Per-lab visual correspondence-layout template (Task #906). JSON shape
    // is defined by `CorrespondenceTemplate` in lib/correspondence-template.
    // Null = use the built-in default layout.
    correspondenceTemplate: jsonb("correspondence_template"),
    // Provider organizations are created by a specific lab. We persist the
    // creating lab's id here (nullable for non-provider orgs / legacy rows)
    // so account-number uniqueness can be scoped per lab.
    parentLabOrganizationId: varchar("parent_lab_organization_id"),
    // Stable, lab-scoped account number for provider organizations. Either
    // server-derived from the practice address + doctor initials, or a custom
    // value supplied by a lab admin. Unique within (parentLabOrganizationId).
    accountNumber: text("account_number"),
    // Platform-wide account number. Every newly created organization receives
    // the same twelve-digit global format as users; existing legacy rows keep
    // their prior value (including null).
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
    // Default number of days after case received-date that the due date
    // should be set. Null = no default (field left blank on new cases).
    // Only meaningful on type="lab" rows.
    defaultCaseDueDays: integer("default_case_due_days"),
    // When true, new case due dates are capped so they never exceed
    // (received date + defaultCaseDueDays). Dates sooner than the
    // turnaround are kept as-is (treated as rush). Null / false = off
    // (existing behaviour). Only meaningful on type="lab" rows.
    capCaseDueToDefault: boolean("cap_case_due_to_default"),
    // Day of the month (1–28) on which invoices become due. The due date
    // is set to this day of the month following the invoice issue month.
    // Null = use the application default (10). Only meaningful on type="lab" rows.
    invoiceDueDayOfMonth: integer("invoice_due_day_of_month"),
    // When true, adding a PFM restoration to a case automatically appends an
    // "Alloy" surcharge line (priced via the lab's tier/override logic) so
    // staff don't have to remember to charge for alloy on PFM cases. Off by
    // default — labs opt in from Settings → Profile. Only meaningful on
    // type="lab" rows; ignored on provider organizations.
    autoAddAlloyOnPfm: boolean("auto_add_alloy_on_pfm")
      .default(false)
      .notNull(),
    // When true, lab slips include the current preferences saved by the
    // provider user belonging to the case's provider organization.
    printProviderPreferencesOnLabSlips: boolean(
      "print_provider_preferences_on_lab_slips"
    )
      .default(false)
      .notNull(),
    // Lab license / registration number captured at lab-environment creation
    // (Account epic Phase 3). Required for type="lab" rows created through the
    // canonical create-lab flow; null on provider orgs and legacy lab rows.
    licenseNumber: text("license_number"),
    // Default pricing tier name assigned to every newly-created doctor override
    // for this lab. Null = no default (new doctors have no tier until set
    // manually). Only meaningful on type="lab" rows.
    defaultDoctorTierName: text("default_doctor_tier_name"),
    // Per-lab monthly revenue target thresholds (in dollars) for the red/
    // yellow/green coloring on the Stats and Reports charts. Null = use the
    // application defaults (85 000 / 95 000). Only meaningful on type="lab"
    // rows; ignored on provider organizations.
    revenueTargetLow: integer("revenue_target_low"),
    revenueTargetHigh: integer("revenue_target_high"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    organizationsPlatformAccountNumberUnique: uniqueIndex(
      "organizations_platform_account_number_unique"
    )
      .on(table.platformAccountNumber)
      .where(sql`platform_account_number IS NOT NULL`),
  })
);

/**
 * Sequence rows used by platform account-number allocators. New issuance uses
 * one global row `(year=0, entity_type='global')`, locked with SELECT FOR
 * UPDATE in the caller's transaction. Legacy/backfill formats continue to use
 * their historical (year, entity_type) rows.
 *
 * `next_seq` is intentionally bounded by the API allocator to PostgreSQL's
 * signed integer range, avoiding unsafe JavaScript numeric arithmetic while
 * retaining the existing schema for old backfill scripts.
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
 * Durable one-time verification codes (Account epic Phase 2). Replaces the
 * old in-memory `Map` used by send/verify email/phone code routes so the
 * "is this contact verified?" signal survives restarts and works across
 * instances. Codes are stored HASHED (never plaintext); `target` is the
 * normalized contact value (lowercased email, or 10-digit phone). `userId`
 * is set when the request is authenticated (signup-time flow). `attemptCount`
 * supports per-code attempt limiting; `consumedAt` marks a single-use code as
 * spent.
 */
export const verificationCodes = pgTable(
  "verification_codes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id"),
    channel: text("channel").notNull(), // "email" | "sms"
    target: text("target").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    targetChannelIdx: index("verification_codes_target_channel_idx").on(
      table.target,
      table.channel
    ),
    userIdx: index("verification_codes_user_idx").on(table.userId),
  })
);

/**
 * Cross-lab doctor identity links (Task #320). Each row links two provider
 * user ids that have been confirmed as the same human doctor (e.g. the same
 * doctor working with two different labs). `userIdLow` is always the
 * lexicographically smaller user id so the unique index covers the unordered
 * pair. Self-service links require the invited account's authenticated
 * confirmation; `linkedVia` records that path or an authorized admin backfill.
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
 * Invitations sent to existing platform doctors when a new lab adds a
 * matching email/phone doctor or a provider requests a link by account number.
 * SMS is notification only; acceptance happens in the authenticated app.
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
    providerMessageId: text("provider_message_id"),
    providerErrorCode: text("provider_error_code"),
    providerErrorMessage: text("provider_error_message"),
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

// Holding area for provider users detached from a practice without being
// deleted. A row here means "this doctor used to belong to a practice in this
// lab and is now unassigned". It grants NO data access (unlike a membership) —
// it is purely a relationship pointer the lab admin can later reassign.
export const labUnassignedDoctors = pgTable(
  "lab_unassigned_doctors",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Nullable: removing a name-only (case-history) doctor must NOT mint a
    // provider account just to have an id to park here. Such a removal is
    // recorded by name instead, and `doctorName` carries it.
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    // The doctor's display name. Always set for name-only entries; optional
    // (denormalized) for account-backed entries.
    doctorName: text("doctor_name"),
    removedFromOrganizationId: varchar("removed_from_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    removedAt: timestamp("removed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    removedByUserId: varchar("removed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueUnassignedPerLab: uniqueIndex("lab_unassigned_doctors_unique")
      .on(table.labOrganizationId, table.userId)
      .where(sql`deleted_at IS NULL`),
    // Name-only entries have no user id to dedupe on, so they are unique per
    // lab by normalized name instead.
    uniqueUnassignedNamePerLab: uniqueIndex(
      "lab_unassigned_doctors_name_unique"
    )
      .on(table.labOrganizationId, sql`lower(${table.doctorName})`)
      .where(sql`deleted_at IS NULL AND user_id IS NULL`),
    labIdx: index("lab_unassigned_doctors_lab_idx").on(
      table.labOrganizationId
    ),
    userIdx: index("lab_unassigned_doctors_user_idx").on(table.userId),
    identityPresent: check(
      "lab_unassigned_doctors_identity_present",
      sql`user_id IS NOT NULL OR (doctor_name IS NOT NULL AND btrim(doctor_name) <> '')`
    ),
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
    // Delivery tracking for the invite email so admins can see whether the
    // last send attempt actually went out. lastEmailStatus is one of
    // "sent" | "failed" | "skipped" (recipient opted out / reserved domain);
    // lastEmailError holds a short, safe reason string only — never raw
    // SMTP/provider payloads.
    lastEmailAttemptAt: timestamp("last_email_attempt_at", {
      withTimezone: true,
    }),
    lastEmailStatus: text("last_email_status"),
    lastEmailError: text("last_email_error"),
    // Number of automatic retries already performed for the invite email.
    // Incremented by the background retry sweep when it claims an invite;
    // reset to 0 on a successful send and on a manual resend (fresh budget).
    emailRetryCount: integer("email_retry_count").default(0).notNull(),
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

/**
 * Approval-gated contact/profile changes for one lab-provider relationship.
 *
 * Card data never belongs here. Processor-backed card summaries are maintained
 * on provider_payment_customers and are shared immediately. This table stores
 * only organization contact-field proposals and the exact baseline used to
 * reject stale decisions safely.
 */
export const providerAccountChangeRequests = pgTable(
  "provider_account_change_requests",
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
    requestedByOrganizationId: varchar("requested_by_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: varchar("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: text("source").notNull(), // "lab" | "provider"
    status: text("status").default("pending").notNull(),
    changesJson: jsonb("changes_json").notNull(),
    baselineJson: jsonb("baseline_json").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    clientRequestId: text("client_request_id"),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    relationshipIdx: index("provider_account_changes_relationship_idx").on(
      table.labOrganizationId,
      table.providerOrganizationId,
      table.createdAt,
    ),
    pendingFingerprintUnique: uniqueIndex(
      "provider_account_changes_pending_fingerprint_unique",
    )
      .on(
        table.labOrganizationId,
        table.providerOrganizationId,
        table.requestFingerprint,
      )
      .where(sql`status = 'pending'`),
    clientRequestUnique: uniqueIndex(
      "provider_account_changes_client_request_unique",
    )
      .on(
        table.labOrganizationId,
        table.providerOrganizationId,
        table.clientRequestId,
      )
      .where(sql`client_request_id IS NOT NULL`),
  }),
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
    prescriptionDueDate: date("prescription_due_date", { mode: "string" }),
    scanDate: date("scan_date", { mode: "string" }),
    dueTime: text("due_time"),
    expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true }),
    receivedAt: date("received_at", { mode: "string" })
      .default(sql`make_date(
        extract(year from timezone('UTC', CURRENT_TIMESTAMP))::integer,
        extract(month from timezone('UTC', CURRENT_TIMESTAMP))::integer,
        extract(day from timezone('UTC', CURRENT_TIMESTAMP))::integer
      )`)
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
    // Structured remake questionnaire fields (added 2026-07-15).
    // remakeReasonKey is the canonical stable key for one of the 18 remake
    // reasons. The free-text remakeReason is preserved for legacy fallback.
    remakeReasonKey: varchar("remake_reason_key"),
    // Shade-related conditional fields (shown when remakeReasonKey = "shade_wrong")
    remakeShadeLightness: varchar("remake_shade_lightness"), // "light" | "dark"
    remakeShadePrescribed: varchar("remake_shade_prescribed"),
    remakeShadeProvided: varchar("remake_shade_provided"),
    // Material-related conditional fields (shown for material-mismatch reasons)
    remakeMaterialPrescribed: varchar("remake_material_prescribed"),
    remakeMaterialProvided: varchar("remake_material_provided"),
    // Whether the items were returned to the lab
    remakeReturnedToLab: boolean("remake_returned_to_lab"),
    // Case category for remake reporting: "crown_bridge" | "removable"
    remakeCategory: varchar("remake_category"),
    // Free-text technician notes entered in the remake questionnaire.
    // Admin/owner only — never exposed to providers/practices.
    remakeNotes: text("remake_notes"),
    suggestedDoctorName: text("suggested_doctor_name"),
    suggestedProviderOrgId: varchar("suggested_provider_org_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    casePanBarcode: text("case_pan_barcode"),
    bridgeConnectors: text("bridge_connectors"),
    deliveryDateProposalDate: timestamp("delivery_date_proposal_date", { withTimezone: true }),
    deliveryDateProposalNote: text("delivery_date_proposal_note"),
    rxNotes: text("rx_notes"),
    providerContactSnapshot: jsonb("provider_contact_snapshot"),
    shade: text("shade"),
    // Lab workflow step for removable cases (Task #3276). Stored as a short
    // snake_case key: custom_tray | rims_and_plates | wax_setup | process.
    // Nullable — most cases have no step set.
    step: text("step"),
    // Shade associated with a wax_setup step (Task #3276). Only meaningful
    // when step = 'wax_setup'. Cleared server-side when step changes away
    // from wax_setup.
    stepShade: text("step_shade"),
    // Gingival (base/tissue) shade for removable prosthetics, extracted from
    // the iTero Rx (e.g. "Light Pink", "Medium Pink"). Separate from the
    // tooth shade so it appears as its own labeled field on the lab slip.
    gingivialShade: text("gingivial_shade"),
    // Custom-shade tracking fields (Task #3631). Case-level flags recorded
    // when the shade was taken by a technician rather than from a standard
    // shade guide. isCustomShade gates the sub-fields: technician name,
    // and two availability flags for media evidence.
    isCustomShade: boolean("is_custom_shade").default(false),
    customShadeTechnician: varchar("custom_shade_technician"),
    customShadePicturesAvailable: boolean("custom_shade_pictures_available").default(false),
    customShadeVideoAvailable: boolean("custom_shade_video_available").default(false),
    // The specific lab_locations row the case is physically at. Nullable —
    // cases that were located before this column was added (or via legacy
    // paths) will have null here. Cleared server-side when the case is
    // moved to a new station (always written alongside `status`).
    labLocationId: varchar("lab_location_id").references(() => labLocations.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    caseNumberUnique: uniqueIndex("cases_case_number_unique").on(
      table.caseNumber
    ),
    // Atomic guard against two concurrent requests assigning the same barcode
    // to different active cases in the same lab (TOCTOU race that the
    // checkBarcodeUniqueness pre-check alone cannot close). Mirrors the
    // pre-check's predicate: only non-deleted, non-complete cases with a
    // barcode hold a barcode, so a completed case releases it for reuse.
    barcodeUniquePerLab: uniqueIndex("cases_barcode_unique_per_lab")
      .on(table.labOrganizationId, table.casePanBarcode)
      .where(
        sql`deleted_at IS NULL AND case_pan_barcode IS NOT NULL AND status <> 'complete'`,
      ),
    casesDeletedAtIdx: index("cases_deleted_at_idx").on(table.deletedAt),
    caseLabIdx: index("cases_lab_idx").on(table.labOrganizationId),
    caseProviderIdx: index("cases_provider_idx").on(
      table.providerOrganizationId
    ),
    // Worklist scans always begin with tenant/deleted visibility and commonly
    // constrain receipt date, status, or priority before enrichment.
    caseLabReceivedIdx: index("cases_lab_received_idx").on(
      table.labOrganizationId,
      table.deletedAt,
      table.receivedAt,
    ),
    caseProviderReceivedIdx: index("cases_provider_received_idx").on(
      table.providerOrganizationId,
      table.deletedAt,
      table.receivedAt,
    ),
    caseLabStatusPriorityIdx: index("cases_lab_status_priority_idx").on(
      table.labOrganizationId,
      table.deletedAt,
      table.status,
      table.priority,
    ),
    caseSearchTrgmIdx: index("cases_search_trgm_idx").using(
      "gin",
      sql`lower(coalesce(${table.caseNumber}, '') || ' ' || coalesce(${table.patientFirstName}, '') || ' ' || coalesce(${table.patientLastName}, '') || ' ' || coalesce(${table.doctorName}, '') || ' ' || coalesce(${table.casePanBarcode}, '')) gin_trgm_ops`,
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
  // Evidence/override ownership only; clinical values remain on this row.
  // Null preserves historical rows without inventing a clinical role.
  assignmentProvenance: jsonb("assignment_provenance").$type<{
    origin: "manual" | "ai_explicit";
    roleEvidence?: string;
    manualFields: Array<"role" | "product" | "shade">;
  }>(),
  implantRetention: text("implant_retention"),
  implantManufacturer: text("implant_manufacturer"),
  implantPlatformNotes: text("implant_platform_notes"),
  // Required for applicable Removable/Ortho rows; nullable preserves legacy
  // and non-applicable restorative rows.
  arch: text("arch"),
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
}, (table) => ({
  // Every case list joins/aggregates restorations by case. Without this the
  // worklist's restoration summary sequential-scans the whole table.
  caseIdx: index("case_restorations_case_id_idx").on(table.caseId),
  archCheck: check(
    "case_restorations_arch_check",
    sql`arch IS NULL OR arch IN ('upper', 'lower', 'upper_lower')`,
  ),
}));

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
  visibility: text("visibility").default("internal_lab_only").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Prescription scan history is kept separately from authored case notes and
 * the compatibility `cases.rx_notes` field. A null scannedAt is intentional:
 * legacy Rx text has no reliable scan date.
 */
export const caseRxNoteEntries = pgTable(
  "case_rx_note_entries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    caseId: varchar("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    noteText: text("note_text").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    provenance: text("provenance").notNull(),
    submissionId: text("submission_id"),
    payloadHash: text("payload_hash"),
    createdAt: createdAt(),
  },
  (table) => ({
    caseOrderIdx: index("case_rx_note_entries_case_order_idx").on(
      table.caseId,
      table.scannedAt,
      table.createdAt,
    ),
    submissionUnique: uniqueIndex("case_rx_note_entries_submission_unique")
      .on(table.caseId, table.submissionId)
      .where(sql`submission_id IS NOT NULL`),
    provenanceCheck: check(
      "case_rx_note_entries_provenance_check",
      sql`${table.provenance} IN ('legacy', 'ai_reader', 'itero_import', 'case_intake')`,
    ),
  }),
);

export const caseAttachments = pgTable("case_attachments", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .references(() => cases.id, { onDelete: "cascade" }),
  labCaseId: varchar("lab_case_id")
    .references(() => labCases.id, { onDelete: "cascade" }),
  uploadedByUserId: varchar("uploaded_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  uploadedByOrganizationId: varchar("uploaded_by_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  fileType: text("file_type").notNull(),
  /** Client submission identity used to make multi-page Rx retries idempotent. */
  submissionId: text("submission_id"),
  visibility: text("visibility").default("internal_lab_only").notNull(),
  note: text("note"),
  // Optional semantic category for the attachment. Currently only
  // "outgoing" (photo of the completed case as it left the lab, captured by
  // the mobile scan-to-complete flow). Null = uncategorized (default for all
  // regular uploads). Additive-only — never repurpose existing values.
  category: text("category"),
  // When set, this attachment was uploaded as evidence for a case exception
  // (see `caseExceptions`). It still belongs to the case through
  // `caseId`/`labCaseId` so the existing authenticated media pipeline serves
  // it unchanged; the link is purely so the exception detail view can show
  // only its own photos/files. Exception media is always internal-lab-only.
  caseExceptionId: varchar("case_exception_id").references(
    (): AnyPgColumn => caseExceptions.id,
    { onDelete: "set null" },
  ),
  // When set, this exception attachment is evidence for one follow-up note.
  // Keep this as a soft link so backup restores can replace exception notes
  // without a dependency from the generic case-attachment table.
  caseExceptionNoteId: varchar("case_exception_note_id"),
  // Explicit same-case link for a textured scan. The attachment route must
  // authorize both rows against the requested case before serving either.
  textureAttachmentId: varchar("texture_attachment_id").references(
    (): AnyPgColumn => caseAttachments.id,
    { onDelete: "set null" },
  ),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByUserId: varchar("deleted_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
}, (table) => ({
  caseSubmissionUnique: uniqueIndex("case_attachments_submission_unique")
    .on(table.caseId, table.submissionId)
    .where(sql`case_id IS NOT NULL AND submission_id IS NOT NULL`),
  legacySubmissionUnique: uniqueIndex("case_attachments_legacy_submission_unique")
    .on(table.labCaseId, table.submissionId)
    .where(sql`lab_case_id IS NOT NULL AND submission_id IS NOT NULL`),
  caseExceptionNoteIdx: index("case_attachments_exception_note_idx").on(
    table.caseExceptionNoteId,
  ),
}));

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


/**
 * Exception cases — a lab-internal "this case needs special attention" flag.
 *
 * Any active member of the lab can open an exception; opening one atomically
 * moves the case to the On Hold location/status. Only an owner/admin can
 * resolve it, and resolving requires choosing the destination location the
 * case moves to next (the previous location is NOT restored automatically).
 *
 * A case identity is either canonical (`caseId` → `cases.id`) or a legacy
 * mobile-originated blob row (`labCaseId` → `lab_cases.id`); exactly one is
 * set. The two partial unique indexes below are what actually prevent a
 * second *active* exception for the same case — the API pre-check is only a
 * friendlier duplicate message on top of them.
 *
 * All exception content (issue text, notes, media) is internal to the lab and
 * is never exposed to provider/practice viewers.
 */
export const caseExceptions = pgTable(
  "case_exceptions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Canonical case identity. Null for legacy mobile-only cases. */
    caseId: varchar("case_id").references(() => cases.id, {
      onDelete: "cascade",
    }),
    /** Legacy mobile (`lab_cases`) identity. Null for canonical cases. */
    labCaseId: varchar("lab_case_id").references(() => labCases.id, {
      onDelete: "cascade",
    }),
    /** 'active' | 'resolved'. Only 'active' rows appear in dashboard queues. */
    status: text("status").default("active").notNull(),
    /** Free-form description of what is wrong. Optional. */
    issueText: text("issue_text"),
    /** Status/location the case sat at before it was put On Hold. Recorded
     *  for context only — resolution never restores it automatically. */
    previousStatus: text("previous_status"),
    previousLabLocationId: varchar("previous_lab_location_id"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name"),
    resolvedByUserId: varchar("resolved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    resolvedByName: text("resolved_by_name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    /** Destination station chosen by the owner/admin at resolution time. */
    resolutionLabLocationId: varchar("resolution_lab_location_id").references(
      () => labLocations.id,
      { onDelete: "set null" },
    ),
    /** Canonical case status the destination station mapped to. */
    resolutionStatus: text("resolution_status"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labIdx: index("case_exceptions_lab_idx").on(table.labOrganizationId),
    caseIdx: index("case_exceptions_case_idx").on(table.caseId),
    labCaseIdx: index("case_exceptions_lab_case_idx").on(table.labCaseId),
    activeCaseUniq: uniqueIndex("case_exceptions_active_case_uniq")
      .on(table.caseId)
      .where(sql`status = 'active' and case_id is not null`),
    activeLabCaseUniq: uniqueIndex("case_exceptions_active_lab_case_uniq")
      .on(table.labCaseId)
      .where(sql`status = 'active' and lab_case_id is not null`),
  }),
);

/**
 * Internal discussion notes attached to an exception.
 *
 * These deliberately do NOT live in `case_notes`: that table's `case_id` has
 * a hard NOT NULL FK to `cases.id`, so legacy mobile cases could never carry
 * one. Keeping exception notes here means canonical and legacy exceptions
 * behave identically, and the notes stay scoped to (and deleted with) the
 * exception rather than leaking into the provider-visible case note stream.
 */
export const caseExceptionNotes = pgTable(
  "case_exception_notes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    caseExceptionId: varchar("case_exception_id")
      .notNull()
      .references(() => caseExceptions.id, { onDelete: "cascade" }),
    authorUserId: varchar("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorName: text("author_name"),
    noteText: text("note_text").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    exceptionIdx: index("case_exception_notes_exception_idx").on(
      table.caseExceptionId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);

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
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Stable doctor profile identity captured when the invoice is created.
    // Null is preserved for historical and legacy-blob invoices.
    doctorIdentity: varchar("doctor_identity").references(
      () => doctorProfiles.id,
      { onDelete: "set null" },
    ),
    status: text("status").default("open").notNull(),
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
    layoutPresetId: varchar("layout_preset_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: varchar("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    voidKind: text("void_kind"),
    sourceInvoiceId: varchar("source_invoice_id"),
    frozen: boolean("frozen").default(false).notNull(),
    caseDeletedAt: timestamp("case_deleted_at", { withTimezone: true }),
    caseDeletedByUserId: varchar("case_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    caseDeletedNote: text("case_deleted_note"),
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
      table.labOrganizationId,
      table.invoiceNumber
    ),
    invoicesDeletedAtIdx: index("invoices_deleted_at_idx").on(table.deletedAt),
    invoicesProviderOrgIdx: index("invoices_provider_org_idx").on(
      table.providerOrganizationId,
    ),
    invoicesDoctorIdentityIdx: index("invoices_doctor_identity_idx").on(
      table.labOrganizationId,
      table.providerOrganizationId,
      table.doctorIdentity,
    ),
    invoicesLabOrgIdx: index("invoices_lab_org_idx").on(
      table.labOrganizationId,
    ),
    invoicesAiGeneratedIdx: index("invoices_ai_generated_idx").on(
      table.aiGenerated,
    ),
    // The case lists resolve a price per candidate case through a correlated
    // "newest live invoice for this case" subquery, so this runs once per row
    // of the candidate set.
    invoicesCaseIdx: index("invoices_case_id_idx").on(table.caseId),
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
    // Immutable invoice totals shown on the issued statement, keyed by invoice
    // id. Nullable so statements created before this snapshot was introduced
    // remain distinguishable from statements with exact captured amounts.
    invoiceAmountsJson: jsonb("invoice_amounts_json"),
    // Immutable receipt-visible invoice identity, issue/due dates, and status
    // captured when the statement is issued. Nullable for legacy statements
    // that predate detail snapshots; older JSON entries may contain identity
    // only and are handled with live-value compatibility fallbacks.
    invoiceDetailsJson: jsonb("invoice_details_json"),
    pdfStorageKey: text("pdf_storage_key"),
    pdfFileName: text("pdf_file_name"),
    pdfFileSize: integer("pdf_file_size"),
    // Durable manifest for practice bundles: every doctor PDF attached to the
    // practice message plus the addresses it was delivered to. Nullable —
    // legacy single-PDF statements keep using the pdf_* columns alone, which
    // stay populated (with the first attachment) for bundles as well.
    bundleManifestJson: jsonb("bundle_manifest_json"),
    // Nullable: the monthly scheduler has no acting user. onDelete "set null"
    // prevents a user deletion from blocking or cascade-deleting statements.
    createdByUserId: varchar("created_by_user_id")
      .references(() => users.id, { onDelete: "set null" })
      .default(sql`NULL`),
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
    // Nullable: the monthly scheduler and batch-send paths have no acting user.
    // onDelete "set null" prevents a user deletion from blocking send records.
    sentByUserId: varchar("sent_by_user_id")
      .references(() => users.id, { onDelete: "set null" })
      .default(sql`NULL`),
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
  sourceType: text("source_type").notNull().default("manual"),
  sourceKey: text("source_key"),
  sourceRestorationIdsJson: jsonb("source_restoration_ids_json"),
  parentLineItemId: varchar("parent_line_item_id").references(
    (): AnyPgColumn => invoiceLineItems.id,
    { onDelete: "cascade" }
  ),
  toothNumber: integer("tooth_number"),
  toothLabel: varchar("tooth_label"),
  description: text("description").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  lineTotal: decimal("line_total", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  isDiscount: boolean("is_discount").notNull().default(false),
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
  // Links this payment row to the bank transaction that was created when the
  // payment was recorded (the Undeposited Funds entry). Nullable for legacy
  // rows created before this column was added. Set null on bank-transaction
  // delete so the payment row is kept for history even if the txn is removed.
  bankTransactionId: varchar("bank_transaction_id").references(
    (): AnyPgColumn => bankTransactions.id,
    { onDelete: "set null" }
  ),
  paymentSessionId: varchar("payment_session_id").references(
    (): AnyPgColumn => statementPaymentSessions.id,
    { onDelete: "set null" }
  ),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  // Stripe identifiers are populated only for provider-hosted checkout
  // payments. They are processor references, never card details.
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  providerPaymentCheckoutId: varchar("provider_payment_checkout_id").references(
    (): AnyPgColumn => providerPaymentCheckouts.id,
    { onDelete: "set null" },
  ),
  paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
  recordedByUserId: varchar("recorded_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});

/**
 * A statement-led customer payment is one accounting event even when it
 * applies to several invoices.  Keeping the event separate from the
 * invoice-level payment rows lets us preserve the received amount,
 * unapplied credit, customer snapshot, and exact reversal boundary.
 */
export const statementPaymentSessions = pgTable(
  "statement_payment_sessions",
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
    // Null means the entire practice (and preserves historical rows). There
    // is no doctor FK on invoices today, so this is the normalized canonical
    // doctor name; doctorDisplayName is the immutable receipt snapshot.
    doctorIdentity: text("doctor_identity"),
    doctorDisplayName: text("doctor_display_name"),
    statementId: varchar("statement_id").references(
      () => practiceStatements.id,
      { onDelete: "set null" }
    ),
    bankTransactionId: varchar("bank_transaction_id").references(
      (): AnyPgColumn => bankTransactions.id,
      { onDelete: "set null" }
    ),
    // Links a lab Receive-Payments receipt to its processor reservation. This
    // permits a retry after a process crash between Stripe settlement and the
    // local receipt/Undeposited Funds transaction.
    providerPaymentCheckoutId: varchar("provider_payment_checkout_id").references(
      (): AnyPgColumn => providerPaymentCheckouts.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: text("idempotency_key"),
    requestFingerprint: text("request_fingerprint").notNull(),
    receiptNumber: text("receipt_number").notNull(),
    receivedAmount: decimal("received_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    appliedAmount: decimal("applied_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    customerCreditAmount: decimal("customer_credit_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    accountBalanceAfter: decimal("account_balance_after", {
      precision: 12,
      scale: 2,
    }).notNull(),
    paymentMethod: text("payment_method").notNull(),
    checkNumber: text("check_number"),
    cardLast4: text("card_last4"),
    memo: text("memo"),
    paymentDate: timestamp("payment_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerAddressJson: jsonb("customer_address_json"),
    labName: text("lab_name").notNull(),
    receiptLogoBase64: text("receipt_logo_base64"),
    receiptLogoContentType: text("receipt_logo_content_type"),
    status: text("status").default("undeposited").notNull(),
    receiptEmailStatus: text("receipt_email_status"),
    receiptEmailReason: text("receipt_email_reason"),
    receiptEmailSentAt: timestamp("receipt_email_sent_at", {
      withTimezone: true,
    }),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    cancelledByUserId: varchar("cancelled_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    statementPaymentSessionsLabIdx: index(
      "statement_payment_sessions_lab_idx"
    ).on(table.labOrganizationId),
    statementPaymentSessionsProviderIdx: index(
      "statement_payment_sessions_provider_idx"
    ).on(table.providerOrganizationId),
    statementPaymentSessionsBankTxnIdx: index(
      "statement_payment_sessions_bank_txn_idx"
    ).on(table.bankTransactionId),
    statementPaymentSessionsProviderCheckoutUnique: uniqueIndex(
      "statement_payment_sessions_provider_checkout_unique",
    )
      .on(table.providerPaymentCheckoutId)
      .where(sql`provider_payment_checkout_id IS NOT NULL`),
    statementPaymentSessionsIdempotencyUnique: uniqueIndex(
      "statement_payment_sessions_idempotency_unique"
    ).on(table.labOrganizationId, table.idempotencyKey),
    statementPaymentSessionsReceiptUnique: uniqueIndex(
      "statement_payment_sessions_receipt_unique"
    ).on(table.labOrganizationId, table.receiptNumber),
  })
);

/**
 * Durable processor and accounting state for a reversal of a saved-card
 * statement receipt.  Keeping this separate from the receipt is important:
 * Stripe can have accepted a refund while the process dies before local
 * accounting commits, and a later retry must not create another refund.
 */
export const statementPaymentReversals = pgTable(
  "statement_payment_reversals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    paymentSessionId: varchar("payment_session_id")
      .notNull()
      .references(() => statementPaymentSessions.id, { onDelete: "restrict" }),
    processorIdempotencyKey: text("processor_idempotency_key").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripeRefundId: text("stripe_refund_id"),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").default("usd").notNull(),
    // pending_processor | processor_succeeded | completed | failed
    status: text("status").default("pending_processor").notNull(),
    failureReason: text("failure_reason"),
    processorLeaseToken: text("processor_lease_token"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    initiatedByUserId: varchar("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    sessionUnique: uniqueIndex("statement_payment_reversals_session_unique").on(
      table.paymentSessionId,
    ),
    statusIdx: index("statement_payment_reversals_status_idx").on(table.status),
    refundUnique: uniqueIndex("statement_payment_reversals_refund_unique")
      .on(table.stripeRefundId)
      .where(sql`stripe_refund_id IS NOT NULL`),
  }),
);
/**
 * Stripe customer identity for provider organizations. Kept separate from
 * subscription billing so invoice payment credentials never become
 * subscription entitlement state.
 */
export const providerPaymentCustomers = pgTable(
  "provider_payment_customers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    // Null preserves legacy default-card behavior; "none" explicitly denies
    // reuse. Subscription Checkout must not implicitly authorize a new card.
    authorizedPaymentMethodId: text("authorized_payment_method_id"),
    // Processor-safe mirror of the current default card. These fields are the
    // only card metadata exposed to account-sync consumers; payment-method ids,
    // PANs, CVCs, and processor payloads are never persisted here.
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    cardStatus: text("card_status"),
    cardUpdatedAt: timestamp("card_updated_at", { withTimezone: true }),
    // Safe processor billing-address summary; never store Stripe ids or PAN/CVC.
    cardBillingAddressJson: jsonb("card_billing_address_json"),
    // Provider-controlled invoice auto-pay for this lab relationship. The
    // payment customer/card is shared by the provider and lab, while consent
    // remains independent per provider organization.
    invoiceAutoPayEnabled: boolean("invoice_auto_pay_enabled")
      .default(false)
      .notNull(),
    invoiceAutoPayChargeDay: integer("invoice_auto_pay_charge_day")
      .default(10)
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    providerOrgUnique: uniqueIndex(
      "provider_payment_customers_provider_org_unique",
    ).on(table.providerOrganizationId),
    stripeCustomerUnique: uniqueIndex(
      "provider_payment_customers_stripe_customer_unique",
    ).on(table.stripeCustomerId),
  }),
);

/**
 * One hosted Stripe Checkout attempt for one external provider charge.
 * The attempt is the idempotency boundary for webhook and return-link
 * retries; allocations below describe how that single charge is applied.
 */
export const providerPaymentCheckouts = pgTable(
  "provider_payment_checkouts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    initiatedByUserId: varchar("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientRequestId: text("client_request_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    checkoutUrl: text("checkout_url"),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").default("usd").notNull(),
    savePaymentMethod: boolean("save_payment_method").default(false).notNull(),
    // Canonical inline Receive Payments draft. This contains only accounting
    // inputs (never PAN/CVC or other raw card data), allowing webhook and
    // browser-recovery finalization after the originating process exits.
    inlineDraftJson: jsonb("inline_draft_json"),
    inlineDraftFingerprint: text("inline_draft_fingerprint"),
    status: text("status").default("pending").notNull(),
    failureReason: text("failure_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    providerOrgIdx: index("provider_payment_checkouts_provider_org_idx").on(
      table.providerOrganizationId,
    ),
    clientRequestUnique: uniqueIndex(
      "provider_payment_checkouts_client_request_unique",
    )
      .on(table.providerOrganizationId, table.clientRequestId)
      .where(sql`client_request_id IS NOT NULL`),
    stripeSessionUnique: uniqueIndex(
      "provider_payment_checkouts_stripe_session_unique",
    )
      .on(table.stripeCheckoutSessionId)
      .where(sql`stripe_checkout_session_id IS NOT NULL`),
    stripePaymentIntentUnique: uniqueIndex(
      "provider_payment_checkouts_stripe_payment_intent_unique",
    )
      .on(table.stripePaymentIntentId)
      .where(sql`stripe_payment_intent_id IS NOT NULL`),
    statusIdx: index("provider_payment_checkouts_status_idx").on(table.status),
  }),
);

export const providerPaymentAllocations = pgTable(
  "provider_payment_allocations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    checkoutId: varchar("checkout_id")
      .notNull()
      .references(() => providerPaymentCheckouts.id, { onDelete: "cascade" }),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    checkoutInvoiceUnique: uniqueIndex(
      "provider_payment_allocations_checkout_invoice_unique",
    ).on(table.checkoutId, table.invoiceId),
    checkoutIdx: index("provider_payment_allocations_checkout_idx").on(
      table.checkoutId,
    ),
    invoiceIdx: index("provider_payment_allocations_invoice_idx").on(
      table.invoiceId,
    ),
  }),
);

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
    // Default percentage discount (0-100) applied to every item, calculated
    // off the practice's default tier price. Nullable = no default discount.
    discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }),
    // Per-item percentage discount overrides, keyed by price key. An entry
    // here wins over `discountPercent` for that key. Each value is 0-100.
    discountPercentsJson: jsonb("discount_percents_json").default({}).notNull(),
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
    csrfTokenHash: text("csrf_token_hash"),
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

export const notifications = pgTable(
  "notifications",
  {
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
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    dedupeKeyUnique: uniqueIndex("notifications_dedupe_key_unique").on(
      table.dedupeKey,
    ),
  }),
);

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
    accountType: text("account_type"),
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
    description: text("description"),
    isArchived: boolean("is_archived").default(false).notNull(),
    /** Stable lookup key for system-default categories. Allowed values:
     *  "accounts_receivable" | "accounts_payable". User-created = null. */
    categoryType: text("category_type"),
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
    vendorId: varchar("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
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

/**
 * Audit record for each AI-assisted bank-statement import batch.
 * Created by POST /finance/transactions/import/confirm.
 * Owner-role only; importBatchId on bank_transactions FK references this id.
 */
export const bankImportBatches = pgTable(
  "bank_import_batches",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: varchar("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    sourceFilename: text("source_filename").notNull(),
    importedByUserId: varchar("imported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    transactionCount: integer("transaction_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    bankImportBatchOrgIdx: index("bank_import_batches_org_idx").on(
      table.organizationId
    ),
    bankImportBatchAcctIdx: index("bank_import_batches_account_idx").on(
      table.bankAccountId
    ),
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
    vendorId: varchar("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    importBatchId: text("import_batch_id").references(
      () => bankImportBatches.id,
      { onDelete: "set null" }
    ),
    aiImportSource: text("ai_import_source"),
    transferGroupId: varchar("transfer_group_id"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    depositedByUserId: varchar("deposited_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    depositedAt: timestamp("deposited_at", { withTimezone: true }),
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

/**
 * A deposit batch keeps the original Undeposited Funds payment entries as
 * non-posting audit children of the single destination-bank transaction.
 */
export const bankDepositBatchMembers = pgTable(
  "bank_deposit_batch_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    aggregateBankTransactionId: varchar("aggregate_bank_transaction_id")
      .notNull()
      .references((): AnyPgColumn => bankTransactions.id, { onDelete: "cascade" }),
    childBankTransactionId: varchar("child_bank_transaction_id")
      .notNull()
      .references((): AnyPgColumn => bankTransactions.id, { onDelete: "restrict" }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** Immutable payment details captured when the membership is created. */
    snapshot: jsonb("snapshot").notNull().default(sql`'{}'::jsonb`),
    /** Set once at release: restored for siblings, corrected for the triggering child. */
    releaseOutcome: text("release_outcome"),
    createdAt: createdAt(),
  },
  (table) => ({
    childUnique: uniqueIndex("bank_deposit_batch_members_child_unique")
      .on(table.childBankTransactionId)
      .where(sql`released_at IS NULL`),
    aggregateChildUnique: uniqueIndex("bank_deposit_batch_members_aggregate_child_unique").on(
      table.aggregateBankTransactionId,
      table.childBankTransactionId,
    ),
    aggregateIdx: index("bank_deposit_batch_members_aggregate_idx").on(
      table.aggregateBankTransactionId,
    ),
    childIdx: index("bank_deposit_batch_members_child_idx").on(
      table.childBankTransactionId,
    ),
  }),
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
    statementFormat: text("statement_format")
      .$type<"per_doctor" | "consolidated">()
      .default("per_doctor")
      .notNull(),
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
    // Set for practice bundles: which issued statement holds the doctor PDFs
    // and which addresses the sender chose. A retry re-sends exactly that,
    // instead of recomputing a consolidated statement for the whole month.
    // Null for non-bundle sends; retryScopeJson records manual rebuild filters.
    bundleContextJson: jsonb("bundle_context_json"),
    // Original manual invoice filters for retries that must rebuild a
    // statement instead of replaying an issued practice bundle.
    retryScopeJson: jsonb("retry_scope_json"),
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

/**
 * Short-lived, capability-style tokens that back the secure SMS statement
 * links. The token itself is the capability; the row records exactly which
 * single recipient's statement to regenerate so no PHI is embedded in the SMS.
 * These rows are ephemeral link metadata (not lab data) and may be hard-deleted.
 */
export const statementLinkTokens = pgTable(
  "statement_link_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    token: varchar("token").notNull().unique(),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // "practice" | "doctor"
    recipientType: text("recipient_type").notNull(),
    // provider org id (practice mode) or doctor name (doctor mode)
    recipientKey: text("recipient_key").notNull(),
    // Resolved practice org (used for authorization/display); null for
    // doctor groups that could not be tied to a provider org.
    practiceOrganizationId: varchar("practice_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    practiceName: text("practice_name").notNull(),
    invoiceScope: text("invoice_scope").notNull(),
    customFrom: timestamp("custom_from", { withTimezone: true }),
    customTo: timestamp("custom_to", { withTimezone: true }),
    periodLabel: text("period_label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("statement_link_tokens_token_idx").on(table.token),
    expiresIdx: index("statement_link_tokens_expires_idx").on(table.expiresAt),
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
    description: text("description"),
    isDiscount: boolean("is_discount").notNull().default(false),
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
 *   grace    → deactivated (grace period elapsed; read-only, never a login lockout)
 *   active   → past_due (renewal failed)
 *   past_due → active  (payment recovered)
 *   past_due → grace   (retries exhausted)
 *   active / past_due / grace → canceled
 *   deactivated = durable read-only state after payment access ends
 *   locked / canceled = legacy values, interpreted as read-only for compatibility
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
    // trialing | active | past_due | grace | deactivated. locked/canceled
    // remain accepted legacy values and are interpreted as read-only.
    status: text("status").default("trialing").notNull(),
    trialStartAt: timestamp("trial_start_at", { withTimezone: true }),
    trialEndAt: timestamp("trial_end_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    paymentMethodOnFile: boolean("payment_method_on_file")
      .default(false)
      .notNull(),
    // Provider subscription auto-pay preference. This is intentionally
    // separate from paymentMethodOnFile, which describes processor state.
    autoPayEnabled: boolean("auto_pay_enabled").default(false).notNull(),
    autoPayChargeDay: integer("auto_pay_charge_day").default(10).notNull(),
    lastReminderSentAt: timestamp("last_reminder_sent_at", {
      withTimezone: true,
    }),
    lastReminderKind: text("last_reminder_kind"),
    gracePeriodStartAt: timestamp("grace_period_start_at", {
      withTimezone: true,
    }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    // Current plan identifiers — set when a Stripe checkout completes or a
    // subscription update webhook fires. Null for legacy/RC/trial-only rows.
    stripePriceId: text("stripe_price_id"),
    planType: text("plan_type"),       // "lab" | "provider"
    billingInterval: text("billing_interval"), // "month" | "year"
    // Provider plans are intentionally independent of processor price IDs.
    // Valid application values are "basic", "standard", and "premium".
    // Null is retained for lab subscriptions and provider rows created before
    // provider plans were introduced.
    providerPlan: text("provider_plan"),
    // Durable provider signup attempt and separately versioned card-reuse consent.
    // Stripe identifiers here are private processor references, never card data.
    providerOnboardingJson: jsonb("provider_onboarding_json"),
    // A waiver is an administrative, time-bounded exception to payment
    // lockout. It does not mark a subscription as paid or change its plan.
    // The API requires waiverReason whenever it creates or changes a waiver;
    // the columns remain nullable so a waiver can be removed.
    waiverReason: text("waiver_reason"),
    waiverStartsAt: timestamp("waiver_starts_at", { withTimezone: true }),
    // Null means an indefinite waiver, once its start time has passed.
    waiverEndsAt: timestamp("waiver_ends_at", { withTimezone: true }),
    waiverGrantedByUserId: varchar("waiver_granted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    waiverGrantedAt: timestamp("waiver_granted_at", { withTimezone: true }),
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
    rcUserIdx: uniqueIndex("subscriptions_rc_user_idx").on(
      table.revenueCatAppUserId
    ).where(sql`revenue_cat_app_user_id IS NOT NULL AND deleted_at IS NULL`),
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

/**
 * One server-owned provider auto-pay attempt. The unique scheduled date is
 * claimed before contacting Stripe, so multiple API instances cannot charge
 * the same preference twice. A processing attempt is intentionally terminal
 * for the scheduler: Stripe calls are never retried automatically.
 */
export const providerAutoPayAttempts = pgTable(
  "provider_auto_pay_attempts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscriptionId: varchar("subscription_id").references(
      () => subscriptions.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(), // "subscription" | "invoice" | "..._reminder"
    scheduledFor: timestamp("scheduled_for", {
      withTimezone: true,
    }).notNull(),
    amount: decimal("amount", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    status: text("status").default("processing").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    providerPaymentCheckoutId: varchar("provider_payment_checkout_id").references(
      () => providerPaymentCheckouts.id,
      { onDelete: "set null" },
    ),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    scheduleUnique: uniqueIndex("provider_auto_pay_attempts_schedule_unique").on(
      table.providerOrganizationId,
      table.kind,
      table.scheduledFor,
    ),
    providerOrgIdx: index("provider_auto_pay_attempts_provider_org_idx").on(
      table.providerOrganizationId,
    ),
    statusIdx: index("provider_auto_pay_attempts_status_idx").on(table.status),
  }),
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
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    notes: text("notes"),
    unitPrice: decimal("unit_price", { precision: 10, scale: 2 }),
    // Stable association to the canonical pricing resolver. Kept separate
    // from name so renaming an item cannot silently change its effective price.
    priceKey: text("price_key"),
    // For billable items only: sub-classification of the item, one of
    // "Restorative" | "Removable" | "Appliance". Null for vendors/employees
    // and for items left uncategorized.
    itemCategory: text("item_category"),
    // Legacy: kept for back-compat / migration period. New code reads
    // `vendorTypeId` which points at a per-lab row in `vendor_types`.
    // For builtin types this still mirrors `builtin_kind`; for custom
    // user-created types it defaults to "vendor" so old enum-based
    // queries don't 500.
    vendorType: text("vendor_type").notNull().default("vendor"),
    // FK into per-lab vendor_types. Nullable for newly-created rows
    // before the per-lab seeding helper has run (ensureVendorTypesSeeded
    // backfills this on first finance call).
    vendorTypeId: varchar("vendor_type_id").references(
      (): AnyPgColumn => vendorTypes.id,
      { onDelete: "restrict" },
    ),
    isActive: boolean("is_active").default(true).notNull(),
    // Default net terms in days, used to propose a bill's due date. Snapshotted
    // onto the bill at entry so later edits here cannot move historical dues.
    paymentTermsDays: integer("payment_terms_days"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    vendorLabIdx: index("vendors_lab_idx").on(table.labOrganizationId),
    vendorTypeIdx: index("vendors_vendor_type_idx").on(table.vendorTypeId),
  })
);

/**
 * ───────────────────────── Accounts Payable subledger ─────────────────────────
 *
 * A vendor bill is what a vendor has billed the lab but the lab has not yet
 * paid. Entering one recognizes the expense and raises the AP liability; it
 * deliberately does NOT touch a bank account. Money only leaves when a
 * `vendor_payments` row is recorded against the bill.
 *
 * This subledger is purely additive. Legacy register checks remain immediate
 * cash expenses — a historical check is not evidence of an unpaid bill, so no
 * bill is ever inferred from a payee name or from the "Accounts Payable"
 * category label. See docs/ap-ar-workflow-contract.md.
 */
export const vendorBills = pgTable(
  "vendor_bills",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: varchar("vendor_id")
      .notNull()
      .references((): AnyPgColumn => vendors.id, { onDelete: "restrict" }),
    // The vendor's own invoice reference. Duplicates are warned about rather
    // than blocked: a vendor legitimately reusing a reference must stay
    // recordable, but the user has to see the conflict first.
    billNumber: text("bill_number"),
    billDate: timestamp("bill_date", { withTimezone: true }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    // Net terms in days, snapshotted from the vendor at entry time so later
    // vendor edits cannot retroactively move a historical due date.
    termsDays: integer("terms_days"),
    memo: text("memo"),
    total: decimal("total", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    // Settled via cash payment allocations.
    amountPaid: decimal("amount_paid", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    // Settled via vendor credit allocations. Kept separate from amountPaid so
    // reports can tell "we paid it" apart from "a credit absorbed it".
    amountCredited: decimal("amount_credited", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    balanceDue: decimal("balance_due", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    // open | partially_paid | paid | void
    status: text("status").default("open").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: varchar("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labIdx: index("vendor_bills_lab_idx").on(table.labOrganizationId),
    vendorIdx: index("vendor_bills_vendor_idx").on(
      table.labOrganizationId,
      table.vendorId,
    ),
    dueDateIdx: index("vendor_bills_due_date_idx").on(
      table.labOrganizationId,
      table.dueDate,
    ),
    statusIdx: index("vendor_bills_status_idx").on(
      table.labOrganizationId,
      table.status,
    ),
    // Supports the duplicate-reference warning lookup. Intentionally not
    // unique — see billNumber above.
    referenceIdx: index("vendor_bills_reference_idx").on(
      table.labOrganizationId,
      table.vendorId,
      table.billNumber,
    ),
  }),
);

/** Categorized expense detail for a bill. Line sum must equal `total`. */
export const vendorBillLines = pgTable(
  "vendor_bill_lines",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    billId: varchar("bill_id")
      .notNull()
      .references((): AnyPgColumn => vendorBills.id, { onDelete: "cascade" }),
    categoryId: varchar("category_id").references(
      () => transactionCategories.id,
      { onDelete: "set null" },
    ),
    description: text("description").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    billIdx: index("vendor_bill_lines_bill_idx").on(table.billId),
  }),
);

/**
 * A credit the vendor owes the lab (a return, an overpayment, a negotiated
 * adjustment). Applying it to a bill reduces AP without any cash movement.
 */
export const vendorCredits = pgTable(
  "vendor_credits",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: varchar("vendor_id")
      .notNull()
      .references((): AnyPgColumn => vendors.id, { onDelete: "restrict" }),
    creditNumber: text("credit_number"),
    creditDate: timestamp("credit_date", { withTimezone: true }).notNull(),
    categoryId: varchar("category_id").references(
      () => transactionCategories.id,
      { onDelete: "set null" },
    ),
    memo: text("memo"),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    amountApplied: decimal("amount_applied", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    remainingAmount: decimal("remaining_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    // open | applied | void
    status: text("status").default("open").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: varchar("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labIdx: index("vendor_credits_lab_idx").on(table.labOrganizationId),
    vendorIdx: index("vendor_credits_vendor_idx").on(
      table.labOrganizationId,
      table.vendorId,
    ),
  }),
);

/**
 * One Pay Bills event for ONE vendor. Selecting several vendors in the Pay
 * Bills screen creates several of these, each with its own bank withdrawal,
 * so a multi-vendor run never collapses into one indistinguishable payment.
 *
 * `bankAccountId`/`bankTransactionId` are null when the payment is funded
 * entirely by vendor credit — that settles AP without moving any cash.
 */
export const vendorPayments = pgTable(
  "vendor_payments",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: varchar("vendor_id")
      .notNull()
      .references((): AnyPgColumn => vendors.id, { onDelete: "restrict" }),
    paymentDate: timestamp("payment_date", { withTimezone: true }).notNull(),
    // check | ach | card | cash | other. These record a payment the lab made
    // externally; LabTrax does not send money to vendors.
    paymentMethod: text("payment_method").notNull(),
    referenceNumber: text("reference_number"),
    memo: text("memo"),
    bankAccountId: varchar("bank_account_id").references(
      () => bankAccounts.id,
      { onDelete: "restrict" },
    ),
    bankTransactionId: varchar("bank_transaction_id").references(
      (): AnyPgColumn => bankTransactions.id,
      { onDelete: "set null" },
    ),
    cashAmount: decimal("cash_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    creditAmount: decimal("credit_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    totalAmount: decimal("total_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    // Tenant-scoped so one lab cannot observe or collide with another's keys.
    // Suffixed with the vendor id so one multi-vendor run writes one row per
    // vendor; requestKey keeps the caller's unmodified key for exact replay
    // lookup, and requestFingerprint proves a replay carries the same request
    // as the run that already posted.
    idempotencyKey: text("idempotency_key"),
    requestKey: text("request_key"),
    requestFingerprint: text("request_fingerprint"),
    // posted | void
    status: text("status").default("posted").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: varchar("voided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labIdx: index("vendor_payments_lab_idx").on(table.labOrganizationId),
    vendorIdx: index("vendor_payments_vendor_idx").on(
      table.labOrganizationId,
      table.vendorId,
    ),
    dateIdx: index("vendor_payments_date_idx").on(
      table.labOrganizationId,
      table.paymentDate,
    ),
    bankTxnIdx: index("vendor_payments_bank_txn_idx").on(
      table.bankTransactionId,
    ),
    idempotencyUnique: uniqueIndex("vendor_payments_idempotency_unique")
      .on(table.labOrganizationId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    requestKeyIdx: index("vendor_payments_request_key_idx").on(
      table.labOrganizationId,
      table.requestKey,
    ),
  }),
);

/**
 * How one vendor payment was split across bills. A row funded by a vendor
 * credit carries `vendorCreditId` and contributes to the bill's
 * `amountCredited`; a cash-funded row contributes to `amountPaid`.
 */
export const vendorPaymentAllocations = pgTable(
  "vendor_payment_allocations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    vendorPaymentId: varchar("vendor_payment_id")
      .notNull()
      .references((): AnyPgColumn => vendorPayments.id, {
        onDelete: "cascade",
      }),
    billId: varchar("bill_id")
      .notNull()
      .references((): AnyPgColumn => vendorBills.id, { onDelete: "restrict" }),
    vendorCreditId: varchar("vendor_credit_id").references(
      (): AnyPgColumn => vendorCredits.id,
      { onDelete: "restrict" },
    ),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    // Dated separately from createdAt so historical reports reconstruct
    // balances from when the settlement happened, not when the row was typed.
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    paymentIdx: index("vendor_payment_allocations_payment_idx").on(
      table.vendorPaymentId,
    ),
    billIdx: index("vendor_payment_allocations_bill_idx").on(table.billId),
    creditIdx: index("vendor_payment_allocations_credit_idx").on(
      table.vendorCreditId,
    ),
    appliedAtIdx: index("vendor_payment_allocations_applied_at_idx").on(
      table.appliedAt,
    ),
  }),
);

/** Dated audit trail for every AP correction. Append-only. */
export const vendorBillEvents = pgTable(
  "vendor_bill_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billId: varchar("bill_id").references((): AnyPgColumn => vendorBills.id, {
      onDelete: "cascade",
    }),
    vendorPaymentId: varchar("vendor_payment_id").references(
      (): AnyPgColumn => vendorPayments.id,
      { onDelete: "cascade" },
    ),
    vendorCreditId: varchar("vendor_credit_id").references(
      (): AnyPgColumn => vendorCredits.id,
      { onDelete: "cascade" },
    ),
    eventType: text("event_type").notNull(),
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadataJson: jsonb("metadata_json"),
    // Immutable accounting snapshot of the bill as it stood after this
    // event. Dated reports read these instead of the mutable bill row, so
    // editing a bill today cannot rewrite a prior period's payable or
    // expense. Null on events that do not change the bill itself.
    effectiveBillDate: timestamp("effective_bill_date", { withTimezone: true }),
    effectiveDueDate: timestamp("effective_due_date", { withTimezone: true }),
    effectiveTotal: decimal("effective_total", { precision: 12, scale: 2 }),
    effectiveLinesJson: jsonb("effective_lines_json"),
  },
  (table) => ({
    labIdx: index("vendor_bill_events_lab_idx").on(table.labOrganizationId),
    billIdx: index("vendor_bill_events_bill_idx").on(table.billId),
    paymentIdx: index("vendor_bill_events_payment_idx").on(
      table.vendorPaymentId,
    ),
  }),
);

/**
 * Settlements that were undone, kept with the dates they lived between.
 *
 * Cancelling a payment session, deleting the bank transaction behind a
 * payment, or reversing an invoice's payments removes the settlement rows
 * outright, which is right for today's balances and wrong for history: a
 * payment recorded for the 1st and cancelled on the 20th really did settle
 * the invoice for those nineteen days. Archiving it here — with the date it
 * settled and the date it was undone — is what lets a dated report answer
 * for a day inside that window without guessing.
 *
 * Rows are written only as part of the transaction that removes the
 * settlement, and are never updated afterwards.
 */
export const reversedInvoiceSettlements = pgTable(
  "reversed_invoice_settlements",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id").notNull(),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
    /** "payment" | "customer_credit_application". */
    sourceType: text("source_type").notNull(),
    /** The removed row's id, for tracing back to receipts and audit logs. */
    sourceId: varchar("source_id"),
    paymentSessionId: varchar("payment_session_id"),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    /** The date the money or credit was recorded against the invoice. */
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    /** When the settlement stopped counting. */
    reversedAt: timestamp("reversed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reversedByUserId: varchar("reversed_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    labIdx: index("reversed_invoice_settlements_lab_idx").on(
      table.labOrganizationId,
    ),
    invoiceIdx: index("reversed_invoice_settlements_invoice_idx").on(
      table.invoiceId,
      table.settledAt,
    ),
  }),
);

/**
 * Immutable accounting snapshots of an invoice, one per change that matters
 * to the books.
 *
 * Invoices are written from many places — case sync, statements, payments,
 * bulk tools — so the snapshots are recorded by a database trigger rather
 * than by each writer (see `record_invoice_accounting_event` in the API
 * server's db-constraints setup). That makes the history impossible to
 * bypass, and it is what lets a dated report say what the books held on a
 * past date instead of restating that date with today's amounts: an invoice
 * issued for $100 in January and raised to $150 in March still reads $100
 * for January, with the $50 recognized in March.
 *
 * Rows are never updated. They cascade away only if the invoice row itself
 * is hard-deleted, which the app does not do outside test cleanup.
 */
export const invoiceAccountingEvents = pgTable(
  "invoice_accounting_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id").notNull(),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references((): AnyPgColumn => invoices.id, { onDelete: "cascade" }),
    /** "created" | "issued" | "updated" | "voided" | "deleted". */
    eventType: text("event_type").notNull(),
    /** When the change was made — the period an edit or void belongs to. */
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    effectiveStatus: text("effective_status"),
    effectiveTotal: decimal("effective_total", { precision: 12, scale: 2 }),
    /**
     * What the invoice itself said was still owed then. Cancelling a payment
     * deletes its payment rows, so this is the only contemporaneous evidence
     * that a settlement — full or partial — once existed.
     */
    effectiveBalanceDue: decimal("effective_balance_due", {
      precision: 12,
      scale: 2,
    }),
    effectiveIssuedAt: timestamp("effective_issued_at", { withTimezone: true }),
    /** The due date in force then — aging buckets are dated history too. */
    effectiveDueAt: timestamp("effective_due_at", { withTimezone: true }),
    effectiveVoidedAt: timestamp("effective_voided_at", { withTimezone: true }),
    effectiveDeletedAt: timestamp("effective_deleted_at", {
      withTimezone: true,
    }),
    /** The invoice's own creation time, used when it has no issue date. */
    effectiveCreatedAt: timestamp("effective_created_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    labIdx: index("invoice_accounting_events_lab_idx").on(
      table.labOrganizationId,
    ),
    invoiceIdx: index("invoice_accounting_events_invoice_idx").on(
      table.invoiceId,
      table.occurredAt,
    ),
  }),
);

/**
 * Per-lab customizable payee types. Replaces the previous hard-coded
 * `["vendor","employee","item"]` enum on `vendors.vendor_type`. Each lab
 * gets the three built-in types seeded on first access (rows with
 * `is_builtin=true` and `builtin_kind` set), and admins can add/rename/
 * remove additional types from the Lists page.
 *
 * Soft-deleted (deleted_at) when removed by an admin so historical
 * vendor.vendor_type_id references remain valid. The CRUD endpoint
 * blocks deletion when any active vendor still points at the type
 * unless the caller specifies a reassignment target.
 */
export const vendorTypes = pgTable(
  "vendor_types",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isBuiltin: boolean("is_builtin").default(false).notNull(),
    // For builtin rows, one of "vendor" | "employee" | "item". Null for
    // user-created types. Lets the API map legacy `vendorType` string
    // arguments and import endpoints back to the seeded row.
    builtinKind: text("builtin_kind"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: varchar("deleted_by_user_id"),
  },
  (table) => ({
    labIdx: index("vendor_types_lab_idx").on(table.labOrganizationId),
    labNameUnique: uniqueIndex("vendor_types_lab_name_unique")
      .on(table.labOrganizationId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    labBuiltinKindUnique: uniqueIndex("vendor_types_lab_builtin_kind_unique")
      .on(table.labOrganizationId, table.builtinKind)
      .where(sql`${table.builtinKind} IS NOT NULL AND ${table.deletedAt} IS NULL`),
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
    // Destination-side identity (OneDrive Graph item id) of the stored file.
    // The uploaded name is not a reliable key: Graph's rename-on-conflict
    // behaviour can store a different name than the one requested, so history
    // downloads resolve by this id first and fall back to the name.
    remoteItemId: text("remote_item_id"),
    // Correlates a streamed download with the desktop's verified disk report.
    downloadRunId: text("download_run_id"),
    // "full" (database + media) or "database-only". Database-only archives are
    // taken on the fast schedule and must never be used as a restore source.
    archiveKind: text("archive_kind").notNull().default("full"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: text("status").notNull().default("success"),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
    mediaFileCount: integer("media_file_count"),
    attachmentRowCount: integer("attachment_row_count"),
    // True when the run technically "succeeded" (status stays "success") but
    // some non-critical part of the backup had to be dropped to get there —
    // e.g. an OneDrive upload that failed with profile-photos included was
    // retried without them so the DB + case-media backup wasn't lost. Never
    // true for a hard failure (those use status="error" instead).
    partialFailure: boolean("partial_failure").default(false).notNull(),
    // Human-readable explanation of what was dropped/retried when
    // partialFailure is true. Null for ordinary successful/failed runs.
    warnings: text("warnings"),
  },
  (table) => ({
    completedAtIdx: index("backup_runs_completed_at_idx").on(table.completedAt),
    downloadRunIdKey: uniqueIndex("backup_runs_download_run_id_key").on(table.downloadRunId),
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
 * Per-lab doctor → practice memory used by the AI prescription intake.
 *
 * This is the DOCTOR-keyed counterpart to `rx_practice_name_aliases` (which is
 * keyed on the practice-name text the AI read off the Rx). Because a doctor's
 * practice rarely changes but the practice text on a prescription frequently
 * does — missing, abbreviated, or OCR'd differently — the doctor key is the
 * higher-priority memory: once a user confirms "Dr. X works at Practice Y",
 * every later Rx for that doctor auto-selects the practice with no prompt,
 * even when the Rx carries no readable practice name at all.
 *
 * `doctor_name` is stored normalized via `normalizeRxDoctorName` (lowercased,
 * "Dr."/"Dr" titles stripped, punctuation and whitespace collapsed) so casing,
 * extra spaces, and title variants all collapse to one key. The unique index
 * on (lab_organization_id, doctor_name) enforces one practice per doctor per
 * lab and enables an idempotent upsert.
 */
export const rxDoctorPracticeMemory = pgTable(
  "rx_doctor_practice_memory",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    doctorName: text("doctor_name").notNull(),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    labDoctorNameUnique: uniqueIndex(
      "rx_doctor_practice_memory_lab_doctor_name_unique"
    ).on(table.labOrganizationId, table.doctorName),
    labIdx: index("rx_doctor_practice_memory_lab_idx").on(
      table.labOrganizationId
    ),
  })
);

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

/**
 * AI chat history — persists recent AI assistant conversations per user.
 * Each row is one message (role: "user" | "assistant").
 * Trimmed to the most recent 100 rows per user to cap storage.
 */
export const aiChatHistory = pgTable(
  "ai_chat_history",
  {
    id: varchar("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content").notNull(),
    /** IDs of the curated knowledge sections injected into the prompt for this reply (assistant rows only). */
    knowledgeSectionIds: text("knowledge_section_ids").array(),
    /** Whether the retention legal disclaimer was injected into the prompt (assistant rows only). */
    retentionDisclaimer: boolean("retention_disclaimer"),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("ai_chat_history_user_idx").on(table.userId),
    userCreatedIdx: index("ai_chat_history_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

/**
 * Per-organization case location (station) list. Allows labs to customize
 * the "Locate Case" picker beyond the 14 hard-coded CASE_STATIONS defaults.
 * On first GET for an org with no rows, the API seeds from CASE_STATIONS.
 * sortOrder determines display ordering (ascending); ties broken by createdAt.
 */
export const labLocations = pgTable(
  "lab_locations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    /**
     * Mapped workflow stage — one of the canonical case-status enum values.
     * This is what gets written to a case's `status` when a case is located
     * at this station. The free-form `code` is for display/identity only and
     * is NOT a valid case status for custom stations. Built-in stations have
     * `status === code`. Defaults to "received" until backfilled.
     */
    status: text("status").default("received").notNull(),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orgIdx: index("lab_locations_org_idx").on(table.labOrganizationId),
    orgCodeUnique: uniqueIndex("lab_locations_org_code_uniq").on(
      table.labOrganizationId,
      table.code,
    ),
  }),
);

/**
 * Per-lab managed vocabulary for restoration-specific fields (material,
 * shade, restoration_type). Labs start with a built-in default list served
 * by the API; custom additions saved here extend that list for all users in
 * the same lab. Case-insensitive dedup is enforced at the application layer
 * (SELECT before INSERT) rather than via a DB functional index.
 */
export const labVocabulary = pgTable(
  "lab_vocabulary",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'material' | 'shade' | 'restoration_type'
    value: text("value").notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orgKindIdx: index("lab_vocabulary_org_kind_idx").on(
      table.labOrganizationId,
      table.kind,
    ),
    orgKindValueUnique: uniqueIndex("lab_vocabulary_org_kind_value_uniq").on(
      table.labOrganizationId,
      table.kind,
      table.value,
    ),
  }),
);

/**
 * Lab-scoped customization layer on top of the static Case Type → Subtype →
 * Material taxonomy (@workspace/case-taxonomy). A lab with zero rows here
 * sees exactly the shared built-in tree; rows layer in additions, renames,
 * disables, and reordering on read (see api-server `lib/lab-catalog.ts`) —
 * nothing is ever backfilled per lab, so uncustomized labs carry zero risk.
 *
 * The three top-level case types (restorative/removable/ortho) are fixed
 * and are never persisted as rows here, so parent identity is the composite
 * (caseType, parentKey) rather than a self-referencing FK:
 *   - entryType="subtype": parentKey is "" (the case type is the parent).
 *   - entryType="material": parentKey is either a literal built-in subtype
 *     key (e.g. "crown_and_bridge") or a `custom:<id>` token referencing a
 *     custom subtype row's own `key`.
 *   - entryType="case_type" is reserved for completeness only — the API
 *     never creates these rows; case types are immutable.
 * `parentKey` defaults to "" (not null) so the natural-key unique index
 * below actually dedupes subtype rows — Postgres treats every NULL as
 * distinct, which would silently defeat both the unique index and any
 * upsert-by-natural-key (ON CONFLICT) on rows with no parent.
 *
 * `key` is the literal taxonomy key being overridden (built-in rows) or a
 * `custom:<own id>` token (custom rows) — see @workspace/case-taxonomy's
 * encodeCustomToken/isCustomToken/parseCustomToken, which centralize that
 * token format for the `case_restorations.restorationSubtype` encoding too.
 */
export const labCatalogEntries = pgTable(
  "lab_catalog_entries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entryType: text("entry_type").notNull(), // 'case_type' | 'subtype' | 'material'
    caseType: text("case_type").notNull(), // always one of the 3 fixed case types (denormalized)
    parentKey: text("parent_key").notNull().default(""), // "" = no parent (case_type/subtype rows)
    key: text("key").notNull(), // literal taxonomy key (built-in) or `custom:<own id>` (custom)
    label: text("label").notNull(),
    isCustom: boolean("is_custom").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    priceKeyOverride: text("price_key_override"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labTypeIdx: index("lab_catalog_entries_lab_type_idx").on(
      table.labOrganizationId,
      table.entryType,
    ),
    naturalKeyUnique: uniqueIndex("lab_catalog_entries_natural_key_uniq").on(
      table.labOrganizationId,
      table.entryType,
      table.caseType,
      table.parentKey,
      table.key,
    ),
  }),
);

export const aiMemory = pgTable(
  "ai_memory",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'glossary' | 'preference' | 'fact'
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: text("source").notNull().default("manual"), // 'manual' | 'learned' (Phase 1: 'manual' only)
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
    orgKindIdx: index("ai_memory_org_kind_idx").on(
      table.labOrganizationId,
      table.kind,
    ),
    orgKindKeyUnique: uniqueIndex("ai_memory_org_kind_key_uniq").on(
      table.labOrganizationId,
      table.kind,
      table.key,
    ),
  }),
);

/**
 * Unassigned Documents inbox — files dropped by lab staff that haven't yet
 * been assigned to a case. Files sit here until a staff member manually
 * assigns them. On assignment the row is marked (assigned_at is set) and a
 * caseAttachments row is created.
 */
export const labInboxFiles = pgTable(
  "lab_inbox_files",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    uploadedByUserId: varchar("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    storagePath: text("storage_path"),
    objectStorageKey: text("object_storage_key"),
    // Provider-submitted context attached at upload time. Both fields are
    // optional and nullable so existing records are unaffected.
    note: text("note"),
    linkedCaseIds: text("linked_case_ids"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    assignedToCaseId: varchar("assigned_to_case_id").references(
      () => cases.id,
      { onDelete: "set null" }
    ),
    assignedByUserId: varchar("assigned_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labInboxLabIdx: index("lab_inbox_files_lab_idx").on(
      table.labOrganizationId
    ),
    labInboxUnassignedIdx: index("lab_inbox_files_unassigned_idx").on(
      table.labOrganizationId,
      table.assignedAt
    ),
  })
);

// Server-persisted dismissals for the "Do not merge" action on the
// possible-duplicate-doctors panel. Scoped per lab so all admins of a lab
// share the decision across all of their devices. The clusterKey is the same
// stable key computed by the client (labId::sorted_row_ids) so dismiss,
// filter, and restore all stay in sync. doctorsJson stores a snapshot of the
// cluster members at dismiss time so the "Show dismissed" panel can render
// them even if the underlying case data later changes. Not a protected table:
// dismissals are lightweight advisory records, not clinical data.
export const doctorDupDismissals = pgTable(
  "doctor_dup_dismissals",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    // JSON array of { doctorName, providerOrganizationId, practiceName }
    doctorsJson: jsonb("doctors_json").notNull(),
    dismissedByUserId: varchar("dismissed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    labClusterUnique: uniqueIndex("doctor_dup_dismissals_lab_cluster_unique").on(
      table.labOrganizationId,
      table.clusterKey
    ),
    labIdx: index("doctor_dup_dismissals_lab_idx").on(table.labOrganizationId),
  })
);

// proposals only — they never feed the AI prompt and never become real
// `ai_memory` until a lab admin approves them. Approving copies the candidate
// into `ai_memory`; rejecting marks it 'rejected'. Not a protected table:
// candidates are transient suggestions, so status transitions (not soft-delete)
// are the audit trail.
export const aiMemoryCandidates = pgTable(
  "ai_memory_candidates",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'glossary' | 'preference' | 'fact'
    key: text("key").notNull(),
    value: text("value").notNull(),
    status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
    sourceUserId: varchar("source_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orgStatusIdx: index("ai_memory_candidates_org_status_idx").on(
      table.labOrganizationId,
      table.status,
    ),
  }),
);

export type AiMemoryCandidateRow = typeof aiMemoryCandidates.$inferSelect;

/**
 * Custom closed days for a lab (in addition to US federal holidays).
 * Each row marks one calendar date (stored as "YYYY-MM-DD" text) on which
 * the lab is not working. Counted as a non-business day by the stats
 * averageDailyRevenue / sales-forecast calculators.
 */
export const labClosedDays = pgTable(
  "lab_closed_days",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    note: text("note"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => ({
    labDateUniq: uniqueIndex("lab_closed_days_lab_date_uniq").on(
      table.labOrganizationId,
      table.date,
    ),
    labIdx: index("lab_closed_days_lab_idx").on(table.labOrganizationId),
  }),
);

export type LabClosedDay = typeof labClosedDays.$inferSelect;

/**
 * Per-member, per-year vacation balance. One row per (labId, userId, year).
 * `annualVacationHours` is set by admins; `usedVacationHours` increments on
 * approval; `pendingVacationHours` increments on submit and decrements on
 * approval/denial/cancellation.
 */
export const employeeVacationBalances = pgTable(
  "employee_vacation_balances",
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
    year: integer("year").notNull(),
    annualVacationHours: decimal("annual_vacation_hours", {
      precision: 8,
      scale: 2,
    })
      .default("0")
      .notNull(),
    usedVacationHours: decimal("used_vacation_hours", {
      precision: 8,
      scale: 2,
    })
      .default("0")
      .notNull(),
    pendingVacationHours: decimal("pending_vacation_hours", {
      precision: 8,
      scale: 2,
    })
      .default("0")
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labUserYearUniq: uniqueIndex("employee_vacation_balances_lab_user_year").on(
      table.labId,
      table.userId,
      table.year
    ),
    labUserIdx: index("employee_vacation_balances_lab_user_idx").on(
      table.labId,
      table.userId
    ),
  })
);

export type EmployeeVacationBalance =
  typeof employeeVacationBalances.$inferSelect;

/**
 * A vacation / time-off request submitted by a lab member.
 * Status flow: pending → approved | denied | cancelled.
 */
export const vacationRequests = pgTable(
  "vacation_requests",
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
    totalRequestedHours: decimal("total_requested_hours", {
      precision: 8,
      scale: 2,
    }).notNull(),
    reason: text("reason"),
    notes: text("notes"),
    status: text("status").notNull().default("pending"),
    adminDecisionNote: text("admin_decision_note"),
    approvedByUserId: varchar("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labStatusIdx: index("vacation_requests_lab_status_idx").on(
      table.labId,
      table.status
    ),
    labUserIdx: index("vacation_requests_lab_user_idx").on(
      table.labId,
      table.userId
    ),
  })
);

export type VacationRequest = typeof vacationRequests.$inferSelect;

/**
 * Individual calendar days belonging to a vacation request.
 * `isAllDay` = true → 8 h; false → endTime − startTime (HH:MM strings).
 */
export const vacationRequestDays = pgTable(
  "vacation_request_days",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    requestId: varchar("request_id")
      .notNull()
      .references(() => vacationRequests.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    isAllDay: boolean("is_all_day").default(true).notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    createdAt: createdAt(),
  },
  (table) => ({
    requestIdx: index("vacation_request_days_request_idx").on(table.requestId),
  })
);

export type VacationRequestDay = typeof vacationRequestDays.$inferSelect;

/**
 * Part-time / schedule records for lab employees.
 * `scheduleType`: "recurring" (uses dayOfWeek 0–6) | "one_time" (uses date).
 */
export const employeeSchedules = pgTable(
  "employee_schedules",
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
    scheduleType: text("schedule_type").notNull().default("recurring"),
    dayOfWeek: integer("day_of_week"),
    date: text("date"),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labUserIdx: index("employee_schedules_lab_user_idx").on(
      table.labId,
      table.userId
    ),
  })
);

export type EmployeeSchedule = typeof employeeSchedules.$inferSelect;

/**
 * Owner-defined named permission definitions scoped to a lab.
 * Each row names a capability (e.g. "Can delete cases") with an
 * associated capabilityKey from the canonical capability registry.
 * Owners create/edit/delete these; the UI lists them in the Permission
 * Outline panel of Settings. Hard-delete is safe — no case/financial data.
 */
export const labPermissionDefinitions = pgTable(
  "lab_permission_definitions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labId: varchar("lab_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    capabilityKey: text("capability_key").notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    labIdx: index("lab_permission_definitions_lab_idx").on(table.labId),
  })
);

export type LabPermissionDefinition =
  typeof labPermissionDefinitions.$inferSelect;

/**
 * Per-member grant of a permission definition.
 * A row here means the membership holder has been granted that named
 * permission by an owner. Cascade-deleted when either the membership or
 * the definition is removed. Hard-delete is safe.
 */
export const labMemberPermissions = pgTable(
  "lab_member_permissions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    membershipId: varchar("membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    permissionDefinitionId: varchar("permission_definition_id")
      .notNull()
      .references(() => labPermissionDefinitions.id, { onDelete: "cascade" }),
    grantedByUserId: varchar("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => ({
    membershipIdx: index("lab_member_permissions_membership_idx").on(
      table.membershipId
    ),
    permDefIdx: index("lab_member_permissions_perm_def_idx").on(
      table.permissionDefinitionId
    ),
    uniqueAssignment: uniqueIndex(
      "lab_member_permissions_unique_assignment"
    ).on(table.membershipId, table.permissionDefinitionId),
  })
);

export type LabMemberPermission = typeof labMemberPermissions.$inferSelect;

/**
 * Lab-scoped library of reusable "quick reference note" templates. Lab staff
 * can insert these into the Add Note composer on any case to avoid repetitive
 * free-text typing for common status updates.  Templates are never hard-deleted
 * — they are soft-deactivated (isActive = false) so historical context is
 * preserved.  displayOrder + createdAt controls the picker sort order.
 */
export const quickReferenceNotes = pgTable(
  "quick_reference_notes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    label: text("label"),
    isActive: boolean("is_active").default(true).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orgIdx: index("quick_reference_notes_org_idx").on(table.organizationId),
  })
);

export type QuickReferenceNote = typeof quickReferenceNotes.$inferSelect;

/**
 * Per-practice additional email addresses. Each practice can have zero or more
 * extra addresses beyond the primary `billingEmail` on the organizations row.
 * type = "billing"        → included as CC when statements and invoices are emailed.
 * type = "correspondence" → stored for reference only; not used in auto-sends.
 */
export const organizationAdditionalEmails = pgTable(
  "organization_additional_emails",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** "billing" | "correspondence" */
    type: text("type").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    orgIdx: index("organization_additional_emails_org_idx").on(
      table.organizationId
    ),
  })
);

export type OrganizationAdditionalEmail =
  typeof organizationAdditionalEmails.$inferSelect;

/**
 * Per-doctor profile metadata stored per lab. Each row represents a unique
 * (labOrganizationId, doctorName, providerOrganizationId) identity within a
 * lab and carries an optional displayName override, free-text preferences
 * (visible on the printed lab slip), and child phone/email rows.
 *
 * `doctorName` is the identity key — it matches `cases.doctor_name` and
 * `pricing_overrides.doctor_name`. `displayName` is a cosmetic overlay only
 * and does NOT replace doctorName as the key anywhere.
 */
export const doctorProfiles = pgTable(
  "doctor_profiles",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    doctorName: text("doctor_name").notNull(),
    providerOrganizationId: varchar("provider_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    /** Optional admin-edited display label — does not change the identity key. */
    displayName: text("display_name"),
    /** Free-text notes/preferences shown on the printed lab slip. */
    preferences: text("preferences"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    // Partial unique index for the non-null provider case.
    labDoctorProviderUnique: uniqueIndex(
      "doctor_profiles_lab_doctor_provider_unique"
    )
      .on(table.labOrganizationId, table.doctorName, table.providerOrganizationId)
      .where(sql`provider_organization_id IS NOT NULL`),
    // Separate partial index for the null-provider case (NULLs are not equal
    // in standard unique indexes, so this prevents duplicate no-practice rows).
    labDoctorNullProviderUnique: uniqueIndex(
      "doctor_profiles_lab_doctor_null_provider_unique"
    )
      .on(table.labOrganizationId, table.doctorName)
      .where(sql`provider_organization_id IS NULL`),
    labIdx: index("doctor_profiles_lab_idx").on(table.labOrganizationId),
  })
);

export type DoctorProfile = typeof doctorProfiles.$inferSelect;

/**
 * Typed phone numbers attached to a doctor profile. `label` is one of:
 * "main" | "mobile" | "other". At most one row per profile should have
 * `isPrimary = true` (enforced at the application layer).
 */
export const doctorPhoneEntries = pgTable(
  "doctor_phone_entries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    doctorProfileId: varchar("doctor_profile_id")
      .notNull()
      .references(() => doctorProfiles.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    /** "main" | "mobile" | "other" */
    label: text("label").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    profileIdx: index("doctor_phone_entries_profile_idx").on(
      table.doctorProfileId
    ),
  })
);

export type DoctorPhoneEntry = typeof doctorPhoneEntries.$inferSelect;

/**
 * Labeled email addresses attached to a doctor profile. `label` is one of:
 * "general" | "invoicing" | "other". At most one row per profile should have
 * `isPrimary = true` (enforced at the application layer).
 */
export const doctorEmailEntries = pgTable(
  "doctor_email_entries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    doctorProfileId: varchar("doctor_profile_id")
      .notNull()
      .references(() => doctorProfiles.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** "general" | "invoicing" | "other" */
    label: text("label").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    profileIdx: index("doctor_email_entries_profile_idx").on(
      table.doctorProfileId
    ),
  })
);

export type DoctorEmailEntry = typeof doctorEmailEntries.$inferSelect;

// ─── Provider-Lab Messenger ───────────────────────────────────────────────────

/**
 * One thread per (providerOrganizationId × labOrganizationId) pair.
 * Get-or-created the first time either side opens the chat.
 */
export const providerMessengerThreads = pgTable(
  "provider_messenger_threads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerOrganizationId: varchar("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    labOrganizationId: varchar("lab_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    pairUnique: uniqueIndex("provider_messenger_threads_pair_unique").on(
      table.providerOrganizationId,
      table.labOrganizationId
    ),
    labIdx: index("provider_messenger_threads_lab_idx").on(
      table.labOrganizationId
    ),
    providerIdx: index("provider_messenger_threads_provider_idx").on(
      table.providerOrganizationId
    ),
  })
);

/**
 * Every message in a provider-lab messenger thread. Supports plain text,
 * optional rich-formatting metadata (font/color/style), and an optional
 * media attachment stored in object storage.
 */
export const providerMessengerMessages = pgTable(
  "provider_messenger_messages",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: varchar("thread_id")
      .notNull()
      .references(() => providerMessengerThreads.id, { onDelete: "cascade" }),
    senderUserId: varchar("sender_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** JSON: {fontFamily?,color?,bold?,italic?,underline?} */
    formattingJson: jsonb("formatting_json"),
    /** Object-storage key for an attached image or video (≤50 MB). */
    mediaKey: text("media_key"),
    mimeType: text("mime_type"),
    createdAt: createdAt(),
  },
  (table) => ({
    threadIdx: index("provider_messenger_messages_thread_idx").on(
      table.threadId
    ),
    threadCreatedIdx: index("provider_messenger_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt
    ),
  })
);

/**
 * Per-(threadId, userId) read watermark. The `lastReadMessageId` is the
 * newest message the user has seen; unread count = messages newer than it.
 */
export const providerMessengerReadWatermarks = pgTable(
  "provider_messenger_read_watermarks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: varchar("thread_id")
      .notNull()
      .references(() => providerMessengerThreads.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: varchar("last_read_message_id").references(
      () => providerMessengerMessages.id,
      { onDelete: "set null" }
    ),
    updatedAt: updatedAt(),
  },
  (table) => ({
    threadUserUnique: uniqueIndex(
      "provider_messenger_read_watermarks_thread_user_unique"
    ).on(table.threadId, table.userId),
    userIdx: index("provider_messenger_read_watermarks_user_idx").on(
      table.userId
    ),
  })
);

export type ProviderMessengerThread =
  typeof providerMessengerThreads.$inferSelect;
export type ProviderMessengerMessage =
  typeof providerMessengerMessages.$inferSelect;
export type ProviderMessengerReadWatermark =
  typeof providerMessengerReadWatermarks.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type LabCaseRow = typeof labCases.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type AiChatHistoryRow = typeof aiChatHistory.$inferSelect;
export type LabLocation = typeof labLocations.$inferSelect;
export type LabVocabularyRow = typeof labVocabulary.$inferSelect;
export type LabCatalogEntryRow = typeof labCatalogEntries.$inferSelect;
export type AiMemoryRow = typeof aiMemory.$inferSelect;

export const statementPaymentApplications = pgTable(
  "statement_payment_applications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    paymentSessionId: varchar("payment_session_id")
      .notNull()
      .references(() => statementPaymentSessions.id, { onDelete: "cascade" }),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(),
    patientName: text("patient_name"),
    invoiceTotal: decimal("invoice_total", {
      precision: 12,
      scale: 2,
    }).notNull(),
    // Exact invoice amount captured by the selected statement. Legacy
    // applications remain nullable and render from invoiceTotal as a fallback.
    statementInvoiceAmount: decimal("statement_invoice_amount", {
      precision: 12,
      scale: 2,
    }),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    invoiceBalanceBefore: decimal("invoice_balance_before", {
      precision: 12,
      scale: 2,
    }).notNull(),
    invoiceBalanceAfter: decimal("invoice_balance_after", {
      precision: 12,
      scale: 2,
    }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    statementPaymentApplicationsSessionIdx: index(
      "statement_payment_applications_session_idx"
    ).on(table.paymentSessionId),
    statementPaymentApplicationsInvoiceIdx: index(
      "statement_payment_applications_invoice_idx"
    ).on(table.invoiceId),
    statementPaymentApplicationsUnique: uniqueIndex(
      "statement_payment_applications_session_invoice_unique"
    ).on(table.paymentSessionId, table.invoiceId),
  })
);

/**
 * Account-level unapplied credit.  This is intentionally not invoiceCredits:
 * it belongs to the customer account and can remain available after all
 * statement invoices have been paid.
 */
export const customerCredits = pgTable(
  "customer_credits",
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
    paymentSessionId: varchar("payment_session_id")
      .notNull()
      .references(() => statementPaymentSessions.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    remainingAmount: decimal("remaining_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    note: text("note"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByUserId: varchar("reversed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    customerCreditsLabProviderIdx: index(
      "customer_credits_lab_provider_idx"
    ).on(table.labOrganizationId, table.providerOrganizationId),
    customerCreditsSessionIdx: index("customer_credits_session_idx").on(
      table.paymentSessionId
    ),
  })
);

/**
 * Immutable allocation ledger for customer credit consumed by a later
 * statement-payment session.  This is deliberately separate from `payments`:
 * credit is an accounts-receivable reclassification, not money received and
 * must never appear in Undeposited Funds.
 */
export const customerCreditApplications = pgTable(
  "customer_credit_applications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerCreditId: varchar("customer_credit_id")
      .notNull()
      .references(() => customerCredits.id, { onDelete: "restrict" }),
    paymentSessionId: varchar("payment_session_id")
      .notNull()
      .references(() => statementPaymentSessions.id, { onDelete: "cascade" }),
    invoiceId: varchar("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    creditIdx: index("customer_credit_applications_credit_idx").on(
      table.customerCreditId,
    ),
    sessionIdx: index("customer_credit_applications_session_idx").on(
      table.paymentSessionId,
    ),
    invoiceIdx: index("customer_credit_applications_invoice_idx").on(
      table.invoiceId,
    ),
  }),
);

/**
 * Append-only, signed provider auto-pay authorization.  Card columns are
 * deliberately a processor-safe summary; no Stripe identifiers or payloads
 * belong in this record.
 */
export const providerAutopayAuthorizations = pgTable(
  "provider_autopay_authorizations",
  {
    id: varchar("id").primaryKey(),
    providerOrganizationId: varchar("provider_organization_id").notNull().references(
      () => organizations.id, { onDelete: "restrict" }),
    agreementVersion: text("agreement_version").notNull(),
    agreementText: text("agreement_text").notNull(),
    agreementSha256: text("agreement_sha256").notNull(),
    subscriptionFees: boolean("subscription_fees").notNull(),
    labBills: boolean("lab_bills").notNull(),
    labChargeDay: integer("lab_charge_day"),
    signerUserId: varchar("signer_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    typedLegalName: text("typed_legal_name").notNull(),
    consent: boolean("consent").notNull(),
    signerIp: text("signer_ip").notNull(),
    signerUserAgent: text("signer_user_agent").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    signatureObjectKey: text("signature_object_key").notNull(),
    signatureChecksum: text("signature_checksum").notNull(),
    documentObjectKey: text("document_object_key").notNull(),
    documentChecksum: text("document_checksum").notNull(),
    cardBrand: text("card_brand").notNull(),
    cardLast4: text("card_last4").notNull(),
    cardExpMonth: integer("card_exp_month").notNull(),
    cardExpYear: integer("card_exp_year").notNull(),
    cardStatus: text("card_status").notNull(),
    cardBillingAddressJson: jsonb("card_billing_address_json"),
    status: text("status").notNull().default("active"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    providerStatusIdx: index("provider_autopay_auth_provider_status_idx").on(
      table.providerOrganizationId, table.status),
    categoryCheck: check("provider_autopay_auth_category_check", sql`${table.subscriptionFees} OR ${table.labBills}`),
    labDayCheck: check("provider_autopay_auth_lab_day_check", sql`(${table.labBills} AND ${table.labChargeDay} BETWEEN 1 AND 10) OR (NOT ${table.labBills} AND ${table.labChargeDay} IS NULL)`),
    consentCheck: check("provider_autopay_auth_consent_check", sql`${table.consent} = true`),
    last4Check: check("provider_autopay_auth_last4_check", sql`${table.cardLast4} ~ '^[0-9]{4}$'`),
    expiryCheck: check("provider_autopay_auth_expiry_check", sql`${table.cardExpMonth} BETWEEN 1 AND 12 AND ${table.cardExpYear} BETWEEN 2000 AND 2200`),
    statusCheck: check("provider_autopay_auth_status_check", sql`${table.status} IN ('active','superseded')`),
    supersededCheck: check("provider_autopay_auth_superseded_check", sql`(${table.status} = 'active' AND ${table.supersededAt} IS NULL) OR (${table.status} = 'superseded' AND ${table.supersededAt} IS NOT NULL)`),
    currentUnique: uniqueIndex("provider_autopay_auth_current_unique")
      .on(table.providerOrganizationId).where(sql`status = 'active'`),
  }),
);

/** Durable lab-created authorization request. Labs can prepare and send,
 * but only a provider billing signer can create the append-only authorization. */
export const providerAutopayAuthorizationRequests = pgTable(
  "provider_autopay_authorization_requests",
  {
    id: varchar("id").primaryKey(),
    providerOrganizationId: varchar("provider_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    requestedByUserId: varchar("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    agreementVersion: text("agreement_version").notNull(),
    agreementText: text("agreement_text").notNull(),
    agreementSha256: text("agreement_sha256").notNull(),
    subscriptionFees: boolean("subscription_fees").notNull(),
    labBills: boolean("lab_bills").notNull(),
    labOrganizationIds: jsonb("lab_organization_ids").notNull(),
    labChargeDay: integer("lab_charge_day"),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    cardStatus: text("card_status"),
    cardBillingAddressJson: jsonb("card_billing_address_json"),
    status: text("status").notNull().default("prepared"),
    recipientEmail: text("recipient_email"),
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedAuthorizationId: varchar("completed_authorization_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    providerIdx: index("provider_autopay_requests_provider_idx").on(table.providerOrganizationId, table.status),
    labIdx: index("provider_autopay_requests_lab_idx").on(table.labOrganizationId, table.status),
    categoryCheck: check("provider_autopay_requests_category_check", sql`${table.subscriptionFees} OR ${table.labBills}`),
    labDayCheck: check("provider_autopay_requests_lab_day_check", sql`(${table.labBills} AND ${table.labChargeDay} BETWEEN 1 AND 10) OR (NOT ${table.labBills} AND ${table.labChargeDay} IS NULL)`),
    last4Check: check("provider_autopay_requests_last4_check", sql`${table.cardLast4} IS NULL OR ${table.cardLast4} ~ '^[0-9]{4}$'`),
    cardStatusCheck: check("provider_autopay_requests_card_status_check", sql`${table.cardStatus} IS NULL OR ${table.cardStatus} IN ('active','expired')`),
    statusCheck: check("provider_autopay_requests_status_check", sql`${table.status} IN ('prepared','sent','completed','expired','cancelled')`),
  }),
);
export const providerAutopayAuthorizationLabs = pgTable(
  "provider_autopay_authorization_labs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    authorizationId: varchar("authorization_id").notNull().references(
      () => providerAutopayAuthorizations.id, { onDelete: "restrict" }),
    labOrganizationId: varchar("lab_organization_id").notNull().references(
      () => organizations.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => ({
    authLabUnique: uniqueIndex("provider_autopay_auth_lab_unique").on(
      table.authorizationId, table.labOrganizationId),
    authIdx: index("provider_autopay_auth_labs_auth_idx").on(table.authorizationId),
  }),
);

/** Durable, sanitized support-report outbox.  Body content is retained only
 * for the explicit retention window and is never exposed to tenant APIs. */
export const supportReports = pgTable("support_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reporterUserId: varchar("reporter_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }),
  portal: text("portal").notNull(),
  description: text("description").notNull(),
  kind: text("kind").notNull().default("issue"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reporterEmail: text("reporter_email"),
  ownerEmail: text("owner_email"),
  ownerStatus: text("owner_status").notNull().default("pending"),
  copyStatus: text("copy_status").notNull().default("not_applicable"),
  ownerAttempts: integer("owner_attempts").notNull().default(0),
  copyAttempts: integer("copy_attempts").notNull().default(0),
  ownerNextAttemptAt: timestamp("owner_next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  copyNextAttemptAt: timestamp("copy_next_attempt_at", { withTimezone: true }),
  ownerClaimedAt: timestamp("owner_claimed_at", { withTimezone: true }),
  copyClaimedAt: timestamp("copy_claimed_at", { withTimezone: true }),
  ownerFailureReason: text("owner_failure_reason"),
  copyFailureReason: text("copy_failure_reason"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => ({
  dueIdx: index("support_reports_due_idx").on(table.ownerStatus, table.ownerNextAttemptAt),
  copyDueIdx: index("support_reports_copy_due_idx").on(table.copyStatus, table.copyNextAttemptAt),
  retentionIdx: index("support_reports_retention_idx").on(table.expiresAt),
  reporterIdempotencyUnique: uniqueIndex("support_reports_reporter_idempotency_unique").on(table.reporterUserId, table.idempotencyKey),
  portalCheck: check("support_reports_portal_check", sql`${table.portal} IN ('lab', 'provider')`),
  ownerStatusCheck: check("support_reports_owner_status_check", sql`${table.ownerStatus} IN ('persisting', 'pending', 'in_flight', 'send_failed', 'sent', 'permanent_failed', 'not_applicable')`),
  copyStatusCheck: check("support_reports_copy_status_check", sql`${table.copyStatus} IN ('persisting', 'pending', 'in_flight', 'send_failed', 'sent', 'permanent_failed', 'not_applicable')`),
}));
/** Editable, lab-scoped blank authorization templates. */
export const labAuthorizationTemplates = pgTable("lab_authorization_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  templateType: text("template_type").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  updatedByUserId: varchar("updated_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  labTypeUnique: uniqueIndex("lab_authorization_templates_lab_type_unique").on(table.labOrganizationId, table.templateType),
  labIdx: index("lab_authorization_templates_lab_idx").on(table.labOrganizationId),
  typeCheck: check("lab_authorization_templates_type_check", sql`${table.templateType} IN ('card_on_file','autopay')`),
}));

export const supportReportAttachments = pgTable("support_report_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportId: varchar("report_id").notNull().references(() => supportReports.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => ({
  reportIdx: index("support_report_attachments_report_idx").on(table.reportId),
  storageKeyUnique: uniqueIndex("support_report_attachments_storage_key_unique").on(table.storageKey),
}));

/** Payment evidence is separate from lifecycle events and dental invoices. */
export const subscriptionReceipts = pgTable("subscription_receipts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Durable source provenance, not ownership. Old archives do not contain this
  // ledger; an FK would prevent restoring their subscriptions table.
  subscriptionId: varchar("subscription_id"),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  kind: text("kind").notNull(),
  parentExternalId: text("parent_external_id"),
  amountMinor: bigint("amount_minor", { mode: "number" }),
  currency: text("currency"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  coverageStartsAt: timestamp("coverage_starts_at", { withTimezone: true }),
  coverageEndsAt: timestamp("coverage_ends_at", { withTimezone: true }),
  unavailableReason: text("unavailable_reason"),
  createdAt: createdAt(),
}, (table) => ({
  evidenceUnique: uniqueIndex("subscription_receipts_evidence_unique").on(table.provider, table.externalId, table.kind),
  dateIdx: index("subscription_receipts_date_idx").on(table.occurredAt),
  subscriptionIdx: index("subscription_receipts_subscription_idx").on(table.subscriptionId),
}));
/** Immutable completed PDF supplied for a practice authorization. */
export const practiceAuthorizationDocuments = pgTable("practice_authorization_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  practiceOrganizationId: varchar("practice_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  supersedesDocumentId: varchar("supersedes_document_id").references((): AnyPgColumn => practiceAuthorizationDocuments.id, { onDelete: "restrict" }),
  authorizationType: text("authorization_type").notNull(),
  originalFilename: text("original_filename").notNull(),
  byteSize: integer("byte_size"),
  checksum: text("checksum").notNull(),
  uploaderUserId: varchar("uploader_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull(),
  legacyAuthorizationId: varchar("legacy_authorization_id"),
  legacyEvidence: jsonb("legacy_evidence"),
  createdAt: createdAt(),
}, (table) => ({
  scopeIdx: index("practice_auth_docs_scope_idx").on(table.labOrganizationId, table.practiceOrganizationId),
  legacyAuthorizationUnique: uniqueIndex("practice_auth_docs_legacy_authorization_unique").on(table.legacyAuthorizationId),
  supersedesUnique: uniqueIndex("practice_auth_docs_supersedes_unique").on(table.supersedesDocumentId),
  typeCheck: check("practice_auth_docs_type_check", sql`${table.authorizationType} IN ('card_on_file','autopay')`),
  sizeCheck: check("practice_auth_docs_size_check", sql`${table.byteSize} IS NULL OR ${table.byteSize} > 0`),
}));

/** Durable, lab-owned mobile 3D reconstruction jobs.  Status and lease fields
 * deliberately live in SQL so a crashed API process can be replaced safely. */
export const scanJobs = pgTable("scan_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key"),
  status: text("status").notNull().default("draft"),
  captureMethod: text("capture_method").notNull().default("camera"),
  device: text("device"),
  manifestJson: jsonb("manifest_json"),
  qualityJson: jsonb("quality_json"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  guidance: text("guidance"),
  caseId: varchar("case_id"),
  legacyCaseId: varchar("legacy_case_id"),
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseToken: text("lease_token"),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  labStatusIdx: index("scan_jobs_lab_status_idx").on(table.labOrganizationId, table.status),
  leaseIdx: index("scan_jobs_lease_idx").on(table.status, table.leaseUntil),
  idempotencyUnique: uniqueIndex("scan_jobs_lab_idempotency_unique").on(table.labOrganizationId, table.idempotencyKey),
  statusCheck: check("scan_jobs_status_check", sql`${table.status} IN ('draft','queued','processing','retry','completed','failed')`),
  destinationCheck: check("scan_jobs_destination_xor", sql`NOT (${table.caseId} IS NOT NULL AND ${table.legacyCaseId} IS NOT NULL)`),
}));

export const scanInputs = pgTable("scan_inputs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => scanJobs.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  expectedBytes: integer("expected_bytes").notNull(),
  receivedBytes: integer("received_bytes").notNull().default(0),
  storageKey: text("storage_key"),
  uploadPath: text("upload_path"),
  sha256: text("sha256"),
  createdAt: createdAt(),
}, (table) => ({
  jobIdx: index("scan_inputs_job_idx").on(table.jobId),
  jobFileUnique: uniqueIndex("scan_inputs_job_file_unique").on(table.jobId, table.fileName),
  sizeCheck: check("scan_inputs_size_check", sql`${table.expectedBytes} > 0 AND ${table.receivedBytes} >= 0 AND ${table.receivedBytes} <= ${table.expectedBytes}`),
}));

export const scanInputChunks = pgTable("scan_input_chunks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  inputId: varchar("input_id").notNull().references(() => scanInputs.id, { onDelete: "cascade" }),
  offset: integer("offset").notNull(),
  byteSize: integer("byte_size").notNull(),
  storageKey: text("storage_key").notNull(),
  checksum: text("checksum").notNull(),
  createdAt: createdAt(),
}, (table) => ({
  inputOffsetUnique: uniqueIndex("scan_input_chunks_input_offset_unique").on(table.inputId, table.offset),
}));

/** Durable cleanup ledger for superseded or abandoned reconstruction blobs. */
export const scanOutputGarbage = pgTable("scan_output_garbage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => scanJobs.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  createdAt: createdAt(),
}, (table) => ({
  storageKeyUnique: uniqueIndex("scan_output_garbage_storage_key_unique").on(table.storageKey),
}));

/** A generated model saved without a case assignment. */
export const labDocuments = pgTable("lab_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  scanJobId: varchar("scan_job_id").notNull().references(() => scanJobs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  storageKey: text("storage_key").notNull(),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
}, (table) => ({
  scanUnique: uniqueIndex("lab_documents_scan_unique").on(table.scanJobId, table.mimeType),
}));

export const scanOutputs = pgTable("scan_outputs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => scanJobs.id, { onDelete: "cascade" }),
  format: text("format").notNull(),
  mimeType: text("mime_type").notNull(),
  storageKey: text("storage_key").notNull(),
  byteSize: integer("byte_size").notNull(),
  metadataJson: jsonb("metadata_json").notNull(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => ({
  jobFormatUnique: uniqueIndex("scan_outputs_job_format_unique").on(table.jobId, table.format),
  formatCheck: check("scan_outputs_format_check", sql`${table.format} IN ('ply','stl')`),
}));

/**
 * Privacy-preserving aggregate for the hosted saved-card setup flow.
 * Deliberately contains no actor, customer, session, card, or free-form data.
 */
export const savedCardSetupAnalytics = pgTable("saved_card_setup_analytics", {
  outcome: text("outcome").primaryKey(),
  count: integer("count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  outcomeCheck: check("saved_card_setup_analytics_outcome_check",
    sql`${table.outcome} IN ('started','succeeded','expired')`),
}));

/** Shared Cases search/status/date filters saved for one lab team. */
export const caseSavedViews = pgTable("case_saved_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labOrganizationId: varchar("lab_organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull(),
  createdByUserId: varchar("created_by_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  labNameUnique: uniqueIndex("case_saved_views_lab_name_unique")
    .on(table.labOrganizationId, sql`lower(${table.name})`),
  labIdx: index("case_saved_views_lab_idx").on(table.labOrganizationId),
}));

/**
 * Durable progress for active and recent complete-backup runs.
 *
 * The API creates this table idempotently at startup as a compatibility
 * measure. It is also part of the shared schema so publishing cannot mistake
 * the runtime-managed table for an orphan and drop its status/evidence rows.
 */
export const backupLiveStatus = pgTable(
  "backup_live_status",
  {
    runId: uuid("run_id").primaryKey(),
    state: text("state").notNull(),
    phase: text("phase").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    elapsedMs: bigint("elapsed_ms", { mode: "number" }).notNull(),
    metrics: jsonb("metrics").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archiveEvidence: jsonb("archive_evidence"),
    requestFingerprint: text("request_fingerprint"),
    requestedByUserId: text("requested_by_user_id"),
    requestedBySessionHash: text("requested_by_session_hash"),
    delivery: jsonb("delivery"),
  },
  (table) => ({
    stateCheck: check(
      "backup_live_status_state_check",
      sql`${table.state} IN ('running', 'awaiting_verification', 'finalizing', 'completed', 'failed', 'cancelled', 'stale')`,
    ),
    elapsedMsCheck: check(
      "backup_live_status_elapsed_ms_check",
      sql`${table.elapsedMs} >= 0`,
    ),
    createdAtIdx: index("backup_live_status_created_at_idx").on(table.createdAt),
  }),
);
