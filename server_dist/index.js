var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/index.ts
import express2 from "express";

// server/routes.ts
import express from "express";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import archiver from "archiver";

// server/lib/onedrive.ts
var cachedSettings = null;
var cacheExpiresAt = 0;
async function getOneDriveAccessToken() {
  const now = Date.now();
  if (cachedSettings && cacheExpiresAt > now + 6e4) {
    return cachedSettings.settings?.access_token || cachedSettings.settings?.oauth?.credentials?.access_token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname)
    throw new Error("OneDrive connector not available in this environment.");
  const xReplitToken = process.env.REPL_IDENTITY ? "repl " + process.env.REPL_IDENTITY : process.env.WEB_REPL_RENEWAL ? "depl " + process.env.WEB_REPL_RENEWAL : null;
  if (!xReplitToken)
    throw new Error("Replit identity token not found.");
  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=onedrive`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  );
  if (!resp.ok)
    throw new Error(`Connector fetch failed: ${resp.status}`);
  const data = await resp.json();
  cachedSettings = data.items?.[0];
  if (!cachedSettings)
    throw new Error("OneDrive connection not found. Please reconnect.");
  const expiresAt = cachedSettings.settings?.expires_at;
  cacheExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 35e5;
  const token = cachedSettings.settings?.access_token || cachedSettings.settings?.oauth?.credentials?.access_token;
  if (!token)
    throw new Error("OneDrive access token not available.");
  return token;
}
async function graphRequest(path3, options = {}, token) {
  const accessToken = token || await getOneDriveAccessToken();
  return fetch(`https://graph.microsoft.com/v1.0${path3}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...options.headers || {}
    }
  });
}
async function uploadToOneDrive(fileBuffer, fileName, folderPath = "LabTrax Backups") {
  const token = await getOneDriveAccessToken();
  const uploadPath = `/${folderPath}/${fileName}`;
  const CHUNK_SIZE = 5 * 1024 * 1024;
  if (fileBuffer.length <= 4 * 1024 * 1024) {
    const resp = await graphRequest(
      `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: fileBuffer
      },
      token
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OneDrive upload failed: ${err}`);
    }
    const item = await resp.json();
    return { webUrl: item.webUrl || "", name: item.name, size: item.size };
  }
  const sessionResp = await graphRequest(
    `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/createUploadSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: fileName
        }
      })
    },
    token
  );
  if (!sessionResp.ok) {
    const err = await sessionResp.text();
    throw new Error(`Could not create OneDrive upload session: ${err}`);
  }
  const session = await sessionResp.json();
  const uploadUrl = session.uploadUrl;
  if (!uploadUrl)
    throw new Error("No upload URL returned from OneDrive.");
  let offset = 0;
  let lastResponse = null;
  while (offset < fileBuffer.length) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const end = offset + chunk.length - 1;
    const chunkResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${offset}-${end}/${fileBuffer.length}`,
        "Content-Type": "application/octet-stream"
      },
      body: chunk
    });
    if (!chunkResp.ok && chunkResp.status !== 202) {
      const err = await chunkResp.text();
      throw new Error(`OneDrive chunk upload failed at offset ${offset}: ${err}`);
    }
    lastResponse = await chunkResp.json().catch(() => ({}));
    offset += chunk.length;
  }
  return {
    webUrl: lastResponse?.webUrl || "",
    name: lastResponse?.name || fileName,
    size: lastResponse?.size || fileBuffer.length
  };
}

// server/routes.ts
import multer from "multer";
import OpenAI, { toFile } from "openai";
import nodemailer from "nodemailer";
import sharp from "sharp";

// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  auditLogs: () => auditLogs,
  caseAttachments: () => caseAttachments,
  caseEvents: () => caseEvents,
  caseLocations: () => caseLocations,
  caseNotes: () => caseNotes,
  caseRestorations: () => caseRestorations,
  caseSubmissionQueue: () => caseSubmissionQueue,
  cases: () => cases,
  insertUserSchema: () => insertUserSchema,
  invoiceLineItems: () => invoiceLineItems,
  invoices: () => invoices,
  labCases: () => labCases,
  notifications: () => notifications,
  organizationConnections: () => organizationConnections,
  organizationInvites: () => organizationInvites,
  organizationJoinRequests: () => organizationJoinRequests,
  organizationMemberships: () => organizationMemberships,
  organizationMembershipsRelations: () => organizationMembershipsRelations,
  organizations: () => organizations,
  organizationsRelations: () => organizationsRelations,
  payments: () => payments,
  userSessions: () => userSessions,
  users: () => users,
  usersRelations: () => usersRelations
});
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
var createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
var updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
var users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
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
  workStatus: text("work_status").default("available"),
  createdAt: timestamp("created_at").defaultNow()
});
var labCases = pgTable("lab_cases", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  caseData: text("case_data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow()
});
var organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
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
    onDelete: "set null"
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});
var organizationMemberships = pgTable(
  "lab_memberships",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    labId: varchar("lab_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").default("active").notNull(),
    invitedByUserId: varchar("invited_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    approvedByUserId: varchar("approved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    uniqueMemberPerOrg: uniqueIndex("memberships_org_user_unique").on(
      table.labId,
      table.userId
    ),
    orgIdx: index("memberships_org_idx").on(table.labId),
    userIdx: index("memberships_user_idx").on(table.userId)
  })
);
var organizationJoinRequests = pgTable(
  "join_requests",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    labId: varchar("lab_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    requestedRole: text("requested_role").notNull(),
    message: text("message"),
    status: text("status").default("pending").notNull(),
    reviewedByUserId: varchar("reviewed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    pendingUnique: uniqueIndex("join_requests_pending_unique").on(table.labId, table.userId).where(sql`status = 'pending'`)
  })
);
var organizationInvites = pgTable(
  "lab_invites",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    labId: varchar("lab_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email"),
    phone: text("phone"),
    roleToAssign: text("role_to_assign"),
    token: text("token"),
    status: text("status").default("pending").notNull(),
    invitedByUserId: varchar("invited_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedByUserId: varchar("accepted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    tokenUnique: uniqueIndex("lab_invites_token_unique").on(
      table.token
    )
  })
);
var organizationConnections = pgTable(
  "organization_connections",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    providerOrganizationId: varchar("provider_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").default("pending").notNull(),
    requestedByOrgId: varchar("requested_by_org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: varchar("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    approvedByUserId: varchar("approved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    uniqueConnection: uniqueIndex("organization_connections_unique").on(
      table.labOrganizationId,
      table.providerOrganizationId
    )
  })
);
var cases = pgTable(
  "cases",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    caseNumber: text("case_number").notNull(),
    labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    providerOrganizationId: varchar("provider_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    patientFirstName: text("patient_first_name").notNull(),
    patientLastName: text("patient_last_name").notNull(),
    externalPatientId: text("external_patient_id"),
    doctorName: text("doctor_name").notNull(),
    status: text("status").default("received").notNull(),
    priority: text("priority").default("normal").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    caseNumberUnique: uniqueIndex("cases_case_number_unique").on(
      table.caseNumber
    ),
    caseLabIdx: index("cases_lab_idx").on(table.labOrganizationId),
    caseProviderIdx: index("cases_provider_idx").on(
      table.providerOrganizationId
    )
  })
);
var caseRestorations = pgTable("case_restorations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  toothNumber: text("tooth_number").notNull(),
  restorationType: text("restoration_type").notNull(),
  material: text("material"),
  shade: text("shade"),
  notes: text("notes"),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});
var caseEvents = pgTable(
  "case_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: varchar("actor_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    actorOrganizationId: varchar("actor_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    actorInitials: text("actor_initials"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt: createdAt()
  },
  (table) => ({
    caseEventsIdx: index("case_events_case_idx").on(table.caseId)
  })
);
var caseNotes = pgTable("case_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  authorUserId: varchar("author_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  authorOrganizationId: varchar("author_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  noteText: text("note_text").notNull(),
  visibility: text("visibility").default("shared_with_provider").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});
var caseAttachments = pgTable("case_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  uploadedByUserId: varchar("uploaded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  uploadedByOrganizationId: varchar("uploaded_by_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  fileType: text("file_type").notNull(),
  visibility: text("visibility").default("shared_with_provider").notNull(),
  createdAt: createdAt()
});
var caseLocations = pgTable("case_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  locationCode: text("location_code").notNull(),
  locationName: text("location_name").notNull(),
  movedByUserId: varchar("moved_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  movedAt: timestamp("moved_at", { withTimezone: true }).defaultNow().notNull(),
  notes: text("notes")
});
var caseSubmissionQueue = pgTable("case_submission_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  caseId: varchar("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  submittedByUserId: varchar("submitted_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  submittedByOrganizationId: varchar("submitted_by_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  submissionType: text("submission_type").notNull(),
  payloadJson: jsonb("payload_json").default({}).notNull(),
  status: text("status").default("pending_review").notNull(),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
    onDelete: "set null"
  }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});
var invoices = pgTable(
  "invoices",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    invoiceNumber: text("invoice_number").notNull(),
    caseId: varchar("case_id").references(() => cases.id, {
      onDelete: "set null"
    }),
    labOrganizationId: varchar("lab_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    providerOrganizationId: varchar("provider_organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    status: text("status").default("draft").notNull(),
    subtotal: decimal("subtotal", { precision: 10, scale: 2 }).default("0.00").notNull(),
    tax: decimal("tax", { precision: 10, scale: 2 }).default("0.00").notNull(),
    discount: decimal("discount", { precision: 10, scale: 2 }).default("0.00").notNull(),
    total: decimal("total", { precision: 10, scale: 2 }).default("0.00").notNull(),
    balanceDue: decimal("balance_due", { precision: 10, scale: 2 }).default("0.00").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    invoiceNumberUnique: uniqueIndex("invoices_invoice_number_unique").on(
      table.invoiceNumber
    )
  })
);
var invoiceLineItems = pgTable("invoice_line_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  caseRestorationId: varchar("case_restoration_id").references(
    () => caseRestorations.id,
    { onDelete: "set null" }
  ),
  description: text("description").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
  lineTotal: decimal("line_total", { precision: 10, scale: 2 }).default("0.00").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});
var payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
  recordedByUserId: varchar("recorded_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt()
});
var auditLogs = pgTable(
  "audit_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null"
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
    createdAt: createdAt()
  },
  (table) => ({
    auditCreatedIdx: index("audit_logs_created_idx").on(table.createdAt)
  })
);
var userSessions = pgTable(
  "user_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    deviceName: text("device_name"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("user_sessions_token_hash_unique").on(
      table.tokenHash
    )
  })
);
var usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMemberships)
}));
var organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships)
}));
var organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMemberships.labId],
      references: [organizations.id]
    }),
    user: one(users, {
      fields: [organizationMemberships.userId],
      references: [users.id]
    })
  })
);
var notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  dataJson: jsonb("data_json"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt()
});
var insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true
});

// shared/models/chat.ts
var chat_exports = {};
__export(chat_exports, {
  conversations: () => conversations,
  insertConversationSchema: () => insertConversationSchema,
  insertMessageSchema: () => insertMessageSchema,
  messages: () => messages
});
import { pgTable as pgTable2, serial as serial2, integer as integer2, text as text2, timestamp as timestamp2 } from "drizzle-orm/pg-core";
import { createInsertSchema as createInsertSchema2 } from "drizzle-zod";
import { sql as sql2 } from "drizzle-orm";
var conversations = pgTable2("conversations", {
  id: serial2("id").primaryKey(),
  title: text2("title").notNull(),
  createdAt: timestamp2("created_at").default(sql2`CURRENT_TIMESTAMP`).notNull()
});
var messages = pgTable2("messages", {
  id: serial2("id").primaryKey(),
  conversationId: integer2("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text2("role").notNull(),
  content: text2("content").notNull(),
  createdAt: timestamp2("created_at").default(sql2`CURRENT_TIMESTAMP`).notNull()
});
var insertConversationSchema = createInsertSchema2(conversations).omit({
  id: true,
  createdAt: true
});
var insertMessageSchema = createInsertSchema2(messages).omit({
  id: true,
  createdAt: true
});

// server/db.ts
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}
var connectionString = process.env.DATABASE_URL;
if (!connectionString.includes("sslmode=")) {
  const separator = connectionString.includes("?") ? "&" : "?";
  connectionString += `${separator}sslmode=verify-full`;
}
var pool = new pg.Pool({ connectionString });
var db = drizzle(pool, { schema: { ...schema_exports, ...chat_exports } });

// server/routes.ts
import { eq as eq7, and as and7, inArray as inArray4 } from "drizzle-orm";

// server/lib/crypto.ts
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
var BCRYPT_ROUNDS = 12;
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// server/middleware/auth.ts
import { and, eq, isNull, gt } from "drizzle-orm";

// server/lib/auth.ts
import jwt from "jsonwebtoken";
var JWT_SECRET = process.env.JWT_SECRET || "labtrax-jwt-secret-change-in-production";
if (!process.env.JWT_SECRET) {
  console.warn("[SECURITY] JWT_SECRET env var is not set. Using insecure default \u2014 set JWT_SECRET before deploying to production.");
}
var ACCESS_TOKEN_TTL = "15m";
var REFRESH_TOKEN_TTL = "7d";
function signAccessToken(userId, sessionId) {
  return jwt.sign({ sub: userId, sid: sessionId, type: "access" }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL
  });
}
function signRefreshToken(userId, sessionId) {
  return jwt.sign({ sub: userId, sid: sessionId, type: "refresh" }, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL
  });
}
function verifyAccessToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== "access") {
    throw new Error("Invalid token type: expected access token");
  }
  return payload;
}
function verifyRefreshToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== "refresh") {
    throw new Error("Invalid token type: expected refresh token");
  }
  return payload;
}
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return null;
  return header.slice(7);
}
function generateInviteToken() {
  return randomToken(24);
}
function makeSessionHash(rawRefreshToken) {
  return sha256(rawRefreshToken);
}

// server/lib/http.ts
var HttpError = class extends Error {
  statusCode;
  details;
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
};
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

// server/middleware/auth.ts
async function requireAuth(req, _res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return next(new HttpError(401, "Authentication required."));
  }
  try {
    const payload = verifyAccessToken(token);
    const session = await db.query.userSessions.findFirst({
      where: and(
        eq(userSessions.id, payload.sid),
        eq(userSessions.userId, payload.sub),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, /* @__PURE__ */ new Date())
      )
    });
    if (!session) {
      return next(new HttpError(401, "Session is invalid or expired."));
    }
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub)
    });
    if (!user || !user.isActive) {
      return next(new HttpError(401, "User account is inactive."));
    }
    req.auth = { userId: payload.sub, sessionId: payload.sid };
    req.user = user;
    return next();
  } catch {
    return next(new HttpError(401, "Invalid access token."));
  }
}
function optionalAuth(req, _res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return next();
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, sessionId: payload.sid };
  } catch {
  }
  return next();
}

// server/routes/auth.ts
import crypto2 from "node:crypto";
import { Router } from "express";
import { and as and2, eq as eq2, gt as gt2, inArray, isNull as isNull2 } from "drizzle-orm";
import { z } from "zod";

// server/middleware/async-handler.ts
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// server/lib/audit.ts
async function writeAuditLog(input) {
  try {
    await db.insert(auditLogs).values({
      userId: input.userId ?? input.req?.auth?.userId ?? null,
      organizationId: input.organizationId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ipAddress: input.req?.ip ?? null,
      userAgent: input.req?.get("user-agent") ?? null,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      metadataJson: input.metadataJson ?? {}
    });
  } catch (err) {
    console.error("[AUDIT] Failed to write audit log:", err);
  }
}

// server/routes/auth.ts
var router = Router();
function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    initials: user.initials,
    userType: user.userType,
    role: user.role,
    licenseNumber: user.licenseNumber,
    practiceName: user.practiceName,
    doctorName: user.doctorName,
    practiceAddress: user.practiceAddress,
    practicePhone: user.practicePhone,
    phoneContactName: user.phoneContactName,
    accountNumber: user.accountNumber,
    wantsUpdates: user.wantsUpdates,
    workStatus: user.workStatus ?? "available"
  };
}
function mapMembershipRoleToUserRole(role) {
  return role === "owner" || role === "admin" ? "admin" : "user";
}
function buildOrganizationAddress(organization) {
  const address = [
    organization?.addressLine1,
    organization?.addressLine2,
    organization?.city,
    organization?.state,
    organization?.zip
  ].filter(Boolean).join(", ");
  return address || null;
}
function deriveInitialsFromUsername(username) {
  const normalizedUsername = username?.trim() || "";
  if (!normalizedUsername) {
    return "LT";
  }
  const tokenizedParts = normalizedUsername.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((part) => part.trim()).filter(Boolean);
  if (tokenizedParts.length >= 2) {
    return (tokenizedParts[0][0] + tokenizedParts[tokenizedParts.length - 1][0]).toUpperCase();
  }
  const lettersOnly = normalizedUsername.replace(/[^A-Za-z0-9]/g, "");
  if (lettersOnly.length >= 2) {
    return (lettersOnly[0] + lettersOnly[1]).toUpperCase();
  }
  return lettersOnly[0]?.toUpperCase() || "LT";
}
function deriveUserInitials(input) {
  const firstInitial = input.firstName?.trim()?.[0];
  const lastInitial = input.lastName?.trim()?.[0];
  if (firstInitial && lastInitial) {
    return `${firstInitial}${lastInitial}`.toUpperCase();
  }
  return deriveInitialsFromUsername(input.username);
}
async function hydrateUsersWithActiveMemberships(rawUsers) {
  if (rawUsers.length === 0) {
    return [];
  }
  const userIds = rawUsers.map((user) => user.id);
  const memberships = await db.select().from(organizationMemberships).where(
    and2(
      inArray(organizationMemberships.userId, userIds),
      eq2(organizationMemberships.status, "active")
    )
  );
  const organizationIds = [...new Set(memberships.map((membership) => membership.labId))];
  const membershipOrganizations = organizationIds.length ? await db.select().from(organizations).where(inArray(organizations.id, organizationIds)) : [];
  const organizationsById = new Map(
    membershipOrganizations.map((organization) => [organization.id, organization])
  );
  const membershipsByUserId = /* @__PURE__ */ new Map();
  for (const membership of memberships) {
    const existingMemberships = membershipsByUserId.get(membership.userId) ?? [];
    existingMemberships.push(membership);
    membershipsByUserId.set(membership.userId, existingMemberships);
  }
  return rawUsers.map((user) => {
    const base = safeUser(user);
    const activeMemberships = membershipsByUserId.get(user.id) ?? [];
    const primaryMembership = activeMemberships.find((membership) => {
      const organization = organizationsById.get(membership.labId);
      return organization?.type === "lab";
    }) ?? activeMemberships[0];
    const primaryOrganization = primaryMembership ? organizationsById.get(primaryMembership.labId) : null;
    return {
      ...base,
      practiceName: primaryOrganization?.displayName || primaryOrganization?.name || null,
      practiceAddress: base.practiceAddress || buildOrganizationAddress(primaryOrganization),
      practicePhone: base.practicePhone || primaryOrganization?.phone || null,
      role: primaryMembership ? mapMembershipRoleToUserRole(primaryMembership.role) : base.role
    };
  });
}
var registerSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  userType: z.string().optional(),
  role: z.string().optional(),
  licenseNumber: z.string().optional(),
  practiceName: z.string().optional(),
  doctorName: z.string().optional(),
  practiceAddress: z.string().optional(),
  practicePhone: z.string().optional(),
  phoneContactName: z.string().optional(),
  accountNumber: z.string().optional(),
  wantsUpdates: z.boolean().optional(),
  joinOrganizationId: z.string().optional(),
  createOrganization: z.boolean().optional()
});
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const shouldCreateOrganization = !!input.createOrganization && !!input.practiceName?.trim() && (input.userType === "lab" || input.userType === "provider");
    const normalizedUserRole = shouldCreateOrganization ? "admin" : input.role || "user";
    const normalizedPracticeName = shouldCreateOrganization ? input.practiceName?.trim() || null : null;
    const existing = await db.query.users.findFirst({
      where: eq2(users.username, input.username.trim())
    });
    if (existing)
      throw new HttpError(409, "Username already taken.");
    if (input.email) {
      const allUsers = await db.select().from(users);
      const emailMatch = allUsers.find(
        (u) => u.email?.toLowerCase() === input.email.toLowerCase()
      );
      if (emailMatch)
        throw new HttpError(
          409,
          "An account with this email already exists."
        );
    }
    const initials = deriveUserInitials({
      firstName: input.firstName,
      lastName: input.lastName,
      username: input.username
    });
    const hashed = await hashPassword(input.password);
    const [user] = await db.insert(users).values({
      username: input.username.trim(),
      password: hashed,
      email: input.email || null,
      phone: input.phone || null,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      initials,
      userType: input.userType || "lab",
      licenseNumber: input.licenseNumber || null,
      doctorName: input.doctorName || null,
      practiceAddress: input.practiceAddress || null,
      practicePhone: input.practicePhone || null,
      phoneContactName: input.phoneContactName || null,
      accountNumber: input.accountNumber || null,
      wantsUpdates: input.wantsUpdates || false,
      role: normalizedUserRole,
      practiceName: normalizedPracticeName
    }).returning();
    const sessionId = crypto2.randomUUID();
    const rawRefreshToken = signRefreshToken(user.id, sessionId);
    const decoded = verifyRefreshToken(rawRefreshToken);
    await db.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: makeSessionHash(rawRefreshToken),
      deviceName: null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null,
      expiresAt: new Date((decoded.exp ?? 0) * 1e3)
    });
    const accessToken = signAccessToken(user.id, sessionId);
    await writeAuditLog({
      req,
      userId: user.id,
      action: "user_registered",
      entityType: "user",
      entityId: user.id
    });
    let responseMessage = "Account created.";
    let pendingJoinRequest = false;
    let organizationInfo = null;
    if (input.joinOrganizationId) {
      const [org] = await db.select().from(organizations).where(eq2(organizations.id, input.joinOrganizationId));
      if (org) {
        await db.insert(organizationJoinRequests).values({
          labId: org.id,
          userId: user.id,
          requestedRole: input.role === "admin" ? "admin" : "user",
          message: `${user.username} would like to join ${org.displayName || org.name}.`,
          status: "pending"
        });
        organizationInfo = { id: org.id, name: org.displayName || org.name };
        pendingJoinRequest = true;
        responseMessage = `Your request to join ${org.displayName || org.name} has been sent to the lab admin.`;
      }
    } else if (shouldCreateOrganization) {
      const orgType = input.userType === "provider" ? "provider" : "lab";
      const [org] = await db.insert(organizations).values({
        type: orgType,
        name: input.practiceName.trim(),
        displayName: input.practiceName.trim(),
        addressLine1: input.practiceAddress || null,
        phone: input.practicePhone || null,
        billingEmail: input.email || null,
        createdByUserId: user.id
      }).returning();
      await db.insert(organizationMemberships).values({
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        status: "active",
        approvedByUserId: user.id,
        joinedAt: /* @__PURE__ */ new Date()
      });
      organizationInfo = { id: org.id, name: org.displayName || org.name };
      responseMessage = `${org.displayName || org.name} created and linked to your account.`;
    }
    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);
    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: hydratedUser || safeUser(user),
      message: responseMessage,
      pendingJoinRequest,
      organization: organizationInfo
    });
  })
);
var loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  deviceName: z.string().max(180).optional()
});
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const allUsers = await db.select().from(users);
    const user = allUsers.find(
      (u) => u.username.toLowerCase() === input.username.trim().toLowerCase()
    );
    if (!user)
      throw new HttpError(401, "Invalid username or password.");
    let valid = false;
    if (user.password.startsWith("$2")) {
      valid = await verifyPassword(input.password, user.password);
    } else {
      valid = user.password === input.password;
      if (valid) {
        const hashed = await hashPassword(input.password);
        await db.update(users).set({ password: hashed }).where(eq2(users.id, user.id));
      }
    }
    if (!valid) {
      await writeAuditLog({
        req,
        userId: user.id,
        action: "login_failed",
        entityType: "user",
        entityId: user.id
      });
      throw new HttpError(401, "Invalid username or password.");
    }
    const sessionId = crypto2.randomUUID();
    const rawRefreshToken = signRefreshToken(user.id, sessionId);
    const decoded = verifyRefreshToken(rawRefreshToken);
    await db.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: makeSessionHash(rawRefreshToken),
      deviceName: input.deviceName ?? null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? null,
      expiresAt: new Date((decoded.exp ?? 0) * 1e3)
    });
    const accessToken = signAccessToken(user.id, sessionId);
    await db.update(users).set({ lastLoginAt: /* @__PURE__ */ new Date() }).where(eq2(users.id, user.id));
    await writeAuditLog({
      req,
      userId: user.id,
      action: "login_succeeded",
      entityType: "session",
      entityId: sessionId
    });
    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);
    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: hydratedUser || safeUser(user)
    });
  })
);
var refreshSchema = z.object({ refreshToken: z.string().min(1) });
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const payload = verifyRefreshToken(refreshToken);
    const session = await db.query.userSessions.findFirst({
      where: and2(
        eq2(userSessions.id, payload.sid),
        eq2(userSessions.userId, payload.sub),
        eq2(userSessions.tokenHash, makeSessionHash(refreshToken)),
        isNull2(userSessions.revokedAt),
        gt2(userSessions.expiresAt, /* @__PURE__ */ new Date())
      )
    });
    if (!session)
      throw new HttpError(401, "Refresh token is invalid or expired.");
    const accessToken = signAccessToken(payload.sub, payload.sid);
    return ok(res, { accessToken });
  })
);
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.update(userSessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq2(userSessions.id, req.auth.sessionId));
    await writeAuditLog({
      req,
      action: "logout",
      entityType: "session",
      entityId: req.auth.sessionId
    });
    return ok(res, { loggedOut: true });
  })
);
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const memberships = await db.query.organizationMemberships.findMany({
      where: eq2(
        organizationMemberships.userId,
        req.auth.userId
      )
    });
    const orgIds = memberships.map((m) => m.labId);
    const orgs = orgIds.length ? await db.select().from(organizations).where(inArray(organizations.id, orgIds)) : [];
    const [hydratedUser] = await hydrateUsersWithActiveMemberships([user]);
    return res.json({
      success: true,
      user: hydratedUser || safeUser(user),
      memberships: memberships.map((m) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        organizationId: m.labId,
        organization: orgs.find((org) => org.id === m.labId) ?? null
      }))
    });
  })
);
router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const allUsers = await db.select().from(users);
    const hydratedUsers = await hydrateUsersWithActiveMemberships(allUsers);
    res.json({
      users: hydratedUsers
    });
  })
);
router.put(
  "/users/:id/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = req.auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "Unauthorized");
    }
    const user = await db.query.users.findFirst({
      where: eq2(users.id, id)
    });
    if (!user)
      throw new HttpError(404, "User not found");
    const {
      practiceName,
      practiceAddress,
      practicePhone,
      email,
      phone,
      role,
      firstName,
      lastName
    } = req.body;
    const updates = {};
    if (practiceName !== void 0)
      updates.practiceName = practiceName;
    if (practiceAddress !== void 0)
      updates.practiceAddress = practiceAddress;
    if (practicePhone !== void 0)
      updates.practicePhone = practicePhone;
    if (email !== void 0)
      updates.email = email;
    if (phone !== void 0)
      updates.phone = phone;
    if (firstName !== void 0)
      updates.firstName = firstName;
    if (lastName !== void 0)
      updates.lastName = lastName;
    if (role !== void 0 && (role === "admin" || role === "user"))
      updates.role = role;
    if (firstName !== void 0 || lastName !== void 0) {
      updates.initials = deriveUserInitials({
        firstName: firstName !== void 0 ? firstName : user.firstName,
        lastName: lastName !== void 0 ? lastName : user.lastName,
        username: user.username
      });
    }
    const [updated] = await db.update(users).set(updates).where(eq2(users.id, id)).returning();
    await writeAuditLog({
      req,
      userId: id,
      action: "profile_updated",
      entityType: "user",
      entityId: id,
      beforeJson: safeUser(user),
      afterJson: safeUser(updated)
    });
    res.json({ success: true, user: safeUser(updated) });
  })
);
router.put(
  "/users/:id/password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = req.auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "You can only change your own password.");
    }
    const { currentPassword, newPassword } = req.body;
    const user = await db.query.users.findFirst({
      where: eq2(users.id, id)
    });
    if (!user)
      throw new HttpError(404, "User not found");
    let valid = false;
    if (user.password.startsWith("$2")) {
      valid = await verifyPassword(currentPassword, user.password);
    } else {
      valid = user.password === currentPassword;
    }
    if (!valid)
      throw new HttpError(401, "Current password is incorrect");
    const hashed = await hashPassword(newPassword);
    await db.update(users).set({ password: hashed }).where(eq2(users.id, id));
    await writeAuditLog({
      req,
      userId: id,
      action: "password_changed",
      entityType: "user",
      entityId: id
    });
    res.json({ success: true });
  })
);
router.delete(
  "/users/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const authUserId = req.auth.userId;
    if (authUserId !== id) {
      throw new HttpError(403, "You can only delete your own account.");
    }
    const user = await db.query.users.findFirst({
      where: eq2(users.id, id)
    });
    if (!user)
      throw new HttpError(404, "User not found");
    await db.delete(users).where(eq2(users.id, id));
    await writeAuditLog({
      req,
      userId: id,
      action: "user_deleted",
      entityType: "user",
      entityId: id
    });
    res.json({ success: true });
  })
);
async function findLabCreatorId(labName) {
  const org = await db.query.organizations.findFirst({
    where: eq2(organizations.name, labName)
  });
  if (org?.createdByUserId)
    return org.createdByUserId;
  const labAdmins = await db.select().from(users).where(eq2(users.role, "admin"));
  const matching = labAdmins.filter((u) => u.practiceName?.toLowerCase().trim() === labName.toLowerCase().trim()).sort((a, b) => {
    const aT = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
    const bT = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
    return aT - bT;
  });
  return matching.length > 0 ? matching[0].id : null;
}
router.get(
  "/lab-creator",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user.practiceName) {
      return res.json({ isLabCreator: false });
    }
    const creatorId = await findLabCreatorId(user.practiceName);
    res.json({ isLabCreator: creatorId === user.id });
  })
);
router.delete(
  "/delete-lab",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user.practiceName) {
      throw new HttpError(400, "You are not associated with any lab.");
    }
    const labName = user.practiceName;
    const creatorId = await findLabCreatorId(labName);
    if (!creatorId || creatorId !== user.id) {
      throw new HttpError(403, "Only the admin who created this lab can delete it.");
    }
    const labNameLower = labName.toLowerCase().trim();
    const allLabUsers = await db.select().from(users);
    const labMembers = allLabUsers.filter(
      (u) => u.practiceName?.toLowerCase().trim() === labNameLower
    );
    const memberIds = labMembers.map((m) => m.id);
    if (memberIds.length > 0) {
      await db.update(users).set({ practiceName: null }).where(inArray(users.id, memberIds));
    }
    await writeAuditLog({
      req,
      userId: user.id,
      action: "lab_deleted",
      entityType: "organization",
      entityId: labNameLower,
      details: { labName, membersRemoved: memberIds.length }
    });
    res.json({ success: true, membersRemoved: memberIds.length });
  })
);
router.patch(
  "/me/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const validStatuses = ["available", "break", "out_of_office"];
    const { workStatus } = req.body;
    if (!validStatuses.includes(workStatus)) {
      throw new HttpError(400, "Invalid status. Must be one of: available, break, out_of_office.");
    }
    const userId = req.auth.userId;
    const [updated] = await db.update(users).set({ workStatus }).where(eq2(users.id, userId)).returning();
    return ok(res, safeUser(updated));
  })
);
var auth_default = router;

// server/routes/organizations.ts
import { Router as Router2 } from "express";
import { and as and4, eq as eq4, inArray as inArray2, ne } from "drizzle-orm";
import { z as z2 } from "zod";

// server/lib/rbac.ts
import { and as and3, eq as eq3 } from "drizzle-orm";
async function getActiveMembership(userId, organizationId) {
  const membership = await db.query.organizationMemberships.findFirst({
    where: and3(
      eq3(organizationMemberships.userId, userId),
      eq3(organizationMemberships.labId, organizationId),
      eq3(organizationMemberships.status, "active")
    )
  });
  return membership ?? null;
}
async function requireMembership(userId, organizationId) {
  const membership = await getActiveMembership(userId, organizationId);
  if (!membership) {
    throw new HttpError(403, "You do not belong to this organization.");
  }
  return membership;
}
async function requireAnyRole(userId, organizationId, roles) {
  const membership = await requireMembership(userId, organizationId);
  if (!roles.includes(membership.role)) {
    throw new HttpError(403, "You do not have permission for this action.");
  }
  return membership;
}
var ADMIN_ROLES = ["owner", "admin"];
var BILLING_ROLES = ["owner", "admin", "billing"];

// server/routes/organizations.ts
var router2 = Router2();
router2.use(requireAuth);
var createOrgSchema = z2.object({
  type: z2.enum(["lab", "provider"]),
  name: z2.string().min(1),
  displayName: z2.string().optional(),
  billingEmail: z2.string().email().optional(),
  phone: z2.string().optional(),
  addressLine1: z2.string().optional(),
  addressLine2: z2.string().optional(),
  city: z2.string().optional(),
  state: z2.string().optional(),
  zip: z2.string().optional()
});
function mapMembershipRoleToUserRole2(role) {
  return role === "owner" || role === "admin" ? "admin" : "user";
}
function getOrganizationDisplayName(organization) {
  return organization.displayName || organization.name;
}
function getOrganizationAddress(organization) {
  const address = [
    organization.addressLine1,
    organization.addressLine2,
    organization.city,
    organization.state,
    organization.zip
  ].filter(Boolean).join(", ");
  return address || null;
}
async function repairLabCaseAffiliations(labId) {
  const [org, activeMembers] = await Promise.all([
    db.query.organizations.findFirst({ where: eq4(organizations.id, labId) }),
    db.select({ userId: organizationMemberships.userId }).from(organizationMemberships).where(
      and4(
        eq4(organizationMemberships.labId, labId),
        eq4(organizationMemberships.status, "active")
      )
    )
  ]);
  if (!org || activeMembers.length === 0)
    return;
  const memberUserIds = activeMembers.map((m) => m.userId);
  const caseRows = await db.select().from(labCases).where(inArray2(labCases.ownerId, memberUserIds));
  if (caseRows.length === 0)
    return;
  const orgAffiliationKey = `org:${labId}`;
  const orgAffiliationName = org.displayName || org.name || null;
  const repairPromises = [];
  for (const row of caseRows) {
    if (!row.caseData)
      continue;
    let caseData;
    try {
      caseData = JSON.parse(row.caseData);
    } catch {
      continue;
    }
    const existingKey = caseData.affiliationKey;
    const needsRepair = !existingKey || existingKey.startsWith("private:") || !existingKey.startsWith("org:") && !existingKey.startsWith("lab:");
    if (!needsRepair)
      continue;
    const repairedData = {
      ...caseData,
      affiliationKey: orgAffiliationKey,
      affiliationName: orgAffiliationName
    };
    repairPromises.push(
      db.insert(labCases).values({
        id: row.id,
        ownerId: row.ownerId,
        caseData: JSON.stringify(repairedData),
        updatedAt: /* @__PURE__ */ new Date()
      }).onConflictDoUpdate({
        target: labCases.id,
        set: {
          caseData: JSON.stringify(repairedData),
          updatedAt: /* @__PURE__ */ new Date()
        }
      })
    );
  }
  if (repairPromises.length > 0) {
    await Promise.all(repairPromises);
  }
}
async function syncUserToOrganization(userId, organizationId, membershipRole) {
  const organization = await db.query.organizations.findFirst({
    where: eq4(organizations.id, organizationId)
  });
  if (!organization) {
    return null;
  }
  await db.update(users).set({
    practiceName: getOrganizationDisplayName(organization),
    practiceAddress: getOrganizationAddress(organization),
    practicePhone: organization.phone || null,
    role: mapMembershipRoleToUserRole2(membershipRole)
  }).where(eq4(users.id, userId));
  return organization;
}
async function syncUsersToOrganization(organizationId, organization) {
  const resolvedOrganization = organization || await db.query.organizations.findFirst({
    where: eq4(organizations.id, organizationId)
  });
  if (!resolvedOrganization) {
    return;
  }
  const memberships = await db.query.organizationMemberships.findMany({
    where: and4(
      eq4(organizationMemberships.labId, organizationId),
      eq4(organizationMemberships.status, "active")
    )
  });
  for (const membership of memberships) {
    await db.update(users).set({
      practiceName: getOrganizationDisplayName(resolvedOrganization),
      practiceAddress: getOrganizationAddress(resolvedOrganization),
      practicePhone: resolvedOrganization.phone || null,
      role: mapMembershipRoleToUserRole2(membership.role)
    }).where(eq4(users.id, membership.userId));
  }
}
async function syncUserFromActiveMemberships(userId) {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and4(
      eq4(organizationMemberships.userId, userId),
      eq4(organizationMemberships.status, "active")
    )
  });
  if (memberships.length === 0) {
    await db.update(users).set({
      practiceName: null,
      practiceAddress: null,
      practicePhone: null,
      role: "user"
    }).where(eq4(users.id, userId));
    return;
  }
  const primaryMembership = memberships[0];
  await syncUserToOrganization(
    userId,
    primaryMembership.labId,
    primaryMembership.role
  );
}
router2.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createOrgSchema.parse(req.body);
    const [organization] = await db.insert(organizations).values({
      ...input,
      createdByUserId: req.auth.userId
    }).returning();
    await db.insert(organizationMemberships).values({
      labId: organization.id,
      userId: req.auth.userId,
      role: "owner",
      status: "active",
      approvedByUserId: req.auth.userId,
      joinedAt: /* @__PURE__ */ new Date()
    });
    await syncUserToOrganization(
      req.auth.userId,
      organization.id,
      "owner"
    );
    await writeAuditLog({
      req,
      organizationId: organization.id,
      action: "organization_created",
      entityType: "organization",
      entityId: organization.id,
      afterJson: organization
    });
    return ok(res, organization, 201);
  })
);
router2.get(
  "/",
  asyncHandler(async (req, res) => {
    const memberships = await db.query.organizationMemberships.findMany({
      where: eq4(
        organizationMemberships.userId,
        req.auth.userId
      )
    });
    const orgIds = memberships.filter((m) => m.status === "active").map((m) => m.labId);
    const orgs = orgIds.length ? await db.select().from(organizations).where(inArray2(organizations.id, orgIds)) : [];
    return ok(res, orgs);
  })
);
router2.get(
  "/invites/pending-for-me",
  asyncHandler(async (req, res) => {
    const currentEmail = req.user.email?.toLowerCase?.().trim?.();
    if (!currentEmail) {
      return ok(res, []);
    }
    const invites = await db.query.organizationInvites.findMany({
      where: and4(
        eq4(organizationInvites.email, currentEmail),
        eq4(organizationInvites.status, "pending")
      )
    });
    const organizationIds = [...new Set(invites.map((invite) => invite.labId))];
    const inviterIds = [...new Set(invites.map((invite) => invite.invitedByUserId))];
    const inviteOrganizations = organizationIds.length ? await db.select().from(organizations).where(inArray2(organizations.id, organizationIds)) : [];
    const inviters = inviterIds.length ? await db.select().from(users).where(inArray2(users.id, inviterIds)) : [];
    const organizationsById = new Map(
      inviteOrganizations.map((organization) => [organization.id, organization])
    );
    const invitersById = new Map(inviters.map((inviter) => [inviter.id, inviter]));
    return ok(
      res,
      invites.map((invite) => ({
        ...invite,
        organizationId: invite.labId,
        organization: organizationsById.get(invite.labId) ?? null,
        invitedByUser: invitersById.get(invite.invitedByUserId) ? {
          id: invitersById.get(invite.invitedByUserId).id,
          username: invitersById.get(invite.invitedByUserId).username,
          email: invitersById.get(invite.invitedByUserId).email
        } : null
      }))
    );
  })
);
router2.get(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    await requireMembership(
      req.auth.userId,
      req.params.organizationId
    );
    const organization = await db.query.organizations.findFirst({
      where: eq4(organizations.id, req.params.organizationId)
    });
    if (!organization)
      throw new HttpError(404, "Organization not found.");
    return ok(res, organization);
  })
);
router2.patch(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      req.auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const input = createOrgSchema.partial().parse(req.body);
    const existing = await db.query.organizations.findFirst({
      where: eq4(organizations.id, organizationId)
    });
    if (!existing)
      throw new HttpError(404, "Organization not found.");
    const [updated] = await db.update(organizations).set(input).where(eq4(organizations.id, organizationId)).returning();
    await syncUsersToOrganization(organizationId, updated);
    await writeAuditLog({
      req,
      organizationId,
      action: "organization_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: existing,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router2.get(
  "/:organizationId/members",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireMembership(
      req.auth.userId,
      organizationId
    );
    const memberships = await db.query.organizationMemberships.findMany({
      where: eq4(
        organizationMemberships.labId,
        organizationId
      )
    });
    const userIds = memberships.map((m) => m.userId);
    const allUsers = userIds.length ? await db.query.users.findMany({
      where: inArray2(users.id, userIds)
    }) : [];
    return ok(
      res,
      memberships.map((membership) => ({
        ...membership,
        user: allUsers.find((user) => user.id === membership.userId) ? {
          id: allUsers.find((user) => user.id === membership.userId).id,
          username: allUsers.find((user) => user.id === membership.userId).username,
          email: allUsers.find((user) => user.id === membership.userId).email,
          firstName: allUsers.find((user) => user.id === membership.userId).firstName,
          lastName: allUsers.find((user) => user.id === membership.userId).lastName,
          initials: allUsers.find((user) => user.id === membership.userId).initials
        } : null
      }))
    );
  })
);
var inviteSchema = z2.object({
  email: z2.string().email(),
  phone: z2.string().optional(),
  roleToAssign: z2.enum(["owner", "admin", "user", "billing", "read_only"]),
  expiresInDays: z2.coerce.number().int().min(1).max(30).default(7)
});
router2.post(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      req.auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const input = inviteSchema.parse(req.body);
    const existingInvite = await db.query.organizationInvites.findFirst({
      where: and4(
        eq4(organizationInvites.labId, organizationId),
        eq4(organizationInvites.email, input.email.toLowerCase()),
        eq4(organizationInvites.status, "pending")
      )
    });
    if (existingInvite) {
      throw new HttpError(409, "A pending invite already exists for that email address.");
    }
    const [invite] = await db.insert(organizationInvites).values({
      labId: organizationId,
      email: input.email.toLowerCase(),
      phone: input.phone ?? null,
      roleToAssign: input.roleToAssign,
      token: generateInviteToken(),
      invitedByUserId: req.auth.userId,
      expiresAt: new Date(
        Date.now() + input.expiresInDays * 24 * 60 * 60 * 1e3
      )
    }).returning();
    await writeAuditLog({
      req,
      organizationId,
      action: "organization_invite_created",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: invite
    });
    return ok(res, invite, 201);
  })
);
router2.get(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      req.auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const invites = await db.query.organizationInvites.findMany({
      where: eq4(organizationInvites.labId, organizationId)
    });
    return ok(res, invites.map((inv) => ({ ...inv, organizationId: inv.labId })));
  })
);
router2.post(
  "/invites/:inviteId/decline",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: and4(
        eq4(organizationInvites.id, req.params.inviteId),
        eq4(organizationInvites.status, "pending")
      )
    });
    if (!invite) {
      throw new HttpError(404, "Invite not found or already handled.");
    }
    const currentEmail = req.user.email?.toLowerCase?.().trim?.();
    if (!currentEmail || !invite.email || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }
    const [updatedInvite] = await db.update(organizationInvites).set({
      status: "declined"
    }).where(eq4(organizationInvites.id, invite.id)).returning();
    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_declined",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: updatedInvite
    });
    return ok(res, updatedInvite);
  })
);
router2.post(
  "/invites/:token/accept",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: and4(
        eq4(organizationInvites.token, req.params.token),
        eq4(organizationInvites.status, "pending")
      )
    });
    if (!invite)
      throw new HttpError(404, "Invite not found or already used.");
    if (!invite.roleToAssign || !invite.email)
      throw new HttpError(410, "Invite is invalid or incomplete.");
    if (invite.expiresAt && /* @__PURE__ */ new Date() > invite.expiresAt)
      throw new HttpError(410, "Invite has expired.");
    const userId = req.auth.userId;
    const currentEmail = req.user.email?.toLowerCase?.().trim?.();
    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }
    const assignedRole = invite.roleToAssign;
    await db.insert(organizationMemberships).values({
      labId: invite.labId,
      userId,
      role: assignedRole,
      status: "active",
      invitedByUserId: invite.invitedByUserId,
      approvedByUserId: invite.invitedByUserId,
      joinedAt: /* @__PURE__ */ new Date()
    }).onConflictDoUpdate({
      target: [
        organizationMemberships.labId,
        organizationMemberships.userId
      ],
      set: {
        role: assignedRole,
        status: "active",
        invitedByUserId: invite.invitedByUserId,
        joinedAt: /* @__PURE__ */ new Date()
      }
    });
    await db.update(organizationInvites).set({
      status: "accepted",
      acceptedByUserId: userId,
      acceptedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationInvites.id, invite.id));
    await syncUserToOrganization(userId, invite.labId, assignedRole);
    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_accepted",
      entityType: "organization_invite",
      entityId: invite.id
    });
    return ok(res, { accepted: true });
  })
);
var joinRequestSchema = z2.object({
  requestedRole: z2.enum(["admin", "user", "billing", "read_only"]).default("user"),
  message: z2.string().max(1e3).optional()
});
router2.post(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const input = joinRequestSchema.parse(req.body);
    const alreadyMember = await db.query.organizationMemberships.findFirst({
      where: and4(
        eq4(organizationMemberships.labId, organizationId),
        eq4(
          organizationMemberships.userId,
          req.auth.userId
        )
      )
    });
    if (alreadyMember)
      throw new HttpError(
        409,
        "You already have a membership record for this organization."
      );
    const existingPendingRequest = await db.query.organizationJoinRequests.findFirst({
      where: and4(
        eq4(organizationJoinRequests.labId, organizationId),
        eq4(
          organizationJoinRequests.userId,
          req.auth.userId
        ),
        eq4(organizationJoinRequests.status, "pending")
      )
    });
    if (existingPendingRequest) {
      throw new HttpError(409, "You already have a pending join request.");
    }
    const [request] = await db.insert(organizationJoinRequests).values({
      labId: organizationId,
      userId: req.auth.userId,
      requestedRole: input.requestedRole,
      message: input.message ?? null
    }).returning();
    await writeAuditLog({
      req,
      organizationId,
      action: "organization_join_requested",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: request
    });
    return ok(res, request, 201);
  })
);
router2.get(
  "/join-requests/mine/pending",
  asyncHandler(async (req, res) => {
    const currentUserId = req.auth.userId;
    const requests = await db.query.organizationJoinRequests.findMany({
      where: and4(
        eq4(organizationJoinRequests.userId, currentUserId),
        eq4(organizationJoinRequests.status, "pending")
      )
    });
    const organizationIds = [...new Set(requests.map((request) => request.labId))];
    const requestOrganizations = organizationIds.length ? await db.select().from(organizations).where(inArray2(organizations.id, organizationIds)) : [];
    const organizationsById = new Map(
      requestOrganizations.map((organization) => [organization.id, organization])
    );
    return ok(
      res,
      requests.map((request) => ({
        ...request,
        organizationId: request.labId,
        requestedByUserId: request.userId,
        organization: organizationsById.get(request.labId) ?? null
      }))
    );
  })
);
router2.get(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      req.auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const requests = await db.query.organizationJoinRequests.findMany({
      where: and4(
        eq4(organizationJoinRequests.labId, organizationId),
        eq4(organizationJoinRequests.status, "pending")
      )
    });
    return ok(res, requests.map((r) => ({
      ...r,
      organizationId: r.labId,
      requestedByUserId: r.userId
    })));
  })
);
router2.post(
  "/join-requests/:joinRequestId/approve",
  asyncHandler(async (req, res) => {
    const request = await db.query.organizationJoinRequests.findFirst({
      where: eq4(
        organizationJoinRequests.id,
        req.params.joinRequestId
      )
    });
    if (!request)
      throw new HttpError(404, "Join request not found.");
    await requireAnyRole(
      req.auth.userId,
      request.labId,
      ADMIN_ROLES
    );
    if (request.status === "approved") {
      const existingMembership = await db.query.organizationMemberships.findFirst({
        where: and4(
          eq4(organizationMemberships.labId, request.labId),
          eq4(organizationMemberships.userId, request.userId)
        )
      });
      return ok(res, { membership: existingMembership ?? null, request });
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot approve a request that is already ${request.status}.`
      );
    }
    const roleToAssign = req.body.role || request.requestedRole;
    const [membership] = await db.insert(organizationMemberships).values({
      labId: request.labId,
      userId: request.userId,
      role: roleToAssign,
      status: "active",
      approvedByUserId: req.auth.userId,
      joinedAt: /* @__PURE__ */ new Date()
    }).onConflictDoUpdate({
      target: [
        organizationMemberships.labId,
        organizationMemberships.userId
      ],
      set: {
        role: roleToAssign,
        status: "active",
        approvedByUserId: req.auth.userId,
        joinedAt: /* @__PURE__ */ new Date()
      }
    }).returning();
    await db.delete(organizationJoinRequests).where(
      and4(
        eq4(organizationJoinRequests.labId, request.labId),
        eq4(organizationJoinRequests.userId, request.userId),
        eq4(organizationJoinRequests.status, "approved"),
        ne(organizationJoinRequests.id, request.id)
      )
    );
    const [updatedRequest] = await db.update(organizationJoinRequests).set({
      status: "approved",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationJoinRequests.id, request.id)).returning();
    await syncUserToOrganization(
      request.userId,
      request.labId,
      roleToAssign
    );
    repairLabCaseAffiliations(request.labId).catch(() => {
    });
    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_approved",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updatedRequest
    });
    return ok(res, { membership, request: updatedRequest });
  })
);
router2.delete(
  "/join-requests/:joinRequestId",
  asyncHandler(async (req, res) => {
    const request = await db.query.organizationJoinRequests.findFirst({
      where: eq4(
        organizationJoinRequests.id,
        req.params.joinRequestId
      )
    });
    if (!request)
      throw new HttpError(404, "Join request not found.");
    if (request.userId !== req.auth.userId) {
      throw new HttpError(403, "You can only cancel your own join request.");
    }
    if (request.status !== "pending") {
      throw new HttpError(409, "Only pending join requests can be cancelled.");
    }
    const [updated] = await db.update(organizationJoinRequests).set({
      status: "cancelled",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationJoinRequests.id, request.id)).returning();
    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_cancelled",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router2.post(
  "/join-requests/:joinRequestId/reject",
  asyncHandler(async (req, res) => {
    const request = await db.query.organizationJoinRequests.findFirst({
      where: eq4(
        organizationJoinRequests.id,
        req.params.joinRequestId
      )
    });
    if (!request)
      throw new HttpError(404, "Join request not found.");
    await requireAnyRole(
      req.auth.userId,
      request.labId,
      ADMIN_ROLES
    );
    if (request.status === "rejected") {
      return ok(res, request);
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot reject a request that is already ${request.status}.`
      );
    }
    const [updated] = await db.update(organizationJoinRequests).set({
      status: "rejected",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationJoinRequests.id, request.id)).returning();
    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_rejected",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
var connectionSchema = z2.object({
  labOrganizationId: z2.string().uuid(),
  providerOrganizationId: z2.string().uuid()
});
router2.post(
  "/connections",
  asyncHandler(async (req, res) => {
    const input = connectionSchema.parse(req.body);
    const isLabMember = await requireMembership(
      req.auth.userId,
      input.labOrganizationId
    ).catch(() => null);
    const isProviderMember = await requireMembership(
      req.auth.userId,
      input.providerOrganizationId
    ).catch(() => null);
    if (!isLabMember && !isProviderMember)
      throw new HttpError(
        403,
        "You must belong to one side of the connection request."
      );
    const [connection] = await db.insert(organizationConnections).values({
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      requestedByOrgId: isLabMember ? input.labOrganizationId : input.providerOrganizationId,
      userId: req.auth.userId
    }).onConflictDoNothing().returning();
    return ok(
      res,
      connection ?? { alreadyExists: true },
      connection ? 201 : 200
    );
  })
);
router2.post(
  "/connections/:connectionId/approve",
  asyncHandler(async (req, res) => {
    const connection = await db.query.organizationConnections.findFirst({
      where: eq4(
        organizationConnections.id,
        req.params.connectionId
      )
    });
    if (!connection)
      throw new HttpError(404, "Connection not found.");
    const targetOrgId = connection.requestedByOrgId === connection.labOrganizationId ? connection.providerOrganizationId : connection.labOrganizationId;
    await requireAnyRole(
      req.auth.userId,
      targetOrgId,
      ADMIN_ROLES
    );
    const [updated] = await db.update(organizationConnections).set({
      status: "active",
      approvedByUserId: req.auth.userId,
      approvedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationConnections.id, connection.id)).returning();
    await writeAuditLog({
      req,
      organizationId: targetOrgId,
      action: "organization_connection_approved",
      entityType: "organization_connection",
      entityId: connection.id,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router2.patch(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const input = z2.object({
      role: z2.enum(["owner", "admin", "user", "billing", "read_only"]).optional(),
      status: z2.enum(["active", "pending", "invited", "suspended"]).optional()
    }).parse(req.body);
    const membership = await db.query.organizationMemberships.findFirst({
      where: eq4(
        organizationMemberships.id,
        req.params.membershipId
      )
    });
    if (!membership)
      throw new HttpError(404, "Membership not found.");
    await requireAnyRole(
      req.auth.userId,
      membership.labId,
      ADMIN_ROLES
    );
    const [updated] = await db.update(organizationMemberships).set(input).where(eq4(organizationMemberships.id, membership.id)).returning();
    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_updated",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router2.delete(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const membership = await db.query.organizationMemberships.findFirst({
      where: eq4(
        organizationMemberships.id,
        req.params.membershipId
      )
    });
    if (!membership)
      throw new HttpError(404, "Membership not found.");
    const isOwnMembership = membership.userId === req.auth.userId;
    if (!isOwnMembership) {
      await requireAnyRole(
        req.auth.userId,
        membership.labId,
        ADMIN_ROLES
      );
    }
    await db.delete(organizationMemberships).where(eq4(organizationMemberships.id, membership.id));
    await syncUserFromActiveMemberships(membership.userId);
    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_removed",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership
    });
    return ok(res, { removed: true });
  })
);
var organizations_default = router2;

// server/routes/cases.ts
import { Router as Router3 } from "express";
import { desc, eq as eq5, inArray as inArray3, or } from "drizzle-orm";
import { z as z3 } from "zod";
var router3 = Router3();
router3.use(requireAuth);
async function assertCaseAccess(userId, caseId) {
  const found = await db.query.cases.findFirst({
    where: eq5(cases.id, caseId)
  });
  if (!found)
    throw new HttpError(404, "Case not found.");
  const labMembership = await requireMembership(
    userId,
    found.labOrganizationId
  ).catch(() => null);
  const providerMembership = await requireMembership(
    userId,
    found.providerOrganizationId
  ).catch(() => null);
  if (!labMembership && !providerMembership)
    throw new HttpError(403, "You do not have access to this case.");
  return found;
}
var createCaseSchema = z3.object({
  caseNumber: z3.string().min(1),
  labOrganizationId: z3.string(),
  providerOrganizationId: z3.string(),
  patientFirstName: z3.string().min(1),
  patientLastName: z3.string().min(1),
  externalPatientId: z3.string().optional(),
  doctorName: z3.string().min(1),
  status: z3.enum([
    "received",
    "in_design",
    "in_milling",
    "in_porcelain",
    "qc",
    "shipped",
    "delivered",
    "on_hold",
    "remake",
    "cancelled"
  ]).default("received"),
  priority: z3.enum(["normal", "rush"]).default("normal"),
  dueDate: z3.string().optional(),
  restorations: z3.array(
    z3.object({
      toothNumber: z3.string().min(1),
      restorationType: z3.string().min(1),
      material: z3.string().optional(),
      shade: z3.string().optional(),
      notes: z3.string().optional(),
      quantity: z3.coerce.number().int().positive().default(1),
      unitPrice: z3.coerce.number().min(0).default(0)
    })
  ).optional()
});
router3.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createCaseSchema.parse(req.body);
    await requireMembership(
      req.auth.userId,
      input.labOrganizationId
    );
    const [createdCase] = await db.insert(cases).values({
      caseNumber: input.caseNumber,
      labOrganizationId: input.labOrganizationId,
      providerOrganizationId: input.providerOrganizationId,
      patientFirstName: input.patientFirstName,
      patientLastName: input.patientLastName,
      externalPatientId: input.externalPatientId ?? null,
      doctorName: input.doctorName,
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdByUserId: req.auth.userId
    }).returning();
    if (input.restorations && input.restorations.length > 0) {
      await db.insert(caseRestorations).values(
        input.restorations.map((r) => ({
          caseId: createdCase.id,
          toothNumber: r.toothNumber,
          restorationType: r.restorationType,
          material: r.material ?? null,
          shade: r.shade ?? null,
          notes: r.notes ?? null,
          quantity: r.quantity,
          unitPrice: r.unitPrice.toFixed(2)
        }))
      );
    }
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: createdCase.id,
      eventType: "case_created",
      actorUserId: req.auth.userId,
      actorOrganizationId: input.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        restorations: input.restorations?.length || 0
      }
    });
    await writeAuditLog({
      req,
      organizationId: input.labOrganizationId,
      action: "case_created",
      entityType: "case",
      entityId: createdCase.id,
      afterJson: createdCase
    });
    return ok(res, createdCase, 201);
  })
);
router3.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = req.query.organizationId;
    const membershipOrgIds = organizationId ? [organizationId] : (await db.query.organizationMemberships.findMany({
      where: eq5(
        organizationMemberships.userId,
        req.auth.userId
      )
    })).map((m) => m.labId);
    const rows = membershipOrgIds.length ? await db.query.cases.findMany({
      where: or(
        inArray3(cases.labOrganizationId, membershipOrgIds),
        inArray3(cases.providerOrganizationId, membershipOrgIds)
      ),
      orderBy: [desc(cases.createdAt)]
    }) : [];
    return ok(res, rows);
  })
);
router3.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    const [restorations, notes, attachments, events, locations] = await Promise.all([
      db.query.caseRestorations.findMany({
        where: eq5(caseRestorations.caseId, found.id)
      }),
      db.query.caseNotes.findMany({
        where: eq5(caseNotes.caseId, found.id),
        orderBy: [desc(caseNotes.createdAt)]
      }),
      db.query.caseAttachments.findMany({
        where: eq5(caseAttachments.caseId, found.id),
        orderBy: [desc(caseAttachments.createdAt)]
      }),
      db.query.caseEvents.findMany({
        where: eq5(caseEvents.caseId, found.id),
        orderBy: [desc(caseEvents.occurredAt)]
      }),
      db.query.caseLocations.findMany({
        where: eq5(caseLocations.caseId, found.id)
      })
    ]);
    return ok(res, {
      ...found,
      restorations,
      notes,
      attachments,
      events,
      locations
    });
  })
);
var updateCaseSchema = z3.object({
  status: z3.enum([
    "received",
    "in_design",
    "in_milling",
    "in_porcelain",
    "qc",
    "shipped",
    "delivered",
    "on_hold",
    "remake",
    "cancelled"
  ]).optional(),
  priority: z3.enum(["normal", "rush"]).optional(),
  dueDate: z3.string().optional(),
  doctorName: z3.string().optional(),
  patientFirstName: z3.string().optional(),
  patientLastName: z3.string().optional()
});
router3.patch(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireMembership(
      req.auth.userId,
      found.labOrganizationId
    );
    const input = updateCaseSchema.parse(req.body);
    const updates = {};
    if (input.status !== void 0)
      updates.status = input.status;
    if (input.priority !== void 0)
      updates.priority = input.priority;
    if (input.dueDate !== void 0)
      updates.dueDate = new Date(input.dueDate);
    if (input.doctorName !== void 0)
      updates.doctorName = input.doctorName;
    if (input.patientFirstName !== void 0)
      updates.patientFirstName = input.patientFirstName;
    if (input.patientLastName !== void 0)
      updates.patientLastName = input.patientLastName;
    const [updated] = await db.update(cases).set(updates).where(eq5(cases.id, found.id)).returning();
    if (input.status && input.status !== found.status) {
      const user = req.user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "status_changed",
        actorUserId: req.auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromStatus: found.status,
          toStatus: input.status
        }
      });
    }
    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_updated",
      entityType: "case",
      entityId: found.id,
      beforeJson: found,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router3.delete(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      req.auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    await db.delete(cases).where(eq5(cases.id, found.id));
    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_deleted",
      entityType: "case",
      entityId: found.id
    });
    return ok(res, { deleted: true });
  })
);
router3.post(
  "/:caseId/notes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    const input = z3.object({
      noteText: z3.string().min(1),
      visibility: z3.enum(["internal_lab_only", "shared_with_provider"]).default("shared_with_provider")
    }).parse(req.body);
    const labMember = await requireMembership(
      req.auth.userId,
      found.labOrganizationId
    ).catch(() => null);
    const authorOrgId = labMember ? found.labOrganizationId : found.providerOrganizationId;
    const [note] = await db.insert(caseNotes).values({
      caseId: found.id,
      authorUserId: req.auth.userId,
      authorOrganizationId: authorOrgId,
      noteText: input.noteText,
      visibility: input.visibility
    }).returning();
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "note_added",
      actorUserId: req.auth.userId,
      actorOrganizationId: authorOrgId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { visibility: input.visibility, noteId: note.id }
    });
    return ok(res, note, 201);
  })
);
router3.post(
  "/:caseId/location-changes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireMembership(
      req.auth.userId,
      found.labOrganizationId
    );
    const input = z3.object({
      locationCode: z3.string().min(1),
      locationName: z3.string().min(1),
      notes: z3.string().optional()
    }).parse(req.body);
    const [location] = await db.insert(caseLocations).values({
      caseId: found.id,
      locationCode: input.locationCode,
      locationName: input.locationName,
      movedByUserId: req.auth.userId,
      notes: input.notes ?? null
    }).returning();
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "location_changed",
      actorUserId: req.auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        locationCode: input.locationCode,
        locationName: input.locationName
      }
    });
    return ok(res, location, 201);
  })
);
router3.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireMembership(
      req.auth.userId,
      found.labOrganizationId
    );
    const input = z3.object({
      toothNumber: z3.string().min(1),
      restorationType: z3.string().min(1),
      material: z3.string().optional(),
      shade: z3.string().optional(),
      notes: z3.string().optional(),
      quantity: z3.coerce.number().int().positive().default(1),
      unitPrice: z3.coerce.number().min(0).default(0)
    }).parse(req.body);
    const [restoration] = await db.insert(caseRestorations).values({
      caseId: found.id,
      toothNumber: input.toothNumber,
      restorationType: input.restorationType,
      material: input.material ?? null,
      shade: input.shade ?? null,
      notes: input.notes ?? null,
      quantity: input.quantity,
      unitPrice: input.unitPrice.toFixed(2)
    }).returning();
    return ok(res, restoration, 201);
  })
);
router3.post(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireMembership(
      req.auth.userId,
      found.providerOrganizationId
    );
    const input = z3.object({
      submissionType: z3.enum(["note", "photo", "video", "document"]),
      payloadJson: z3.record(z3.any())
    }).parse(req.body);
    const [submission] = await db.insert(caseSubmissionQueue).values({
      caseId: found.id,
      submittedByUserId: req.auth.userId,
      submittedByOrganizationId: found.providerOrganizationId,
      submissionType: input.submissionType,
      payloadJson: input.payloadJson
    }).returning();
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "provider_submission_received",
      actorUserId: req.auth.userId,
      actorOrganizationId: found.providerOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType
      }
    });
    return ok(res, submission, 201);
  })
);
router3.get(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      req.auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      req.auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const submissions = await db.query.caseSubmissionQueue.findMany({
      where: eq5(caseSubmissionQueue.caseId, found.id),
      orderBy: [desc(caseSubmissionQueue.createdAt)]
    });
    return ok(res, submissions);
  })
);
router3.post(
  "/submissions/:submissionId/approve",
  asyncHandler(async (req, res) => {
    const submission = await db.query.caseSubmissionQueue.findFirst({
      where: eq5(caseSubmissionQueue.id, req.params.submissionId)
    });
    if (!submission)
      throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      req.auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      req.auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const [approved] = await db.update(caseSubmissionQueue).set({
      status: "approved",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq5(caseSubmissionQueue.id, submission.id)).returning();
    if (submission.submissionType === "note" && typeof submission.payloadJson?.noteText === "string") {
      await db.insert(caseNotes).values({
        caseId: submission.caseId,
        authorUserId: submission.submittedByUserId,
        authorOrganizationId: submission.submittedByOrganizationId,
        noteText: submission.payloadJson.noteText,
        visibility: "shared_with_provider"
      });
    }
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_approved",
      actorUserId: req.auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType
      }
    });
    return ok(res, approved);
  })
);
router3.post(
  "/submissions/:submissionId/reject",
  asyncHandler(async (req, res) => {
    const submission = await db.query.caseSubmissionQueue.findFirst({
      where: eq5(caseSubmissionQueue.id, req.params.submissionId)
    });
    if (!submission)
      throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      req.auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      req.auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const input = z3.object({ reviewNotes: z3.string().max(1e3).optional() }).parse(req.body ?? {});
    const [rejected] = await db.update(caseSubmissionQueue).set({
      status: "rejected",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date(),
      reviewNotes: input.reviewNotes ?? null
    }).where(eq5(caseSubmissionQueue.id, submission.id)).returning();
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_rejected",
      actorUserId: req.auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { submissionId: submission.id }
    });
    return ok(res, rejected);
  })
);
var cases_default = router3;

// server/routes/invoices.ts
import { Router as Router4 } from "express";
import { and as and6, desc as desc2, eq as eq6, gte, lte, or as or2, sum } from "drizzle-orm";
import { z as z4 } from "zod";

// server/lib/case.ts
function calculateLineTotal(quantity, unitPrice) {
  return (quantity * Number(unitPrice)).toFixed(2);
}
function sumMoney(values) {
  return values.reduce((acc, v) => acc + Number(v), 0).toFixed(2);
}

// server/routes/invoices.ts
var router4 = Router4();
router4.use(requireAuth);
function nextInvoiceNumber(caseNumber) {
  return `INV-${caseNumber}`;
}
router4.post(
  "/cases/:caseId/generate-invoice",
  asyncHandler(async (req, res) => {
    const found = await db.query.cases.findFirst({
      where: eq6(cases.id, req.params.caseId)
    });
    if (!found)
      throw new HttpError(404, "Case not found.");
    await requireAnyRole(
      req.auth.userId,
      found.labOrganizationId,
      BILLING_ROLES
    );
    const restorations = await db.query.caseRestorations.findMany({
      where: eq6(caseRestorations.caseId, found.id)
    });
    if (!restorations.length)
      throw new HttpError(
        400,
        "Cannot generate an invoice with no restorations."
      );
    const [invoice] = await db.insert(invoices).values({
      invoiceNumber: nextInvoiceNumber(found.caseNumber),
      caseId: found.id,
      labOrganizationId: found.labOrganizationId,
      providerOrganizationId: found.providerOrganizationId,
      status: "draft",
      createdByUserId: req.auth.userId,
      updatedByUserId: req.auth.userId
    }).onConflictDoNothing().returning();
    const targetInvoice = invoice ?? await db.query.invoices.findFirst({
      where: eq6(
        invoices.invoiceNumber,
        nextInvoiceNumber(found.caseNumber)
      )
    });
    if (!targetInvoice)
      throw new HttpError(500, "Invoice could not be generated.");
    if (invoice) {
      const itemsToInsert = restorations.map((restoration, index2) => ({
        invoiceId: targetInvoice.id,
        caseRestorationId: restoration.id,
        description: `${restoration.restorationType} - Tooth ${restoration.toothNumber}`,
        quantity: restoration.quantity,
        unitPrice: restoration.unitPrice,
        lineTotal: calculateLineTotal(
          restoration.quantity,
          restoration.unitPrice
        ),
        sortOrder: index2
      }));
      await db.insert(invoiceLineItems).values(itemsToInsert);
    }
    const items = await db.query.invoiceLineItems.findMany({
      where: eq6(invoiceLineItems.invoiceId, targetInvoice.id),
      orderBy: [invoiceLineItems.sortOrder]
    });
    const subtotal = sumMoney(items.map((item) => item.lineTotal));
    const [updatedInvoice] = await db.update(invoices).set({
      subtotal,
      total: subtotal,
      balanceDue: subtotal,
      updatedByUserId: req.auth.userId,
      issuedAt: /* @__PURE__ */ new Date(),
      status: "open"
    }).where(eq6(invoices.id, targetInvoice.id)).returning();
    const user = req.user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "invoice_generated",
      actorUserId: req.auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        invoiceId: updatedInvoice.id,
        invoiceNumber: updatedInvoice.invoiceNumber
      }
    });
    return ok(res, updatedInvoice, invoice ? 201 : 200);
  })
);
router4.get(
  "/",
  asyncHandler(async (req, res) => {
    const memberships = await db.query.organizationMemberships.findMany({
      where: eq6(
        organizationMemberships.userId,
        req.auth.userId
      )
    });
    const orgIds = memberships.filter((m) => m.status === "active").map((m) => m.labId);
    const rows = orgIds.length ? await db.query.invoices.findMany({
      where: or2(
        ...orgIds.flatMap((orgId) => [
          eq6(invoices.labOrganizationId, orgId),
          eq6(invoices.providerOrganizationId, orgId)
        ])
      ),
      orderBy: [desc2(invoices.createdAt)]
    }) : [];
    return ok(res, rows);
  })
);
router4.get(
  "/:invoiceId",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq6(invoices.id, req.params.invoiceId)
    });
    if (!invoice)
      throw new HttpError(404, "Invoice not found.");
    const labMember = await requireMembership(
      req.auth.userId,
      invoice.labOrganizationId
    ).catch(() => null);
    const providerMember = await requireMembership(
      req.auth.userId,
      invoice.providerOrganizationId
    ).catch(() => null);
    if (!labMember && !providerMember)
      throw new HttpError(403, "You do not have access to this invoice.");
    const items = await db.query.invoiceLineItems.findMany({
      where: eq6(invoiceLineItems.invoiceId, invoice.id),
      orderBy: [invoiceLineItems.sortOrder]
    });
    const paymentRows = await db.query.payments.findMany({
      where: eq6(payments.invoiceId, invoice.id),
      orderBy: [desc2(payments.paidAt)]
    });
    return ok(res, { ...invoice, items, payments: paymentRows });
  })
);
router4.patch(
  "/:invoiceId",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq6(invoices.id, req.params.invoiceId)
    });
    if (!invoice)
      throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      req.auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES
    );
    const input = z4.object({
      status: z4.enum(["draft", "open", "partially_paid", "paid", "void"]).optional(),
      tax: z4.coerce.number().min(0).optional(),
      discount: z4.coerce.number().min(0).optional(),
      dueAt: z4.string().datetime().optional()
    }).parse(req.body);
    const items = await db.query.invoiceLineItems.findMany({
      where: eq6(invoiceLineItems.invoiceId, invoice.id)
    });
    const subtotal = sumMoney(items.map((item) => item.lineTotal));
    const tax = input.tax !== void 0 ? input.tax.toFixed(2) : invoice.tax;
    const discount = input.discount !== void 0 ? input.discount.toFixed(2) : invoice.discount;
    const total = (Number(subtotal) + Number(tax) - Number(discount)).toFixed(2);
    const paidSum = await db.select({ value: sum(payments.amount) }).from(payments).where(eq6(payments.invoiceId, invoice.id));
    const paid = Number(paidSum[0]?.value ?? 0);
    const balanceDue = (Number(total) - paid).toFixed(2);
    const [updated] = await db.update(invoices).set({
      status: input.status ?? invoice.status,
      tax,
      discount,
      total,
      balanceDue,
      dueAt: input.dueAt ? new Date(input.dueAt) : invoice.dueAt,
      updatedByUserId: req.auth.userId
    }).where(eq6(invoices.id, invoice.id)).returning();
    await writeAuditLog({
      req,
      organizationId: invoice.labOrganizationId,
      action: "invoice_updated",
      entityType: "invoice",
      entityId: invoice.id,
      beforeJson: invoice,
      afterJson: updated
    });
    return ok(res, updated);
  })
);
router4.post(
  "/:invoiceId/payments",
  asyncHandler(async (req, res) => {
    const invoice = await db.query.invoices.findFirst({
      where: eq6(invoices.id, req.params.invoiceId)
    });
    if (!invoice)
      throw new HttpError(404, "Invoice not found.");
    await requireAnyRole(
      req.auth.userId,
      invoice.labOrganizationId,
      BILLING_ROLES
    );
    const input = z4.object({
      amount: z4.coerce.number().positive(),
      paymentMethod: z4.enum(["card", "ach", "check", "cash", "other"]),
      referenceNumber: z4.string().optional()
    }).parse(req.body);
    const [payment] = await db.insert(payments).values({
      invoiceId: invoice.id,
      amount: input.amount.toFixed(2),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber ?? null,
      recordedByUserId: req.auth.userId
    }).returning();
    const paidRows = await db.select({ value: sum(payments.amount) }).from(payments).where(eq6(payments.invoiceId, invoice.id));
    const paid = Number(paidRows[0]?.value ?? 0);
    const balanceDue = Math.max(
      Number(invoice.total) - paid,
      0
    ).toFixed(2);
    const status = balanceDue === "0.00" ? "paid" : paid > 0 ? "partially_paid" : invoice.status;
    const [updatedInvoice] = await db.update(invoices).set({
      balanceDue,
      status,
      updatedByUserId: req.auth.userId
    }).where(eq6(invoices.id, invoice.id)).returning();
    if (invoice.caseId) {
      const user = req.user;
      await db.insert(caseEvents).values({
        caseId: invoice.caseId,
        eventType: "payment_received",
        actorUserId: req.auth.userId,
        actorOrganizationId: invoice.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          invoiceId: invoice.id,
          paymentId: payment.id,
          amount: payment.amount
        }
      });
    }
    return ok(res, { payment, invoice: updatedInvoice }, 201);
  })
);
router4.get(
  "/reports/sales",
  asyncHandler(async (req, res) => {
    const query = z4.object({
      organizationId: z4.string(),
      dateFrom: z4.string().optional(),
      dateTo: z4.string().optional()
    }).parse(req.query);
    await requireAnyRole(
      req.auth.userId,
      query.organizationId,
      BILLING_ROLES
    );
    const rows = await db.query.invoices.findMany({
      where: and6(
        eq6(invoices.labOrganizationId, query.organizationId),
        query.dateFrom ? gte(invoices.createdAt, new Date(query.dateFrom)) : void 0,
        query.dateTo ? lte(invoices.createdAt, new Date(query.dateTo)) : void 0
      )
    });
    const totalSales = rows.reduce((acc, row) => acc + Number(row.total), 0).toFixed(2);
    const openBalance = rows.reduce((acc, row) => acc + Number(row.balanceDue), 0).toFixed(2);
    return ok(res, {
      totalSales,
      openBalance,
      invoices: rows.length,
      paidInvoices: rows.filter((row) => row.status === "paid").length,
      openInvoices: rows.filter(
        (row) => row.status !== "paid" && row.status !== "void"
      ).length
    });
  })
);
var invoices_default = router4;

// server/routes.ts
var verificationCodes = /* @__PURE__ */ new Map();
var passwordResetTokens = /* @__PURE__ */ new Map();
var DEMO_SEED_USERS_ENABLED = process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true";
var cachedOpenAIClient;
function getOpenAIClient() {
  if (cachedOpenAIClient !== void 0) {
    return cachedOpenAIClient;
  }
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    cachedOpenAIClient = null;
    return null;
  }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  cachedOpenAIClient = new OpenAI({
    apiKey,
    ...baseURL ? { baseURL } : {}
  });
  return cachedOpenAIClient;
}
function generateCode() {
  return Math.floor(1e5 + Math.random() * 9e5).toString();
}
function generateResetToken() {
  return randomBytes(32).toString("hex");
}
function normalizeLegacyCaseAffiliationName(name) {
  return name?.trim().toLowerCase() || "";
}
function buildLegacyPrivateAffiliationKey(userId) {
  return userId ? `private:${userId}` : null;
}
function buildLegacyOrganizationAffiliationKey(organizationId) {
  return organizationId ? `org:${organizationId}` : null;
}
function buildLegacyLabAffiliationKey(name) {
  const normalizedName = normalizeLegacyCaseAffiliationName(name);
  return normalizedName ? `lab:${normalizedName}` : null;
}
function resolveLegacyCaseAffiliationKeys(labCase) {
  const keys = /* @__PURE__ */ new Set();
  if (typeof labCase?.affiliationKey === "string" && labCase.affiliationKey.trim()) {
    keys.add(labCase.affiliationKey.trim());
  }
  const legacyLabAffiliationKey = buildLegacyLabAffiliationKey(
    typeof labCase?.affiliationName === "string" ? labCase.affiliationName : null
  );
  if (legacyLabAffiliationKey) {
    keys.add(legacyLabAffiliationKey);
  }
  if (keys.size === 0) {
    const privateAffiliationKey = buildLegacyPrivateAffiliationKey(
      typeof labCase?.ownerId === "string" ? labCase.ownerId : null
    );
    if (privateAffiliationKey) {
      keys.add(privateAffiliationKey);
    }
  }
  return Array.from(keys);
}
var legacyChatStorePath = path.join(
  process.cwd(),
  "server",
  ".data",
  "legacy-chat.json"
);
function normalizeUsernameKey(username) {
  return username?.trim().toLowerCase() || "";
}
function buildDirectConversationId(usernameA, usernameB) {
  const normalizedUsers = [usernameA, usernameB].map((value) => normalizeUsernameKey(value)).filter(Boolean).sort();
  if (normalizedUsers.length < 2) {
    return null;
  }
  return `dm:${normalizedUsers.join("::")}`;
}
async function readLegacyChatStore() {
  try {
    const raw = await readFile(legacyChatStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      threads: Array.isArray(parsed?.threads) ? parsed.threads : [],
      messages: Array.isArray(parsed?.messages) ? parsed.messages : []
    };
  } catch {
    return { threads: [], messages: [] };
  }
}
async function writeLegacyChatStore(store) {
  await mkdir(path.dirname(legacyChatStorePath), { recursive: true });
  await writeFile(legacyChatStorePath, JSON.stringify(store, null, 2), "utf8");
}
var DEFAULT_USERS = [
  { username: "labadmin_demo", password: "LabTraxDemo#2026", userType: "lab", role: "admin", email: "labadmin_demo@labtrax.local", accountNumber: "LAB-001" },
  { username: "labtech_demo", password: "LabTraxDemo#2026", userType: "lab", role: "user", email: "labtech_demo@labtrax.local", accountNumber: "LAB-002" },
  { username: "master_demo", password: "LabTraxDemo#2026", userType: "master_admin", role: "admin", email: "master_demo@labtrax.local", accountNumber: "MA-001" }
];
async function seedDefaultUsers() {
  if (!DEMO_SEED_USERS_ENABLED) {
    return;
  }
  const existingUsers = await db.select().from(users);
  const existingUsernames = new Set(existingUsers.map((user) => user.username.toLowerCase()));
  for (const def of DEFAULT_USERS) {
    if (existingUsernames.has(def.username.toLowerCase())) {
      continue;
    }
    const hashed = await hashPassword(def.password);
    await db.insert(users).values({
      username: def.username,
      password: hashed,
      email: def.email || null,
      phone: def.phone || null,
      userType: def.userType,
      role: def.role,
      accountNumber: def.accountNumber || null,
      initials: def.username.slice(0, 2).toUpperCase()
    });
    existingUsernames.add(def.username.toLowerCase());
    console.log(`[SEED] Created demo user: ${def.username}`);
  }
}
var casMediaDir = path.resolve(process.cwd(), "uploads", "case-media");
var caseMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(casMediaDir, { recursive: true });
    cb(null, casMediaDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".bin";
    const safeBase = path.basename(file.originalname || "media", ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "media";
    cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeBase}${ext}`);
  }
});
var caseMediaUpload = multer({
  storage: caseMediaStorage,
  limits: { fileSize: 200 * 1024 * 1024 }
});
async function registerRoutes(app2) {
  await seedDefaultUsers();
  fs.mkdirSync(casMediaDir, { recursive: true });
  app2.use("/uploads/case-media", express.static(casMediaDir));
  app2.post("/api/media/upload", requireAuth, caseMediaUpload.single("file"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const forwardedHost = req.header("x-forwarded-host");
      const host = forwardedHost || req.get("host") || "localhost";
      const forwardedProto = req.header("x-forwarded-proto");
      const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol || "https";
      const url = `${protocol}://${host}/uploads/case-media/${req.file.filename}`;
      return res.json({ url, filename: req.file.filename, size: req.file.size });
    } catch (error) {
      console.error("Media upload error:", error?.message || error);
      return res.status(500).json({ error: "Upload failed" });
    }
  });
  async function getRepairableLabDirectoryData() {
    const allUsers = await db.select().from(users);
    const labAdmins = allUsers.filter(
      (user) => user.userType === "lab" && user.role === "admin" && !!user.practiceName?.trim()
    );
    const labOrganizations = await db.select().from(organizations).where(eq7(organizations.type, "lab"));
    const allLabMemberships = labOrganizations.length ? await db.select().from(organizationMemberships).where(
      inArray4(
        organizationMemberships.labId,
        labOrganizations.map((organization) => organization.id)
      )
    ) : [];
    const activeMemberships = labOrganizations.length ? await db.select().from(organizationMemberships).where(
      and7(
        inArray4(
          organizationMemberships.labId,
          labOrganizations.map((organization) => organization.id)
        ),
        eq7(organizationMemberships.status, "active")
      )
    ) : [];
    const activeLabMemberIds = new Set(
      activeMemberships.map((membership) => membership.userId)
    );
    const anyLabMemberIds = new Set(
      allLabMemberships.map((membership) => membership.userId)
    );
    for (const adminUser of labAdmins) {
      if (!adminUser.id || activeLabMemberIds.has(adminUser.id) || anyLabMemberIds.has(adminUser.id)) {
        continue;
      }
      const normalizedPracticeName = adminUser.practiceName.trim().toLowerCase();
      let organization = labOrganizations.find(
        (entry) => entry.createdByUserId === adminUser.id && (entry.displayName || entry.name).toLowerCase().trim() === normalizedPracticeName
      ) || labOrganizations.find(
        (entry) => (entry.displayName || entry.name).toLowerCase().trim() === normalizedPracticeName
      );
      if (!organization) {
        const [createdOrganization] = await db.insert(organizations).values({
          type: "lab",
          name: adminUser.practiceName.trim(),
          displayName: adminUser.practiceName.trim(),
          billingEmail: adminUser.email || null,
          phone: adminUser.practicePhone || adminUser.phone || null,
          addressLine1: adminUser.practiceAddress || null,
          createdByUserId: adminUser.id
        }).returning();
        organization = createdOrganization;
        labOrganizations.push(createdOrganization);
      }
      const hasActiveMembership = activeMemberships.some(
        (membership) => membership.labId === organization.id && membership.userId === adminUser.id && membership.status === "active"
      );
      if (!hasActiveMembership) {
        const [createdMembership] = await db.insert(organizationMemberships).values({
          labId: organization.id,
          userId: adminUser.id,
          role: "owner",
          status: "active",
          approvedByUserId: adminUser.id,
          joinedAt: /* @__PURE__ */ new Date()
        }).returning();
        activeMemberships.push(createdMembership);
      }
      activeLabMemberIds.add(adminUser.id);
    }
    return {
      allUsers,
      labOrganizations,
      activeMemberships
    };
  }
  app2.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  });
  app2.get("/api/labs/groups", async (_req, res) => {
    try {
      const { allUsers, labOrganizations, activeMemberships } = await getRepairableLabDirectoryData();
      const memberUserIds = [
        ...new Set(activeMemberships.map((membership) => membership.userId))
      ];
      const memberUsers = allUsers.filter((user) => memberUserIds.includes(user.id));
      const userMap = new Map(memberUsers.map((u) => [u.id, u]));
      const groups = labOrganizations.map((organization) => {
        const organizationMembershipsForGroup = activeMemberships.filter(
          (membership) => membership.labId === organization.id
        );
        const adminMembership = organizationMembershipsForGroup.find(
          (membership) => membership.role === "owner" || membership.role === "admin"
        );
        const createdByUser = organization.createdByUserId ? userMap.get(organization.createdByUserId) : void 0;
        const adminUser = adminMembership ? userMap.get(adminMembership.userId) : createdByUser;
        if (!adminUser?.username) {
          return null;
        }
        return {
          organizationId: organization.id,
          practiceName: organization.displayName || organization.name,
          username: adminUser.username,
          practiceAddress: [
            organization.addressLine1,
            organization.city,
            organization.state,
            organization.zip
          ].filter(Boolean).join(", "),
          memberCount: organizationMembershipsForGroup.length
        };
      }).filter(Boolean);
      res.json({ groups });
    } catch (error) {
      console.error("List lab groups error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch lab groups" });
    }
  });
  app2.use("/api/auth", auth_default);
  app2.use("/api/organizations", organizations_default);
  app2.use("/api/cases", cases_default);
  app2.use("/api/invoices", invoices_default);
  app2.post("/api/audit-log", (_req, res) => {
    res.json({ ok: true });
  });
  app2.post("/api/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const allUsers = await db.select().from(users);
    const existing = allUsers.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
    res.json({ available: !existing });
  });
  app2.post("/api/legacy/cases", requireAuth, async (req, res) => {
    try {
      const { id, ownerId, caseData } = req.body;
      if (!id || !ownerId || !caseData) {
        return res.status(400).json({ error: "id, ownerId, and caseData are required" });
      }
      const [existingCaseRow] = await db.select().from(labCases).where(eq7(labCases.id, id));
      let normalizedCaseData;
      try {
        normalizedCaseData = typeof caseData === "string" ? JSON.parse(caseData) : caseData;
      } catch {
        normalizedCaseData = null;
      }
      if (!normalizedCaseData || typeof normalizedCaseData !== "object") {
        normalizedCaseData = { id, ownerId };
      }
      if (!normalizedCaseData.id) {
        normalizedCaseData.id = id;
      }
      if (!normalizedCaseData.ownerId) {
        normalizedCaseData.ownerId = ownerId;
      }
      if (existingCaseRow?.caseData) {
        try {
          const existingCaseData = JSON.parse(existingCaseRow.caseData);
          if (!normalizedCaseData.affiliationKey && existingCaseData?.affiliationKey) {
            normalizedCaseData.affiliationKey = existingCaseData.affiliationKey;
          }
          if ((normalizedCaseData.affiliationName === void 0 || normalizedCaseData.affiliationName === null || normalizedCaseData.affiliationName === "") && existingCaseData?.affiliationName) {
            normalizedCaseData.affiliationName = existingCaseData.affiliationName;
          }
        } catch {
        }
      }
      const serializedCaseData = JSON.stringify(normalizedCaseData);
      await db.insert(labCases).values({
        id,
        ownerId: normalizedCaseData.ownerId || ownerId,
        caseData: serializedCaseData,
        updatedAt: /* @__PURE__ */ new Date()
      }).onConflictDoUpdate({
        target: labCases.id,
        set: {
          ownerId: normalizedCaseData.ownerId || ownerId,
          caseData: serializedCaseData,
          updatedAt: /* @__PURE__ */ new Date()
        }
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Legacy upsert case error:", error?.message || error);
      res.status(500).json({ error: "Failed to save case" });
    }
  });
  app2.get("/api/legacy/cases", requireAuth, async (req, res) => {
    try {
      const scopeKeysParam = typeof req.query.scopeKeys === "string" ? req.query.scopeKeys : "";
      const viewerUserId = typeof req.query.viewerUserId === "string" ? req.query.viewerUserId : "";
      if (scopeKeysParam) {
        const requestedScopeKeys = new Set(
          scopeKeysParam.split(",").map((value) => value.trim()).filter(Boolean)
        );
        if (!viewerUserId || requestedScopeKeys.size === 0) {
          return res.json({ cases: [] });
        }
        const rows2 = await db.select().from(labCases);
        const parsedRows = rows2.map((row) => {
          try {
            const parsedCase = JSON.parse(row.caseData);
            if (!parsedCase || typeof parsedCase !== "object") {
              return null;
            }
            return {
              row,
              caseData: {
                ...parsedCase,
                ownerId: typeof parsedCase.ownerId === "string" ? parsedCase.ownerId : row.ownerId
              }
            };
          } catch {
            return null;
          }
        }).filter(Boolean);
        const ownerIds2 = [
          ...new Set(
            parsedRows.map((entry) => entry.caseData.ownerId).filter((value) => !!value)
          )
        ];
        const activeMembershipRows = ownerIds2.length ? await db.select().from(organizationMemberships).where(
          and7(
            inArray4(organizationMemberships.userId, ownerIds2),
            eq7(organizationMemberships.status, "active")
          )
        ) : [];
        const organizationIds = [
          ...new Set(
            activeMembershipRows.map((membership) => membership.labId).filter(Boolean)
          )
        ];
        const organizationRows = organizationIds.length ? await db.select().from(organizations).where(inArray4(organizations.id, organizationIds)) : [];
        const membershipsByUserId = /* @__PURE__ */ new Map();
        for (const membership of activeMembershipRows) {
          const currentMemberships = membershipsByUserId.get(membership.userId) ?? [];
          currentMemberships.push(membership);
          membershipsByUserId.set(membership.userId, currentMemberships);
        }
        const organizationsById = new Map(
          organizationRows.map((organization) => [organization.id, organization])
        );
        const repairedRows = /* @__PURE__ */ new Map();
        const visibleCases = parsedRows.map(({ row, caseData }) => {
          const ownerUserId = typeof caseData.ownerId === "string" ? caseData.ownerId : row.ownerId;
          if (!ownerUserId) {
            return null;
          }
          let resolvedCase = { ...caseData, ownerId: ownerUserId };
          const affiliationKeyIsPrivate = typeof resolvedCase.affiliationKey === "string" && resolvedCase.affiliationKey.startsWith("private:");
          const hasExplicitLabAffiliation = !!resolvedCase.affiliationName || !!resolvedCase.affiliationKey && !affiliationKeyIsPrivate;
          if (!hasExplicitLabAffiliation) {
            const ownerMemberships = membershipsByUserId.get(ownerUserId) ?? [];
            for (const membership of ownerMemberships) {
              const organization = organizationsById.get(membership.labId);
              if (!organization || organization.type !== "lab") {
                continue;
              }
              const organizationAffiliationKey = buildLegacyOrganizationAffiliationKey(membership.labId);
              const legacyLabAffiliationKey = buildLegacyLabAffiliationKey(
                organization.displayName || organization.name || null
              );
              if (!requestedScopeKeys.has(organizationAffiliationKey || "") && !(legacyLabAffiliationKey && requestedScopeKeys.has(legacyLabAffiliationKey))) {
                continue;
              }
              resolvedCase = {
                ...resolvedCase,
                affiliationKey: organizationAffiliationKey,
                affiliationName: organization.displayName || organization.name || null
              };
              repairedRows.set(row.id, {
                ownerId: ownerUserId,
                caseData: JSON.stringify(resolvedCase)
              });
              break;
            }
          }
          const caseAffiliationKeys = resolveLegacyCaseAffiliationKeys(resolvedCase);
          const isVisible = caseAffiliationKeys.some(
            (key) => requestedScopeKeys.has(key)
          );
          return isVisible ? resolvedCase : null;
        }).filter(Boolean).sort(
          (a, b) => (Number(b.updatedAt) || Number(b.createdAt) || 0) - (Number(a.updatedAt) || Number(a.createdAt) || 0)
        );
        for (const [caseId, repaired] of repairedRows.entries()) {
          await db.insert(labCases).values({
            id: caseId,
            ownerId: repaired.ownerId,
            caseData: repaired.caseData,
            updatedAt: /* @__PURE__ */ new Date()
          }).onConflictDoUpdate({
            target: labCases.id,
            set: {
              ownerId: repaired.ownerId,
              caseData: repaired.caseData,
              updatedAt: /* @__PURE__ */ new Date()
            }
          });
        }
        return res.json({ cases: visibleCases });
      }
      const ownerIdsParam = req.query.ownerIds;
      if (!ownerIdsParam) {
        return res.json({ cases: [] });
      }
      const ownerIds = ownerIdsParam.split(",").filter(Boolean);
      if (ownerIds.length === 0)
        return res.json({ cases: [] });
      const rows = await db.select().from(labCases).where(inArray4(labCases.ownerId, ownerIds));
      const cases2 = rows.map((r) => {
        try {
          return JSON.parse(r.caseData);
        } catch {
          return null;
        }
      }).filter(Boolean);
      res.json({ cases: cases2 });
    } catch (error) {
      console.error("Legacy get cases error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch cases" });
    }
  });
  app2.delete("/api/legacy/cases/:caseId", requireAuth, async (req, res) => {
    try {
      const caseId = req.params.caseId;
      await db.delete(labCases).where(eq7(labCases.id, caseId));
      res.json({ success: true });
    } catch (error) {
      console.error("Legacy delete case error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete case" });
    }
  });
  app2.get("/api/legacy/chat", requireAuth, async (req, res) => {
    try {
      const currentUserId = req.auth?.userId;
      const currentUsername = req.user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      if (!normalizedCurrentUsername) {
        return res.json({ conversations: [], messages: [] });
      }
      const store = await readLegacyChatStore();
      const dmThreads = store.threads.filter(
        (thread) => thread.participants.some(
          (participant) => normalizeUsernameKey(participant) === normalizedCurrentUsername
        )
      );
      const activeLabMemberships = currentUserId ? await db.query.organizationMemberships.findMany({
        where: and7(
          eq7(organizationMemberships.userId, currentUserId),
          eq7(organizationMemberships.status, "active")
        ),
        with: { organization: true }
      }) : [];
      const labChannelThreads = [];
      const labChannelMeta = /* @__PURE__ */ new Map();
      for (const membership of activeLabMemberships) {
        const channelId = `lab:${membership.labId}`;
        const orgRecord = await db.query.organizations.findFirst({
          where: eq7(organizations.id, membership.labId)
        });
        const orgName = orgRecord?.displayName || orgRecord?.name || "Lab";
        labChannelMeta.set(channelId, `${orgName} Channel`);
        const existing = store.threads.find((t) => t.id === channelId);
        if (existing) {
          if (!dmThreads.find((t) => t.id === channelId)) {
            labChannelThreads.push(existing);
          }
        } else {
          labChannelThreads.push({
            id: channelId,
            participants: [currentUsername],
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }
      }
      const relevantThreads = [...dmThreads, ...labChannelThreads];
      const relevantConversationIds = new Set(relevantThreads.map((thread) => thread.id));
      const relevantMessages = store.messages.filter(
        (message) => relevantConversationIds.has(message.conversationId)
      );
      const conversations2 = relevantThreads.map((thread) => {
        const isLabChannel = thread.id.startsWith("lab:");
        const channelName = isLabChannel ? labChannelMeta.get(thread.id) || "Lab Channel" : thread.participants.find(
          (participant) => normalizeUsernameKey(participant) !== normalizedCurrentUsername
        ) || "Unknown User";
        const threadMessages = relevantMessages.filter((message) => message.conversationId === thread.id).sort((a, b) => a.timestamp - b.timestamp);
        const lastMessage = threadMessages[threadMessages.length - 1];
        const unreadCount = threadMessages.filter(
          (message) => normalizeUsernameKey(message.senderUsername) !== normalizedCurrentUsername && !message.readBy.includes(normalizedCurrentUsername)
        ).length;
        return {
          id: thread.id,
          clientId: thread.id,
          clientName: channelName,
          isLabChannel,
          lastMessage: lastMessage ? lastMessage.imageUri ? "Photo" : lastMessage.content : "",
          lastMessageTime: lastMessage?.timestamp || thread.updatedAt || thread.createdAt,
          unreadCount
        };
      }).sort((a, b) => {
        if (a.isLabChannel && !b.isLabChannel)
          return -1;
        if (!a.isLabChannel && b.isLabChannel)
          return 1;
        return b.lastMessageTime - a.lastMessageTime;
      });
      const messages2 = relevantMessages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderUsername,
        senderType: normalizeUsernameKey(message.senderUsername) === normalizedCurrentUsername ? "lab" : "office",
        content: message.content,
        imageUri: message.imageUri,
        timestamp: message.timestamp,
        read: message.readBy.includes(normalizedCurrentUsername)
      })).sort((a, b) => a.timestamp - b.timestamp);
      res.json({ conversations: conversations2, messages: messages2 });
    } catch (error) {
      console.error("Legacy get chat error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });
  app2.post("/api/legacy/chat/send", requireAuth, async (req, res) => {
    try {
      const currentUserId = req.auth?.userId;
      const currentUsername = req.user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      const labChannelId = typeof req.body?.labChannelId === "string" ? req.body.labChannelId.trim() : "";
      const targetUsername = typeof req.body?.targetUsername === "string" ? req.body.targetUsername.trim() : "";
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      const imageUri = typeof req.body?.imageUri === "string" ? req.body.imageUri.trim() : void 0;
      if (!normalizedCurrentUsername) {
        return res.status(401).json({ error: "Not authenticated." });
      }
      if (!content && !imageUri) {
        return res.status(400).json({ error: "A message or image is required." });
      }
      const store = await readLegacyChatStore();
      const now = Date.now();
      if (labChannelId && labChannelId.startsWith("lab:")) {
        const orgId = labChannelId.replace(/^lab:/, "");
        const membership = currentUserId ? await db.query.organizationMemberships.findFirst({
          where: and7(
            eq7(organizationMemberships.userId, currentUserId),
            eq7(organizationMemberships.labId, orgId),
            eq7(organizationMemberships.status, "active")
          )
        }) : null;
        if (!membership) {
          return res.status(403).json({ error: "You are not a member of this lab." });
        }
        const allOrgMembers = await db.query.organizationMemberships.findMany({
          where: and7(
            eq7(organizationMemberships.labId, orgId),
            eq7(organizationMemberships.status, "active")
          )
        });
        const memberIds = allOrgMembers.map((m) => m.userId);
        const memberUsers = memberIds.length > 0 ? await db.select().from(users).where(inArray4(users.id, memberIds)) : [];
        const participants2 = memberUsers.map((u) => u.username);
        const existingThread2 = store.threads.find((t) => t.id === labChannelId);
        if (existingThread2) {
          existingThread2.participants = participants2;
          existingThread2.updatedAt = now;
        } else {
          store.threads.push({ id: labChannelId, participants: participants2, createdAt: now, updatedAt: now });
        }
        const message2 = {
          id: randomBytes(16).toString("hex"),
          conversationId: labChannelId,
          senderUsername: currentUsername,
          content,
          ...imageUri ? { imageUri } : {},
          timestamp: now,
          readBy: [normalizedCurrentUsername]
        };
        store.messages.push(message2);
        await writeLegacyChatStore(store);
        return res.json({ success: true, conversationId: labChannelId, messageId: message2.id });
      }
      if (!targetUsername) {
        return res.status(400).json({ error: "A target user or lab channel is required." });
      }
      if (normalizeUsernameKey(targetUsername) === normalizedCurrentUsername) {
        return res.status(400).json({ error: "You cannot message yourself." });
      }
      const allUsers = await db.select().from(users);
      const targetUser = allUsers.find(
        (user) => normalizeUsernameKey(user.username) === normalizeUsernameKey(targetUsername)
      );
      if (!targetUser?.username) {
        return res.status(404).json({ error: "Target user not found." });
      }
      const conversationId = buildDirectConversationId(currentUsername, targetUser.username) || buildDirectConversationId(currentUsername, targetUsername);
      if (!conversationId) {
        return res.status(400).json({ error: "Could not create a conversation." });
      }
      const existingThread = store.threads.find((thread) => thread.id === conversationId);
      const participants = [currentUsername, targetUser.username].filter(
        (value, index2, values) => values.indexOf(value) === index2
      );
      if (existingThread) {
        existingThread.participants = participants;
        existingThread.updatedAt = now;
      } else {
        store.threads.push({ id: conversationId, participants, createdAt: now, updatedAt: now });
      }
      const message = {
        id: randomBytes(16).toString("hex"),
        conversationId,
        senderUsername: currentUsername,
        content,
        ...imageUri ? { imageUri } : {},
        timestamp: now,
        readBy: [normalizedCurrentUsername]
      };
      store.messages.push(message);
      await writeLegacyChatStore(store);
      res.json({ success: true, conversationId, messageId: message.id });
    } catch (error) {
      console.error("Legacy send chat error:", error?.message || error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });
  app2.post("/api/legacy/chat/read", requireAuth, async (req, res) => {
    try {
      const currentUsername = req.user?.username;
      const normalizedCurrentUsername = normalizeUsernameKey(currentUsername);
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
      if (!normalizedCurrentUsername || !conversationId) {
        return res.status(400).json({ error: "A conversation id is required." });
      }
      const store = await readLegacyChatStore();
      const thread = store.threads.find((entry) => entry.id === conversationId);
      const isParticipant = thread?.participants.some(
        (participant) => normalizeUsernameKey(participant) === normalizedCurrentUsername
      );
      if (!thread || !isParticipant) {
        return res.status(404).json({ error: "Conversation not found." });
      }
      let changed = false;
      for (const message of store.messages) {
        if (message.conversationId === conversationId && normalizeUsernameKey(message.senderUsername) !== normalizedCurrentUsername && !message.readBy.includes(normalizedCurrentUsername)) {
          message.readBy.push(normalizedCurrentUsername);
          changed = true;
        }
      }
      if (changed) {
        await writeLegacyChatStore(store);
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Legacy read chat error:", error?.message || error);
      res.status(500).json({ error: "Failed to update message read status" });
    }
  });
  app2.post("/api/send-phone-code", async (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }
    const code = generateCode();
    const key = `phone:${phone.trim()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1e3 });
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    if (twilioSid && twilioToken && twilioFrom) {
      try {
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
        const params = new URLSearchParams();
        params.append("To", phone.trim());
        params.append("From", twilioFrom);
        params.append("Body", `Your LabTrax verification code is: ${code}. It expires in 10 minutes.`);
        const twilioResp = await globalThis.fetch(twilioUrl, {
          method: "POST",
          headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString()
        });
        const twilioData = await twilioResp.json();
        if (twilioData.error_code) {
          console.error(`[SMS VERIFICATION] Twilio error: ${twilioData.message}`);
          return res.status(500).json({ error: "Failed to send verification code. Please try again." });
        }
      } catch (err) {
        console.error(`[SMS VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code. Please try again." });
      }
    } else {
      console.log(`[SMS VERIFICATION] Twilio not configured. Dev mode only \u2014 code masked for security.`);
    }
    const isDev = process.env.NODE_ENV === "development";
    res.json({ success: true, message: "Verification code sent via SMS.", ...isDev && (!twilioSid || !twilioToken || !twilioFrom) ? { demoCode: code } : {} });
  });
  app2.post("/api/verify-phone-code", (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code)
      return res.status(400).json({ error: "Phone and code required" });
    const key = `phone:${phone.trim()}`;
    const stored = verificationCodes.get(key);
    if (!stored)
      return res.json({ verified: false, error: "No code sent. Please request a new one." });
    if (Date.now() > stored.expiresAt) {
      verificationCodes.delete(key);
      return res.json({ verified: false, error: "Code expired." });
    }
    if (stored.code !== code.trim())
      return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    res.json({ verified: true });
  });
  app2.post("/api/send-email-code", async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string")
      return res.status(400).json({ error: "Email required" });
    const code = generateCode();
    const key = `email:${email.trim().toLowerCase()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1e3 });
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpPort = process.env.SMTP_PORT;
    const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";
    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465",
          auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: email.trim(),
          subject: "LabTrax - Email Verification Code",
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">LabTrax</h2>
              <p style="margin: 4px 0 0; opacity: 0.85;">Email Verification</p>
            </div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Your verification code is:</p>
              <p style="text-align: center; margin: 24px 0;">
                <span style="display: inline-block; background: #F0F4FF; padding: 16px 40px; border-radius: 8px; font-size: 28px; font-weight: bold; color: #4A6CF7; letter-spacing: 6px;">${code}</span>
              </p>
              <p style="color: #666; font-size: 13px;">This code expires in 10 minutes.</p>
            </div>
          </div>`
        });
      } catch (err) {
        console.error(`[EMAIL VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code." });
      }
    } else {
      console.log(`[EMAIL VERIFICATION] SMTP not configured. Dev mode only \u2014 code masked for security.`);
    }
    const isDev = process.env.NODE_ENV === "development";
    res.json({ success: true, message: "Verification code sent.", ...isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoCode: code } : {} });
  });
  app2.post("/api/verify-email-code", (req, res) => {
    const { email, code } = req.body;
    if (!email || !code)
      return res.status(400).json({ error: "Email and code required" });
    const key = `email:${email.trim().toLowerCase()}`;
    const stored = verificationCodes.get(key);
    if (!stored)
      return res.json({ verified: false, error: "No code sent." });
    if (Date.now() > stored.expiresAt) {
      verificationCodes.delete(key);
      return res.json({ verified: false, error: "Code expired." });
    }
    if (stored.code !== code.trim())
      return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    res.json({ verified: true });
  });
  app2.post("/api/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string")
        return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find((u) => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user)
        return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent." });
      const token = generateResetToken();
      passwordResetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1e3 });
      const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_INTERNAL_APP_DOMAIN || "localhost:5000";
      const protocol = domain.includes("localhost") ? "http" : "https";
      const resetLink = `${protocol}://${domain}/reset-password?token=${token}`;
      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";
      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465",
          auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: user.email,
          subject: "LabTrax - Password Reset",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Password Reset</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p><p>Click below to reset your password:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a></p>
              <p style="color: #666; font-size: 13px;">Expires in 30 minutes. Username: <strong>${user.username}</strong></p>
            </div></div>`
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Reset link generated for ${user.email} \u2014 token masked for security.`);
      }
      const isDev = process.env.NODE_ENV === "development";
      res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent.", ...isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoResetLink: resetLink } : {} });
    } catch (error) {
      console.error("Forgot password error:", error?.message || error);
      res.status(500).json({ error: "Failed to process request." });
    }
  });
  app2.post("/api/forgot-username", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string")
        return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find((u) => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user)
        return res.json({ success: true, message: "If an account with that email exists, your username has been sent." });
      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";
      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465",
          auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: user.email,
          subject: "LabTrax - Username Recovery",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Username Recovery</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Your username is: <strong>${user.username}</strong></p>
            </div></div>`
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Username reminder generated for ${user.email} \u2014 masked for security.`);
      }
      res.json({ success: true, message: "If an account with that email exists, your username has been sent." });
    } catch (error) {
      res.status(500).json({ error: "Failed to process request." });
    }
  });
  app2.post("/api/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword)
        return res.status(400).json({ error: "Token and new password are required." });
      const resetData = passwordResetTokens.get(token);
      if (!resetData)
        return res.status(400).json({ error: "Invalid or expired reset token." });
      if (Date.now() > resetData.expiresAt) {
        passwordResetTokens.delete(token);
        return res.status(400).json({ error: "Reset token has expired." });
      }
      const hashed = await hashPassword(newPassword);
      await db.update(users).set({ password: hashed }).where(eq7(users.id, resetData.userId));
      passwordResetTokens.delete(token);
      res.json({ success: true, message: "Password has been reset successfully." });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset password." });
    }
  });
  app2.post("/api/send-case-update-text", requireAuth, async (req, res) => {
    const { providerPhone, caseNumber, patientName, status, message } = req.body;
    if (!providerPhone || !caseNumber)
      return res.status(400).json({ error: "Provider phone and case number required" });
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioSid || !twilioToken || !twilioFrom)
      return res.status(500).json({ error: "Twilio not configured" });
    const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams();
    params.append("To", providerPhone);
    params.append("From", twilioFrom);
    params.append("Body", message);
    try {
      await globalThis.fetch(twilioUrl, {
        method: "POST",
        headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
      res.json({ success: true, message: `Text sent to ${providerPhone}` });
    } catch (err) {
      res.status(500).json({ error: "Failed to send text" });
    }
  });
  app2.post("/api/analyze-prescription", optionalAuth, async (req, res) => {
    try {
      let fixNameOrder2 = function(name) {
        if (!name || typeof name !== "string")
          return name;
        const commaIdx = name.indexOf(",");
        if (commaIdx === -1)
          return name;
        const prefix = name.match(/^(Dr\.|Dr|Mr\.|Mrs\.|Ms\.|Prof\.)\s*/i)?.[0] || "";
        const nameWithoutPrefix = name.slice(prefix.length);
        const commaIdxInner = nameWithoutPrefix.indexOf(",");
        if (commaIdxInner === -1)
          return name;
        const last = nameWithoutPrefix.slice(0, commaIdxInner).trim();
        const first = nameWithoutPrefix.slice(commaIdxInner + 1).trim();
        return `${prefix}${first} ${last}`.trim();
      };
      var fixNameOrder = fixNameOrder2;
      const openai = getOpenAIClient();
      if (!openai)
        return res.status(503).json({ success: false, error: "AI integrations are not configured." });
      const { imageBase64, additionalImages } = req.body;
      if (!imageBase64)
        return res.status(400).json({ success: false, error: "No image provided" });
      console.log("AI analyze-prescription: received, primary image length:", imageBase64.length, "additional pages:", Array.isArray(additionalImages) ? additionalImages.length : 0);
      const isHEIC = imageBase64.includes("data:image/heic") || imageBase64.includes("data:image/heif");
      if (isHEIC)
        return res.status(400).json({ success: false, error: "HEIC format is not supported. Please convert to JPEG or PNG first." });
      const imageContents = [];
      let primaryUrl = imageBase64;
      if (!primaryUrl.startsWith("data:")) {
        primaryUrl = `data:image/jpeg;base64,${primaryUrl}`;
      }
      imageContents.push({ type: "image_url", image_url: { url: primaryUrl, detail: "auto" } });
      if (additionalImages && Array.isArray(additionalImages)) {
        for (const img of additionalImages) {
          if (typeof img === "string" && img.length > 100) {
            let imgUrl = img;
            if (!imgUrl.startsWith("data:")) {
              imgUrl = `data:image/jpeg;base64,${imgUrl}`;
            }
            imageContents.push({ type: "image_url", image_url: { url: imgUrl, detail: "auto" } });
          }
        }
      }
      const systemPrompt = `You are a dental laboratory prescription reader. Analyze the dental prescription image(s) and extract all available information. Return ONLY valid JSON with these fields (use null for any field you cannot determine):

{
  "doctorName": "Dr. Full Name",
  "patientName": "Patient Full Name",
  "patientInitials": "PI",
  "caseType": "one of: Crown & Bridge, Removable, Implant, Orthodontic, Other",
  "toothIndices": "comma-separated tooth numbers like 3,5,14",
  "shade": "shade value like A2, B1, etc.",
  "material": "one of: Zirconia, E max, PFM, Gold, Composite, Acrylic, Flexible, PMMA, Metal Framework, Titanium, Other",
  "dueDate": "MM/DD/YYYY format",
  "isRush": false,
  "notes": "any additional notes or special instructions",
  "practiceName": "dental practice or office name",
  "practiceAddress": "practice address",
  "practicePhone": "practice phone number"
}

Important rules:
- Read ALL pages if multiple images are provided
- For tooth numbers, use Universal Numbering System (1-32)
- If you see FDI notation, convert to Universal
- Only set isRush to true if explicitly marked as rush/urgent
- For caseType, match to the closest category listed above
- Extract the shade exactly as written on the prescription
- NAME FORMAT: If a patient name or doctor name contains a comma (e.g. "Kidder, Daniel" or "Sharpstein, Daniel"), the prescription is using Last, First format. You MUST swap it to First Last order and remove the comma. Examples: "Kidder, Daniel" \u2192 "Daniel Kidder", "Dr. Sharpstein, Daniel" \u2192 "Dr. Daniel Sharpstein". Always output names in natural First Last order with no commas.
- Return ONLY the JSON object, no other text`;
      const userContent = [
        { type: "text", text: `Analyze this dental prescription (${imageContents.length} page${imageContents.length > 1 ? "s" : ""}).` },
        ...imageContents
      ];
      const response = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        max_completion_tokens: 1e3,
        temperature: 0.1
      });
      const text3 = response.choices?.[0]?.message?.content || "";
      const jsonMatch = text3.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("AI analyze-prescription: No JSON found in response:", text3.substring(0, 200));
        return res.json({ success: false, error: "AI could not parse the prescription" });
      }
      const data = JSON.parse(jsonMatch[0]);
      const cleanedData = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== void 0 && value !== "" && value !== "null") {
          if ((key === "doctorName" || key === "patientName") && typeof value === "string") {
            cleanedData[key] = fixNameOrder2(value) ?? value;
          } else {
            cleanedData[key] = value;
          }
        }
      }
      console.log("AI analyze-prescription: Success, fields:", Object.keys(cleanedData).join(", "));
      return res.json({ success: true, data: cleanedData });
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error("AI analyze-prescription error:", errMsg);
      return res.status(500).json({ success: false, error: "AI analysis failed. Please try again.", detail: errMsg });
    }
  });
  app2.post("/api/crop-document", optionalAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai)
        return res.status(503).json({ error: "AI integrations are not configured." });
      const { imageBase64 } = req.body;
      if (!imageBase64)
        return res.status(400).json({ error: "No image provided" });
      let base64Data;
      let rawBuffer;
      let rotatedBuffer;
      let rotatedDataUrl;
      try {
        base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        rawBuffer = Buffer.from(base64Data, "base64");
        if (rawBuffer.length < 100)
          return res.status(400).json({ error: "Unable to process this image." });
      } catch {
        return res.status(400).json({ error: "Unable to process this image." });
      }
      try {
        rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
        rotatedDataUrl = `data:image/jpeg;base64,${rotatedBuffer.toString("base64")}`;
      } catch {
        return res.status(500).json({ error: "Unable to process this image." });
      }
      let aiResult = null;
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-5.1",
          messages: [
            { role: "system", content: `You are a professional document scanner. Detect any document in the photo and return TIGHT crop coordinates that isolate ONLY the document. Use percentage coordinates (0-100). Return ONLY valid JSON: { "documentDetected": true, "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 }, "rotation": 0, "documentType": "prescription" }` },
            { role: "user", content: [
              { type: "text", text: "Detect the document in this photo." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } }
            ] }
          ],
          max_completion_tokens: 250
        });
        const text3 = response.choices?.[0]?.message?.content || "";
        const jsonMatch = text3.match(/\{[\s\S]*\}/);
        if (jsonMatch)
          aiResult = JSON.parse(jsonMatch[0]);
      } catch {
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }
      if (!aiResult?.documentDetected || !aiResult?.crop)
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      try {
        const metadata = await sharp(rotatedBuffer).metadata();
        const imgW = metadata.width || 1;
        const imgH = metadata.height || 1;
        const left = Math.max(0, Math.round(aiResult.crop.left / 100 * imgW));
        const top = Math.max(0, Math.round(aiResult.crop.top / 100 * imgH));
        const right = Math.min(imgW, Math.round(aiResult.crop.right / 100 * imgW));
        const bottom = Math.min(imgH, Math.round(aiResult.crop.bottom / 100 * imgH));
        const cropW = Math.max(1, right - left);
        const cropH = Math.max(1, bottom - top);
        let pipeline = sharp(rotatedBuffer).extract({ left, top, width: cropW, height: cropH });
        const rotation = aiResult.rotation || 0;
        if (rotation === 90 || rotation === 180 || rotation === 270)
          pipeline = pipeline.rotate(rotation);
        const croppedBuffer = await pipeline.sharpen({ sigma: 1.2 }).normalize().jpeg({ quality: 92 }).toBuffer();
        return res.json({ documentDetected: true, croppedImageBase64: `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`, documentType: aiResult.documentType });
      } catch {
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }
    } catch {
      return res.status(500).json({ error: "Unable to process this image." });
    }
  });
  app2.post("/api/document-to-pdf", optionalAuth, async (req, res) => {
    try {
      const { images } = req.body;
      if (!images || !Array.isArray(images) || images.length === 0)
        return res.status(400).json({ error: "No images provided" });
      const pageImages = [];
      for (const img of images) {
        try {
          if (typeof img !== "string" || !img.startsWith("data:") && img.length < 100)
            continue;
          const b64 = img.replace(/^data:image\/\w+;base64,/, "");
          const buf = Buffer.from(b64, "base64");
          if (buf.length < 100)
            continue;
          const rotated = await sharp(buf).rotate().jpeg({ quality: 95 }).toBuffer();
          const meta = await sharp(rotated).metadata();
          pageImages.push({ buffer: rotated, width: meta.width || 612, height: meta.height || 792 });
        } catch {
        }
      }
      if (pageImages.length === 0)
        return res.status(400).json({ error: "No valid images" });
      const PDF_W = 612;
      const PDF_H = 792;
      const MARGIN = 18;
      let objCount = 0;
      const newObj = () => {
        objCount++;
        return objCount;
      };
      const catalogId = newObj();
      const pagesId = newObj();
      const pageObjIds = [];
      const imgObjIds = [];
      const contentObjIds = [];
      for (const _pg of pageImages) {
        pageObjIds.push(newObj());
        imgObjIds.push(newObj());
        contentObjIds.push(newObj());
      }
      const objStrs = [];
      objStrs.push({ id: catalogId, str: `${catalogId} 0 obj
<< /Type /Catalog /Pages ${pagesId} 0 R >>
endobj
` });
      objStrs.push({ id: pagesId, str: `${pagesId} 0 obj
<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>
endobj
` });
      for (let i = 0; i < pageImages.length; i++) {
        const pg2 = pageImages[i];
        const scale = Math.min((PDF_W - MARGIN * 2) / pg2.width, (PDF_H - MARGIN * 2) / pg2.height);
        const drawW = Math.round(pg2.width * scale), drawH = Math.round(pg2.height * scale);
        const drawX = Math.round((PDF_W - drawW) / 2), drawY = Math.round((PDF_H - drawH) / 2);
        const contentStr = `q
${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm
/Img${i} Do
Q
`;
        objStrs.push({ id: contentObjIds[i], str: `${contentObjIds[i]} 0 obj
<< /Length ${contentStr.length} >>
stream
${contentStr}endstream
endobj
` });
        objStrs.push({ id: pageObjIds[i], str: `${pageObjIds[i]} 0 obj
<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_W} ${PDF_H}] /Contents ${contentObjIds[i]} 0 R /Resources << /XObject << /Img${i} ${imgObjIds[i]} 0 R >> >> >>
endobj
` });
        objStrs.push({ id: imgObjIds[i], str: `${imgObjIds[i]} 0 obj
<< /Type /XObject /Subtype /Image /Width ${pg2.width} /Height ${pg2.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg2.buffer.length} >>
stream
` });
      }
      const sortedObjs = objStrs.sort((a, b) => a.id - b.id);
      let output = Buffer.from("%PDF-1.4\n");
      const xrefOffsets = new Array(objCount + 1).fill(0);
      for (const obj of sortedObjs) {
        xrefOffsets[obj.id] = output.length;
        if (obj.str.includes("/DCTDecode")) {
          const imgIdx = imgObjIds.indexOf(obj.id);
          if (imgIdx >= 0) {
            output = Buffer.concat([output, Buffer.from(obj.str), pageImages[imgIdx].buffer, Buffer.from("\nendstream\nendobj\n")]);
          } else {
            output = Buffer.concat([output, Buffer.from(obj.str)]);
          }
        } else {
          output = Buffer.concat([output, Buffer.from(obj.str)]);
        }
      }
      const xrefOffset = output.length;
      let xrefStr = `xref
0 ${objCount + 1}
0000000000 65535 f 
`;
      for (let i = 1; i <= objCount; i++)
        xrefStr += `${String(xrefOffsets[i]).padStart(10, "0")} 00000 n 
`;
      xrefStr += `trailer
<< /Size ${objCount + 1} /Root ${catalogId} 0 R >>
startxref
${xrefOffset}
%%EOF
`;
      output = Buffer.concat([output, Buffer.from(xrefStr)]);
      res.json({ success: true, pdfBase64: `data:application/pdf;base64,${output.toString("base64")}`, pageCount: pageImages.length });
    } catch (err) {
      res.status(500).json({ error: "PDF generation failed" });
    }
  });
  app2.post("/api/smile-process", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai)
        return res.status(503).json({ error: "AI integrations are not configured." });
      const { imageBase64, mode } = req.body;
      if (!imageBase64)
        return res.status(400).json({ error: "No image provided" });
      let prompt = "";
      if (mode === "whiten")
        prompt = "Edit this photo to whiten and brighten the person's teeth to a natural, beautiful Hollywood-white shade. Keep everything else the same.";
      else if (mode === "symmetry")
        prompt = "Edit this photo to make the person's visible teeth perfectly symmetrical and even. Keep everything else the same.";
      else if (mode === "both")
        prompt = "Edit this photo to whiten teeth AND make them perfectly symmetrical. Keep everything else the same.";
      else
        return res.status(400).json({ error: "Invalid mode." });
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      const imgFile = await toFile(imgBuffer, "image.png", { type: "image/png" });
      const response = await openai.images.edit({ model: "gpt-image-1", image: imgFile, prompt, size: "1024x1024" });
      const outputBase64 = response.data?.[0]?.b64_json;
      if (!outputBase64)
        return res.status(500).json({ error: "AI did not return an image." });
      res.json({ imageBase64: `data:image/png;base64,${outputBase64}` });
    } catch (err) {
      res.status(500).json({ error: "Failed to process image" });
    }
  });
  app2.delete("/api/admin/cleanup-email", async (req, res) => {
    try {
      const { email, adminKey } = req.body;
      const cleanupKey = process.env.LABTRAX_ADMIN_CLEANUP_KEY;
      if (!cleanupKey)
        return res.status(404).json({ error: "Not found" });
      if (adminKey !== cleanupKey)
        return res.status(403).json({ error: "Unauthorized" });
      if (!email)
        return res.status(400).json({ error: "Email required" });
      const allUsers = await db.select().from(users);
      const matches = allUsers.filter((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (matches.length === 0)
        return res.json({ success: true, deleted: 0, message: "No users found" });
      let deletedCount = 0;
      for (const u of matches) {
        await db.delete(users).where(eq7(users.id, u.id));
        deletedCount++;
      }
      res.json({ success: true, deleted: deletedCount, found: matches.length });
    } catch {
      res.status(500).json({ error: "Cleanup failed" });
    }
  });
  app2.get("/api/admin/backup", requireAuth, async (req, res) => {
    try {
      const reqUser = req.user;
      if (!reqUser || reqUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required." });
      }
      const allUsers = await db.select().from(users);
      const allCases = await db.select().from(labCases);
      const safeUsers = allUsers.map((u) => {
        const { password: _pw, ...rest } = u;
        return rest;
      });
      const manifest = {
        version: "1.0",
        appName: "LabTrax",
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exportedBy: reqUser.username || reqUser.id,
        counts: {
          users: safeUsers.length,
          cases: allCases.length
        },
        tables: ["users", "lab_cases"],
        note: "Passwords are excluded from user records for security. Media files are included in the media/ directory."
      };
      const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
      const mediaExists = fs.existsSync(mediaDir);
      const dateStr = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const filename = `labtrax-backup-${dateStr}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err) => {
        console.error("Backup archive error:", err);
        if (!res.headersSent)
          res.status(500).json({ error: "Backup failed." });
      });
      archive.pipe(res);
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      archive.append(JSON.stringify(safeUsers, null, 2), { name: "data/users.json" });
      archive.append(JSON.stringify(allCases, null, 2), { name: "data/cases.json" });
      if (mediaExists) {
        archive.directory(mediaDir, "media");
      }
      await archive.finalize();
    } catch (e) {
      console.error("Backup endpoint error:", e?.message);
      if (!res.headersSent)
        res.status(500).json({ error: "Backup failed." });
    }
  });
  app2.post("/api/admin/backup/onedrive", requireAuth, async (req, res) => {
    try {
      const reqUser = req.user;
      if (!reqUser || reqUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required." });
      }
      const allUsers = await db.select().from(users);
      const allCases = await db.select().from(labCases);
      const safeUsers = allUsers.map((u) => {
        const { password: _pw, ...rest } = u;
        return rest;
      });
      const dateStr = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const fileName = `labtrax-backup-${dateStr}.zip`;
      const manifest = {
        version: "1.0",
        appName: "LabTrax",
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        exportedBy: reqUser.username || reqUser.id,
        counts: { users: safeUsers.length, cases: allCases.length },
        tables: ["users", "lab_cases"],
        note: "Passwords excluded. Media files included in media/ directory."
      };
      const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
      const mediaExists = fs.existsSync(mediaDir);
      const zipBuffer = await new Promise((resolve3, reject) => {
        const chunks = [];
        const archive = archiver("zip", { zlib: { level: 6 } });
        archive.on("data", (chunk) => chunks.push(chunk));
        archive.on("end", () => resolve3(Buffer.concat(chunks)));
        archive.on("error", reject);
        archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
        archive.append(JSON.stringify(safeUsers, null, 2), { name: "data/users.json" });
        archive.append(JSON.stringify(allCases, null, 2), { name: "data/cases.json" });
        if (mediaExists)
          archive.directory(mediaDir, "media");
        archive.finalize();
      });
      const result = await uploadToOneDrive(zipBuffer, fileName, "LabTrax Backups");
      return res.json({
        success: true,
        fileName: result.name,
        size: result.size,
        webUrl: result.webUrl,
        folder: "LabTrax Backups"
      });
    } catch (e) {
      console.error("OneDrive backup error:", e?.message);
      return res.status(500).json({ error: e?.message || "OneDrive backup failed." });
    }
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/index.ts
import { sql as sql3 } from "drizzle-orm";
import * as fs2 from "fs";
import * as path2 from "path";
var app = express2();
var log = console.log;
var DEMO_ACCOUNTS_ENABLED = process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true";
var SENSITIVE_LOG_KEYS = /* @__PURE__ */ new Set([
  "accessToken",
  "refreshToken",
  "password",
  "token",
  "demoCode",
  "demoResetLink",
  "adminKey"
]);
function redactSensitivePayload(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitivePayload(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_LOG_KEYS.has(key) ? "[REDACTED]" : redactSensitivePayload(entry)
      ])
    );
  }
  return value;
}
function setupCors(app2) {
  app2.use((req, res, next) => {
    const origins = /* @__PURE__ */ new Set();
    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }
    const origin = req.header("origin");
    const isLocalhost = origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:");
    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.header("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}
function setupBodyParsing(app2) {
  app2.use(
    express2.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express2.urlencoded({ extended: false, limit: "50mb" }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path3 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path3.startsWith("/api"))
        return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redactSensitivePayload(capturedJsonResponse))}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      logLine = logLine.replace("\xE2\u20AC\xA6", "...");
      logLine = logLine.replace(/[^\x20-\x7E]+$/, "...");
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path2.resolve(process.cwd(), "app.json");
    const appJsonContent = fs2.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, req, res) {
  const manifestPath = path2.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs2.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  let manifest = fs2.readFileSync(manifestPath, "utf-8");
  const forwardedHost = req.header("x-forwarded-host");
  const actualHost = forwardedHost || req.get("host");
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const actualBaseUrl = `${protocol}://${actualHost}`;
  manifest = manifest.replace(/https?:\/\/[^"]*?janeway\.replit\.dev(?::\d+)?/g, actualBaseUrl);
  manifest = manifest.replace(/http:\/\/127\.0\.0\.1:\d+/g, actualBaseUrl);
  manifest = manifest.replace(/http:\/\/localhost:\d+/g, actualBaseUrl);
  res.send(manifest);
}
function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);
  const html = landingPageTemplate.replace(/BASE_URL_PLACEHOLDER/g, baseUrl).replace(/EXPS_URL_PLACEHOLDER/g, expsUrl).replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
function configureExpoAndLanding(app2) {
  const templatePath = path2.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs2.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    if (req.path === "/smile-preview") {
      const smilePath = path2.resolve(process.cwd(), "server", "templates", "smile-preview.html");
      if (fs2.existsSync(smilePath)) {
        return res.sendFile(smilePath);
      }
    }
    if (req.path === "/reset-password") {
      const resetPath = path2.resolve(process.cwd(), "server", "templates", "reset-password.html");
      if (fs2.existsSync(resetPath)) {
        return res.sendFile(resetPath);
      }
    }
    if (req.path === "/privacy-policy" || req.path === "/privacy") {
      const privacyPath = path2.resolve(process.cwd(), "server", "templates", "privacy-policy.html");
      if (fs2.existsSync(privacyPath)) {
        return res.sendFile(privacyPath);
      }
    }
    if (req.path === "/terms-of-service" || req.path === "/terms") {
      const termsPath = path2.resolve(process.cwd(), "server", "templates", "terms-of-service.html");
      if (fs2.existsSync(termsPath)) {
        return res.sendFile(termsPath);
      }
    }
    if (req.path === "/app") {
      const indexPath = path2.resolve(process.cwd(), "static-build", "index.html");
      if (fs2.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      if (devDomain) {
        return res.redirect(`https://${devDomain}:8081`);
      }
      return res.redirect("/");
    }
    if (req.path.startsWith("/app/")) {
      return next();
    }
    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }
    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, req, res);
    }
    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName
      });
    }
    next();
  });
  app2.use("/assets", express2.static(path2.resolve(process.cwd(), "assets")));
  app2.use("/public", express2.static(path2.resolve(process.cwd(), "public")));
  app2.use("/app", express2.static(path2.resolve(process.cwd(), "static-build")));
  app2.use(express2.static(path2.resolve(process.cwd(), "static-build")));
  const webIndexPath = path2.resolve(process.cwd(), "static-build", "index.html");
  app2.use((req, res, next) => {
    if (req.method === "GET" && req.path.startsWith("/app/") && !req.path.includes(".")) {
      if (fs2.existsSync(webIndexPath)) {
        return res.sendFile(webIndexPath);
      }
    }
    next();
  });
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    if (status >= 500) {
      console.error("Internal Server Error:", err);
    }
    return res.status(status).json({ ok: false, message, ...error.details ? { details: error.details } : {} });
  });
}
function setupSecurityHeaders(app2) {
  app2.use((_req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (_req.path === "/smile-preview") {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
    } else {
      res.setHeader("X-Frame-Options", "DENY");
    }
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    next();
  });
}
async function seedDemoAccount() {
  if (!DEMO_ACCOUNTS_ENABLED) {
    return;
  }
  const accounts = [
    { username: "demo_lab_owner", password: "LabTraxDemo#2026", email: "demo_lab_owner@labtrax.local", userType: "lab", role: "admin" },
    { username: "demo_provider_admin", password: "LabTraxDemo#2026", email: "demo_provider_admin@labtrax.local", userType: "provider", role: "admin" }
  ];
  for (const acct of accounts) {
    try {
      const allUsers = await db.select().from(users);
      const existing = allUsers.find((u) => u.username.toLowerCase() === acct.username.toLowerCase());
      if (!existing) {
        const hashed = await hashPassword(acct.password);
        await db.insert(users).values({
          username: acct.username,
          password: hashed,
          email: acct.email,
          userType: acct.userType,
          role: acct.role,
          initials: acct.username.slice(0, 2).toUpperCase()
        });
        log(`Demo account ${acct.username} seeded successfully`);
      }
    } catch (err) {
      console.error(`Demo account seed error (${acct.username}):`, err?.message || err);
    }
  }
}
async function runStartupMigrations() {
  try {
    await db.execute(
      sql3`DROP INDEX IF EXISTS "join_requests_lab_user_status_unique"`
    );
    await db.execute(
      sql3`
        DELETE FROM "join_requests"
        WHERE status = 'pending'
          AND id NOT IN (
            SELECT DISTINCT ON (lab_id, user_id) id
            FROM "join_requests"
            WHERE status = 'pending'
            ORDER BY lab_id, user_id, created_at DESC
          )
      `
    );
    await db.execute(
      sql3`
        CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_unique"
        ON "join_requests" ("lab_id", "user_id")
        WHERE status = 'pending'
      `
    );
    await db.execute(
      sql3`ALTER TABLE users ADD COLUMN IF NOT EXISTS work_status TEXT DEFAULT 'available'`
    );
    log("Startup migrations applied successfully");
  } catch (err) {
    console.error("Startup migration error:", err?.message || err);
  }
}
(async () => {
  setupCors(app);
  setupSecurityHeaders(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  await runStartupMigrations();
  configureExpoAndLanding(app);
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  await seedDemoAccount();
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0"
    },
    () => {
      log(`express server serving on port ${port}`);
    }
  );
})();
