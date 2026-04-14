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
import { z } from "zod";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
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
  wantsUpdates: boolean("wants_updates").default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const labCases = pgTable("lab_cases", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  caseData: text("case_data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const organizations = pgTable("organizations", {
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
  createdByUserId: varchar("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
  },
  (table) => ({
    uniqueMemberPerOrg: uniqueIndex("memberships_org_user_unique").on(
      table.labId,
      table.userId
    ),
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
  }
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
    email: text("email").notNull(),
    phone: text("phone"),
    roleToAssign: text("role_to_assign").notNull(),
    token: text("token").notNull(),
    status: text("status").default("pending").notNull(),
    invitedByUserId: varchar("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
  },
  (table) => ({
    caseNumberUnique: uniqueIndex("cases_case_number_unique").on(
      table.caseNumber
    ),
    caseLabIdx: index("cases_lab_idx").on(table.labOrganizationId),
    caseProviderIdx: index("cases_provider_idx").on(
      table.providerOrganizationId
    ),
  })
);

export const caseRestorations = pgTable("case_restorations", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  caseId: varchar("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  toothNumber: text("tooth_number").notNull(),
  restorationType: text("restoration_type").notNull(),
  material: text("material"),
  shade: text("shade"),
  notes: text("notes"),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
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
    invoiceNumberUnique: uniqueIndex("invoices_invoice_number_unique").on(
      table.invoiceNumber
    ),
  })
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

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type LabCaseRow = typeof labCases.$inferSelect;
