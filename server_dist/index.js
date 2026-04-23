var __defProp = Object.defineProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "node:http";
import OpenAI from "openai";
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
  "organization_memberships",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
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
      table.organizationId,
      table.userId
    ),
    orgIdx: index("memberships_org_idx").on(table.organizationId),
    userIdx: index("memberships_user_idx").on(table.userId)
  })
);
var organizationJoinRequests = pgTable(
  "organization_join_requests",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: varchar("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  }
);
var organizationInvites = pgTable(
  "organization_invites",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    phone: text("phone"),
    roleToAssign: text("role_to_assign").notNull(),
    token: text("token").notNull(),
    status: text("status").default("pending").notNull(),
    invitedByUserId: varchar("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByUserId: varchar("accepted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => ({
    tokenUnique: uniqueIndex("organization_invites_token_unique").on(
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
      fields: [organizationMemberships.organizationId],
      references: [organizations.id]
    }),
    user: one(users, {
      fields: [organizationMemberships.userId],
      references: [users.id]
    })
  })
);
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
import { eq as eq7, inArray as inArray4 } from "drizzle-orm";

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

// server/routes/auth.ts
import crypto2 from "node:crypto";
import { Router } from "express";
import { and as and2, eq as eq2, gt as gt2, inArray, isNull as isNull2 } from "drizzle-orm";
import { z } from "zod";

// server/lib/auth.ts
import jwt from "jsonwebtoken";
var JWT_SECRET = process.env.JWT_SECRET || "labtrax-jwt-secret-change-in-production";
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
  return jwt.verify(token, JWT_SECRET);
}
function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_SECRET);
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

// server/middleware/async-handler.ts
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// server/middleware/auth.ts
import { and, eq, isNull, gt } from "drizzle-orm";
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
    wantsUpdates: user.wantsUpdates
  };
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
  wantsUpdates: z.boolean().optional()
});
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
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
    const initials = input.firstName && input.lastName ? (input.firstName[0] + input.lastName[0]).toUpperCase() : input.username.slice(0, 2).toUpperCase();
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
      role: input.role || "user",
      licenseNumber: input.licenseNumber || null,
      practiceName: input.practiceName || null,
      doctorName: input.doctorName || null,
      practiceAddress: input.practiceAddress || null,
      practicePhone: input.practicePhone || null,
      phoneContactName: input.phoneContactName || null,
      accountNumber: input.accountNumber || null,
      wantsUpdates: input.wantsUpdates || false
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
    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: safeUser(user)
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
    return res.json({
      success: true,
      accessToken,
      refreshToken: rawRefreshToken,
      user: safeUser(user)
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
    const orgIds = memberships.map((m) => m.organizationId);
    const orgs = orgIds.length ? await db.select().from(organizations).where(inArray(organizations.id, orgIds)) : [];
    return res.json({
      success: true,
      user: safeUser(user),
      memberships: memberships.map((m) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        organizationId: m.organizationId,
        organization: orgs.find((org) => org.id === m.organizationId) ?? null
      }))
    });
  })
);
router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const allUsers = await db.select().from(users);
    res.json({
      users: allUsers.map((u) => safeUser(u))
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
var auth_default = router;

// server/routes/organizations.ts
import { Router as Router2 } from "express";
import { and as and4, eq as eq4, inArray as inArray2 } from "drizzle-orm";
import { z as z2 } from "zod";

// server/lib/rbac.ts
import { and as and3, eq as eq3 } from "drizzle-orm";
async function getActiveMembership(userId, organizationId) {
  const membership = await db.query.organizationMemberships.findFirst({
    where: and3(
      eq3(organizationMemberships.userId, userId),
      eq3(organizationMemberships.organizationId, organizationId),
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
router2.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createOrgSchema.parse(req.body);
    const [organization] = await db.insert(organizations).values({
      ...input,
      createdByUserId: req.auth.userId
    }).returning();
    await db.insert(organizationMemberships).values({
      organizationId: organization.id,
      userId: req.auth.userId,
      role: "owner",
      status: "active",
      approvedByUserId: req.auth.userId,
      joinedAt: /* @__PURE__ */ new Date()
    });
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
    const orgIds = memberships.filter((m) => m.status === "active").map((m) => m.organizationId);
    const orgs = orgIds.length ? await db.select().from(organizations).where(inArray2(organizations.id, orgIds)) : [];
    return ok(res, orgs);
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
        organizationMemberships.organizationId,
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
    const [invite] = await db.insert(organizationInvites).values({
      organizationId,
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
      where: eq4(organizationInvites.organizationId, organizationId)
    });
    return ok(res, invites);
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
    if (/* @__PURE__ */ new Date() > invite.expiresAt)
      throw new HttpError(410, "Invite has expired.");
    const userId = req.auth.userId;
    await db.insert(organizationMemberships).values({
      organizationId: invite.organizationId,
      userId,
      role: invite.roleToAssign,
      status: "active",
      invitedByUserId: invite.invitedByUserId,
      approvedByUserId: invite.invitedByUserId,
      joinedAt: /* @__PURE__ */ new Date()
    }).onConflictDoUpdate({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId
      ],
      set: {
        role: invite.roleToAssign,
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
    await writeAuditLog({
      req,
      organizationId: invite.organizationId,
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
        eq4(organizationMemberships.organizationId, organizationId),
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
    const [request] = await db.insert(organizationJoinRequests).values({
      organizationId,
      requestedByUserId: req.auth.userId,
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
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      req.auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const requests = await db.query.organizationJoinRequests.findMany({
      where: eq4(
        organizationJoinRequests.organizationId,
        organizationId
      )
    });
    return ok(res, requests);
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
      request.organizationId,
      ADMIN_ROLES
    );
    const roleToAssign = req.body.role || request.requestedRole;
    const [membership] = await db.insert(organizationMemberships).values({
      organizationId: request.organizationId,
      userId: request.requestedByUserId,
      role: roleToAssign,
      status: "active",
      approvedByUserId: req.auth.userId,
      joinedAt: /* @__PURE__ */ new Date()
    }).onConflictDoUpdate({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId
      ],
      set: {
        role: roleToAssign,
        status: "active",
        approvedByUserId: req.auth.userId,
        joinedAt: /* @__PURE__ */ new Date()
      }
    }).returning();
    const [updatedRequest] = await db.update(organizationJoinRequests).set({
      status: "approved",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationJoinRequests.id, request.id)).returning();
    await writeAuditLog({
      req,
      organizationId: request.organizationId,
      action: "organization_join_approved",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updatedRequest
    });
    return ok(res, { membership, request: updatedRequest });
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
      request.organizationId,
      ADMIN_ROLES
    );
    const [updated] = await db.update(organizationJoinRequests).set({
      status: "rejected",
      reviewedByUserId: req.auth.userId,
      reviewedAt: /* @__PURE__ */ new Date()
    }).where(eq4(organizationJoinRequests.id, request.id)).returning();
    await writeAuditLog({
      req,
      organizationId: request.organizationId,
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
      requestedByUserId: req.auth.userId
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
      membership.organizationId,
      ADMIN_ROLES
    );
    const [updated] = await db.update(organizationMemberships).set(input).where(eq4(organizationMemberships.id, membership.id)).returning();
    await writeAuditLog({
      req,
      organizationId: membership.organizationId,
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
        membership.organizationId,
        ADMIN_ROLES
      );
    }
    await db.delete(organizationMemberships).where(eq4(organizationMemberships.id, membership.id));
    await writeAuditLog({
      req,
      organizationId: membership.organizationId,
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
    })).map((m) => m.organizationId);
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
    const orgIds = memberships.filter((m) => m.status === "active").map((m) => m.organizationId);
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
var openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
});
var verificationCodes = /* @__PURE__ */ new Map();
var passwordResetTokens = /* @__PURE__ */ new Map();
function generateCode() {
  return Math.floor(1e5 + Math.random() * 9e5).toString();
}
function generateResetToken() {
  return __require("crypto").randomBytes(32).toString("hex");
}
var DEFAULT_USERS = [
  { username: "admin", password: "123", userType: "lab", role: "user" },
  { username: "tech", password: "tech123", userType: "lab", role: "user" },
  { username: "JPPhillips", password: "Master1!", email: "john.phillips3@yahoo.com", phone: "850-363-3336", userType: "master_admin", role: "admin", accountNumber: "MA-001" }
];
async function seedDefaultUsers() {
  for (const def of DEFAULT_USERS) {
    const allUsers = await db.select().from(users);
    const existing = allUsers.find((u) => u.username.toLowerCase() === def.username.toLowerCase());
    if (!existing) {
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
      console.log(`[SEED] Created default user: ${def.username}`);
    }
  }
}
async function registerRoutes(app2) {
  await seedDefaultUsers();
  app2.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  });
  app2.use("/api/auth", auth_default);
  app2.use("/api/organizations", organizations_default);
  app2.use("/api/cases", cases_default);
  app2.use("/api/invoices", invoices_default);
  app2.post("/api/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const allUsers = await db.select().from(users);
    const existing = allUsers.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
    res.json({ available: !existing });
  });
  app2.post("/api/legacy/cases", async (req, res) => {
    try {
      const { id, ownerId, caseData } = req.body;
      if (!id || !ownerId || !caseData) {
        return res.status(400).json({ error: "id, ownerId, and caseData are required" });
      }
      await db.insert(labCases).values({
        id,
        ownerId,
        caseData: typeof caseData === "string" ? caseData : JSON.stringify(caseData),
        updatedAt: /* @__PURE__ */ new Date()
      }).onConflictDoUpdate({
        target: labCases.id,
        set: { ownerId, caseData: typeof caseData === "string" ? caseData : JSON.stringify(caseData), updatedAt: /* @__PURE__ */ new Date() }
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Legacy upsert case error:", error?.message || error);
      res.status(500).json({ error: "Failed to save case" });
    }
  });
  app2.get("/api/legacy/cases", async (req, res) => {
    try {
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
  app2.delete("/api/legacy/cases/:caseId", async (req, res) => {
    try {
      const { caseId } = req.params;
      await db.delete(labCases).where(eq7(labCases.id, caseId));
      res.json({ success: true });
    } catch (error) {
      console.error("Legacy delete case error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete case" });
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
      console.log(`[SMS VERIFICATION] Twilio not configured. Code for ${phone}: ${code}`);
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
      console.log(`[EMAIL VERIFICATION] SMTP not configured. Code for ${email}: ${code}`);
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
        console.log(`[EMAIL] SMTP not configured. Reset link for ${user.email}: ${resetLink}`);
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
        console.log(`[EMAIL] SMTP not configured. Username for ${user.email}: ${user.username}`);
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
  app2.post("/api/send-case-update-text", async (req, res) => {
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
  app2.post("/api/crop-document", async (req, res) => {
    try {
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
          model: "gpt-4o",
          messages: [
            { role: "system", content: `You are a professional document scanner. Detect any document in the photo and return TIGHT crop coordinates that isolate ONLY the document. Use percentage coordinates (0-100). Return ONLY valid JSON: { "documentDetected": true, "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 }, "rotation": 0, "documentType": "prescription" }` },
            { role: "user", content: [
              { type: "text", text: "Detect the document in this photo." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } }
            ] }
          ],
          max_tokens: 250
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
  app2.post("/api/document-to-pdf", async (req, res) => {
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
  app2.post("/api/smile-process", async (req, res) => {
    try {
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
      const response = await openai.images.edit({ model: "gpt-image-1", image: imgBuffer, prompt, size: "1024x1024" });
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
      if (adminKey !== "labtrax-cleanup-2026")
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
  const httpServer = createServer(app2);
  return httpServer;
}

// server/index.ts
import * as fs from "fs";
import * as path from "path";
var app = express();
var log = console.log;
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
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express.urlencoded({ extended: false, limit: "50mb" }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path2 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path2.startsWith("/api"))
        return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path2} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, req, res) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  let manifest = fs.readFileSync(manifestPath, "utf-8");
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
  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    if (req.path === "/smile-preview") {
      const smilePath = path.resolve(process.cwd(), "server", "templates", "smile-preview.html");
      if (fs.existsSync(smilePath)) {
        return res.sendFile(smilePath);
      }
    }
    if (req.path === "/reset-password") {
      const resetPath = path.resolve(process.cwd(), "server", "templates", "reset-password.html");
      if (fs.existsSync(resetPath)) {
        return res.sendFile(resetPath);
      }
    }
    if (req.path === "/privacy-policy" || req.path === "/privacy") {
      const privacyPath = path.resolve(process.cwd(), "server", "templates", "privacy-policy.html");
      if (fs.existsSync(privacyPath)) {
        return res.sendFile(privacyPath);
      }
    }
    if (req.path === "/terms-of-service" || req.path === "/terms") {
      const termsPath = path.resolve(process.cwd(), "server", "templates", "terms-of-service.html");
      if (fs.existsSync(termsPath)) {
        return res.sendFile(termsPath);
      }
    }
    if (req.path === "/app") {
      const indexPath = path.resolve(process.cwd(), "static-build", "index.html");
      if (fs.existsSync(indexPath)) {
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
  app2.use("/assets", express.static(path.resolve(process.cwd(), "assets")));
  app2.use("/public", express.static(path.resolve(process.cwd(), "public")));
  app2.use("/app", express.static(path.resolve(process.cwd(), "static-build")));
  app2.use(express.static(path.resolve(process.cwd(), "static-build")));
  const webIndexPath = path.resolve(process.cwd(), "static-build", "index.html");
  app2.use((req, res, next) => {
    if (req.method === "GET" && req.path.startsWith("/app/") && !req.path.includes(".")) {
      if (fs.existsSync(webIndexPath)) {
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
  const accounts = [
    { username: "phillipsjohnpaul@yahoo.com", password: "Jp#14482726", email: "phillipsjohnpaul@yahoo.com", userType: "lab", role: "admin" },
    { username: "test@allieddl.com", password: "Test1234", email: "test@allieddl.com", userType: "lab", role: "admin" }
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
(async () => {
  setupCors(app);
  setupSecurityHeaders(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
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
