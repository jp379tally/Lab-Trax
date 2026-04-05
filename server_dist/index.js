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

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  insertUserSchema: () => insertUserSchema,
  labCases: () => labCases,
  users: () => users
});
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
var users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email"),
  phone: text("phone"),
  userType: text("user_type").default("lab"),
  role: text("role").default("user"),
  licenseNumber: text("license_number"),
  practiceName: text("practice_name"),
  doctorName: text("doctor_name"),
  practiceAddress: text("practice_address"),
  practicePhone: text("practice_phone"),
  phoneContactName: text("phone_contact_name"),
  accountNumber: text("account_number"),
  wantsUpdates: boolean("wants_updates").default(false),
  createdAt: timestamp("created_at").defaultNow()
});
var labCases = pgTable("lab_cases", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  caseData: text("case_data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow()
});
var insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true
});

// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}
var connectionString = process.env.DATABASE_URL;
if (!connectionString.includes("sslmode=")) {
  const separator = connectionString.includes("?") ? "&" : "?";
  connectionString += `${separator}sslmode=verify-full`;
}
var pool = new pg.Pool({ connectionString });
var db = drizzle(pool, { schema: schema_exports });

// server/storage.ts
import { eq, inArray } from "drizzle-orm";
var DatabaseStorage = class {
  async getUser(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }
  async getUserByUsername(username) {
    const allUsers = await db.select().from(users);
    return allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
  }
  async getUserByEmail(email) {
    const allUsers = await db.select().from(users);
    return allUsers.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  }
  async createUser(userData) {
    const [user] = await db.insert(users).values({
      username: userData.username,
      password: userData.password,
      email: userData.email || null,
      phone: userData.phone || null,
      userType: userData.userType || "lab",
      role: userData.role || "user",
      licenseNumber: userData.licenseNumber || null,
      practiceName: userData.practiceName || null,
      doctorName: userData.doctorName || null,
      practiceAddress: userData.practiceAddress || null,
      practicePhone: userData.practicePhone || null,
      phoneContactName: userData.phoneContactName || null,
      accountNumber: userData.accountNumber || null,
      wantsUpdates: userData.wantsUpdates || false
    }).returning();
    return user;
  }
  async getAllUsers() {
    return db.select().from(users);
  }
  async updateUser(id, data) {
    const [updated] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return updated;
  }
  async deleteUser(id) {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }
  async upsertCase(id, ownerId, caseData) {
    await db.insert(labCases).values({ id, ownerId, caseData, updatedAt: /* @__PURE__ */ new Date() }).onConflictDoUpdate({
      target: labCases.id,
      set: { ownerId, caseData, updatedAt: /* @__PURE__ */ new Date() }
    });
  }
  async getCasesByOwnerIds(ownerIds) {
    if (ownerIds.length === 0)
      return [];
    const rows = await db.select().from(labCases).where(inArray(labCases.ownerId, ownerIds));
    return rows.map((r) => ({ id: r.id, ownerId: r.ownerId, caseData: r.caseData }));
  }
  async deleteCase(id) {
    await db.delete(labCases).where(eq(labCases.id, id));
  }
};
var storage = new DatabaseStorage();

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
    const existing = await storage.getUserByUsername(def.username);
    if (!existing) {
      await storage.createUser(def);
      console.log(`[SEED] Created default user: ${def.username}`);
    }
  }
}
async function registerRoutes(app2) {
  await seedDefaultUsers();
  const auditLog = [];
  app2.post("/api/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const existing = await storage.getUserByUsername(username.trim());
    res.json({ available: !existing });
  });
  app2.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password, email, phone, userType, role, licenseNumber, practiceName, doctorName, practiceAddress, practicePhone, phoneContactName, accountNumber, wantsUpdates } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      const existing = await storage.getUserByUsername(username.trim());
      if (existing) {
        return res.status(409).json({ error: "Username already taken." });
      }
      const user = await storage.createUser({
        username: username.trim(),
        password,
        email: email || null,
        phone: phone || null,
        userType: userType || "lab",
        role: role || "user",
        licenseNumber: licenseNumber || null,
        practiceName: practiceName || null,
        doctorName: doctorName || null,
        practiceAddress: practiceAddress || null,
        practicePhone: practicePhone || null,
        phoneContactName: phoneContactName || null,
        accountNumber: accountNumber || null,
        wantsUpdates: wantsUpdates || false
      });
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          userType: user.userType,
          role: user.role,
          licenseNumber: user.licenseNumber,
          practiceName: user.practiceName,
          doctorName: user.doctorName,
          practiceAddress: user.practiceAddress,
          practicePhone: user.practicePhone,
          phoneContactName: user.phoneContactName,
          accountNumber: user.accountNumber
        }
      });
    } catch (error) {
      console.error("Registration error:", error?.message || error);
      res.status(500).json({ error: "Registration failed" });
    }
  });
  app2.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      const user = await storage.getUserByUsername(username.trim());
      if (!user || user.password !== password) {
        return res.status(401).json({ error: "Invalid username or password." });
      }
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          userType: user.userType,
          role: user.role,
          licenseNumber: user.licenseNumber,
          practiceName: user.practiceName,
          doctorName: user.doctorName,
          practiceAddress: user.practiceAddress,
          practicePhone: user.practicePhone,
          phoneContactName: user.phoneContactName,
          accountNumber: user.accountNumber
        }
      });
    } catch (error) {
      console.error("Login error:", error?.message || error);
      res.status(500).json({ error: "Login failed" });
    }
  });
  app2.get("/api/auth/users", async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      res.json({
        users: allUsers.map((u) => ({
          id: u.id,
          username: u.username,
          email: u.email,
          phone: u.phone,
          userType: u.userType,
          role: u.role,
          licenseNumber: u.licenseNumber,
          practiceName: u.practiceName,
          doctorName: u.doctorName,
          practiceAddress: u.practiceAddress,
          practicePhone: u.practicePhone,
          phoneContactName: u.phoneContactName,
          accountNumber: u.accountNumber
        }))
      });
    } catch (error) {
      console.error("Get users error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  app2.put("/api/auth/users/:id/profile", async (req, res) => {
    try {
      const { id } = req.params;
      const authUser = req.headers["x-user-id"];
      if (!authUser || authUser !== id) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const user = await storage.getUser(id);
      if (!user)
        return res.status(404).json({ error: "User not found" });
      const { practiceName, practiceAddress, practicePhone, email, phone } = req.body;
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
      const updated = await storage.updateUser(id, updates);
      res.json({ success: true, user: updated });
    } catch (error) {
      res.status(500).json({ error: "Failed to update profile" });
    }
  });
  app2.put("/api/auth/users/:id/password", async (req, res) => {
    try {
      const { id } = req.params;
      const { currentPassword, newPassword } = req.body;
      const user = await storage.getUser(id);
      if (!user)
        return res.status(404).json({ error: "User not found" });
      if (user.password !== currentPassword) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      await storage.updateUser(id, { password: newPassword });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update password" });
    }
  });
  app2.delete("/api/auth/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const authUser = req.headers["x-user-id"];
      if (!authUser || authUser !== id) {
        return res.status(403).json({ error: "You can only delete your own account." });
      }
      const user = await storage.getUser(id);
      if (!user)
        return res.status(404).json({ error: "User not found" });
      const deleted = await storage.deleteUser(id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: "Failed to delete user" });
      }
    } catch (error) {
      console.error("Delete user error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });
  app2.post("/api/cases", async (req, res) => {
    try {
      const { id, ownerId, caseData } = req.body;
      if (!id || !ownerId || !caseData) {
        return res.status(400).json({ error: "id, ownerId, and caseData are required" });
      }
      await storage.upsertCase(id, ownerId, typeof caseData === "string" ? caseData : JSON.stringify(caseData));
      res.json({ success: true });
    } catch (error) {
      console.error("Upsert case error:", error?.message || error);
      res.status(500).json({ error: "Failed to save case" });
    }
  });
  app2.put("/api/cases/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { ownerId, caseData } = req.body;
      if (!caseData || !ownerId) {
        return res.status(400).json({ error: "ownerId and caseData are required" });
      }
      await storage.upsertCase(id, ownerId, typeof caseData === "string" ? caseData : JSON.stringify(caseData));
      res.json({ success: true });
    } catch (error) {
      console.error("Update case error:", error?.message || error);
      res.status(500).json({ error: "Failed to update case" });
    }
  });
  app2.get("/api/cases", async (req, res) => {
    try {
      const ownerIdsParam = req.query.ownerIds;
      if (!ownerIdsParam) {
        return res.json({ cases: [] });
      }
      const ownerIds = ownerIdsParam.split(",").filter(Boolean);
      const rows = await storage.getCasesByOwnerIds(ownerIds);
      const cases = rows.map((r) => {
        try {
          return JSON.parse(r.caseData);
        } catch {
          return null;
        }
      }).filter(Boolean);
      res.json({ cases });
    } catch (error) {
      console.error("Get cases error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch cases" });
    }
  });
  app2.delete("/api/cases/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteCase(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete case error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete case" });
    }
  });
  app2.post("/api/audit-log", (req, res) => {
    const { action, user, resource } = req.body;
    if (!action || !user) {
      return res.status(400).json({ error: "Action and user required" });
    }
    const entry = {
      timestamp: Date.now(),
      action,
      user,
      resource: resource || "",
      ip: req.ip || req.socket.remoteAddress || "unknown"
    };
    auditLog.push(entry);
    if (auditLog.length > 1e4)
      auditLog.splice(0, auditLog.length - 1e4);
    res.json({ success: true });
  });
  app2.get("/api/audit-log", (_req, res) => {
    res.json({ entries: auditLog.slice(-100) });
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
        console.log(`[SMS VERIFICATION] Code sent to ${phone}`);
      } catch (err) {
        console.error(`[SMS VERIFICATION] Failed to send SMS:`, err?.message || err);
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
    if (!phone || !code) {
      return res.status(400).json({ error: "Phone and code required" });
    }
    const key = `phone:${phone.trim()}`;
    const stored = verificationCodes.get(key);
    if (!stored) {
      return res.json({ verified: false, error: "No code sent. Please request a new one." });
    }
    if (Date.now() > stored.expiresAt) {
      verificationCodes.delete(key);
      return res.json({ verified: false, error: "Code expired. Please request a new one." });
    }
    if (stored.code !== code.trim()) {
      return res.json({ verified: false, error: "Incorrect code. Please try again." });
    }
    verificationCodes.delete(key);
    res.json({ verified: true });
  });
  app2.post("/api/send-email-code", async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email required" });
    }
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
              <p style="color: #666; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
            </div>
          </div>`
        });
        console.log(`[EMAIL VERIFICATION] Code sent to ${email}`);
      } catch (err) {
        console.error(`[EMAIL VERIFICATION] Failed to send email:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code. Please try again." });
      }
    } else {
      console.log(`[EMAIL VERIFICATION] SMTP not configured. Code for ${email}: ${code}`);
    }
    const isDev = process.env.NODE_ENV === "development";
    res.json({ success: true, message: "Verification code sent to your email.", ...isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoCode: code } : {} });
  });
  app2.post("/api/verify-email-code", (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code required" });
    }
    const key = `email:${email.trim().toLowerCase()}`;
    const stored = verificationCodes.get(key);
    if (!stored) {
      return res.json({ verified: false, error: "No code sent. Please request a new one." });
    }
    if (Date.now() > stored.expiresAt) {
      verificationCodes.delete(key);
      return res.json({ verified: false, error: "Code expired. Please request a new one." });
    }
    if (stored.code !== code.trim()) {
      return res.json({ verified: false, error: "Incorrect code. Please try again." });
    }
    verificationCodes.delete(key);
    res.json({ verified: true });
  });
  app2.post("/api/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email address is required." });
      }
      const user = await storage.getUserByEmail(email.trim().toLowerCase());
      if (!user) {
        return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent." });
      }
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
      const htmlBody = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">LabTrax</h2>
          <p style="margin: 4px 0 0; opacity: 0.85;">Password Reset</p>
        </div>
        <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi ${user.username},</p>
          <p>We received a request to reset your password. Click the link below to set a new password:</p>
          <p style="text-align: center; margin: 24px 0;">
            <a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a>
          </p>
          <p style="color: #666; font-size: 13px;">This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>
          <p style="color: #666; font-size: 13px;">Your username is: <strong>${user.username}</strong></p>
        </div>
      </div>`;
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
          html: htmlBody
        });
        console.log(`[EMAIL] Password reset email sent to ${user.email}`);
      } else {
        console.log(`[EMAIL] SMTP not configured. Password reset link for ${user.email}: ${resetLink}`);
      }
      const isDev = process.env.NODE_ENV === "development";
      res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent.", ...isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoResetLink: resetLink } : {} });
    } catch (error) {
      console.error("Forgot password error:", error?.message || error);
      res.status(500).json({ error: "Failed to process request. Please try again." });
    }
  });
  app2.post("/api/forgot-username", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email address is required." });
      }
      const user = await storage.getUserByEmail(email.trim().toLowerCase());
      if (!user) {
        return res.json({ success: true, message: "If an account with that email exists, your username has been sent." });
      }
      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";
      const htmlBody = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">LabTrax</h2>
          <p style="margin: 4px 0 0; opacity: 0.85;">Username Recovery</p>
        </div>
        <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi,</p>
          <p>You requested your username for the account associated with this email address.</p>
          <p style="text-align: center; margin: 24px 0;">
            <span style="display: inline-block; background: #F0F4FF; padding: 12px 32px; border-radius: 8px; font-size: 18px; font-weight: bold; color: #4A6CF7;">${user.username}</span>
          </p>
          <p style="color: #666; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      </div>`;
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
          html: htmlBody
        });
        console.log(`[EMAIL] Username recovery email sent to ${user.email}`);
      } else {
        console.log(`[EMAIL] SMTP not configured. Username for ${user.email}: ${user.username}`);
      }
      const isDev = process.env.NODE_ENV === "development";
      res.json({ success: true, message: "If an account with that email exists, your username has been sent.", ...isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoUsername: user.username } : {} });
    } catch (error) {
      console.error("Forgot username error:", error?.message || error);
      res.status(500).json({ error: "Failed to process request. Please try again." });
    }
  });
  app2.post("/api/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        return res.status(400).json({ error: "Token and new password are required." });
      }
      if (typeof newPassword !== "string" || newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)) {
        return res.status(400).json({ error: "Password must be at least 8 characters with uppercase, lowercase, number, and special character." });
      }
      const resetData = passwordResetTokens.get(token);
      if (!resetData) {
        return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
      }
      if (Date.now() > resetData.expiresAt) {
        passwordResetTokens.delete(token);
        return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
      }
      const user = await storage.getUser(resetData.userId);
      if (!user) {
        passwordResetTokens.delete(token);
        return res.status(400).json({ error: "Account not found." });
      }
      await storage.updateUser(user.id, { password: newPassword });
      passwordResetTokens.delete(token);
      console.log(`[AUTH] Password reset successful for user: ${user.username}`);
      res.json({ success: true, message: "Password has been reset successfully. You can now sign in with your new password." });
    } catch (error) {
      console.error("Reset password error:", error?.message || error);
      res.status(500).json({ error: "Failed to reset password. Please try again." });
    }
  });
  app2.post("/api/register", async (req, res) => {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }
    res.json({ success: true });
  });
  const unsupportedMimeTypes = ["image/heic", "image/heif"];
  const unsupportedExtensions = [".heic", ".heif"];
  function isUnsupportedImageFormat(dataUri) {
    const lower = dataUri.toLowerCase();
    return unsupportedMimeTypes.some((mime) => lower.startsWith(`data:${mime}`)) || unsupportedExtensions.some((ext) => lower.includes(ext));
  }
  app2.post("/api/analyze-prescription", async (req, res) => {
    try {
      let flipLastFirst2 = function(name) {
        if (!name || !name.includes(","))
          return name;
        const parts = name.split(",").map((s) => s.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          return `${parts[1]} ${parts[0]}`;
        }
        return name;
      };
      var flipLastFirst = flipLastFirst2;
      console.log("Prescription analysis request received, body keys:", Object.keys(req.body || {}), "content-type:", req.headers["content-type"]);
      const { imageBase64, additionalImages } = req.body;
      if (!imageBase64) {
        console.log("No image in body, body size:", JSON.stringify(req.body || {}).length);
        return res.status(400).json({ error: "No image provided" });
      }
      if (isUnsupportedImageFormat(imageBase64)) {
        console.log("Unsupported image format detected (HEIC/HEIF)");
        return res.status(400).json({
          error: "HEIC/HEIF images are not supported yet. Please upload a JPG or PNG."
        });
      }
      if (Array.isArray(additionalImages)) {
        for (const img of additionalImages) {
          if (isUnsupportedImageFormat(img)) {
            console.log("Unsupported additional image format detected (HEIC/HEIF)");
            return res.status(400).json({
              error: "HEIC/HEIF images are not supported yet. Please upload a JPG or PNG."
            });
          }
        }
      }
      const totalPages = 1 + (Array.isArray(additionalImages) ? additionalImages.length : 0);
      console.log("Analyzing prescription, pages:", totalPages, "primary image length:", imageBase64.length);
      let imgMime = "image/jpeg";
      if (imageBase64.startsWith("data:image/png"))
        imgMime = "image/png";
      else if (imageBase64.startsWith("data:image/webp"))
        imgMime = "image/webp";
      const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:${imgMime};base64,${imageBase64}`;
      const imageContentParts = [];
      if (totalPages > 1) {
        imageContentParts.push({
          type: "text",
          text: `This dental prescription has ${totalPages} pages. Analyze ALL pages together as a single prescription and combine the information from every page into one unified result. Page 1:`
        });
      } else {
        imageContentParts.push({
          type: "text",
          text: "Analyze this dental prescription document thoroughly. The image may be a photo taken of a paper prescription, a screenshot, a scanned document, or a digital prescription from software like iTero, 3Shape, Medit, etc. The image may be rotated, skewed, low contrast, or partially blurry - do your best to read ALL text regardless of image quality. Extract ALL visible information: doctor name, patient full name, case/restoration type, tooth numbers, shade, material, due date, rush status, and any notes or special instructions. Read all handwritten and printed text carefully, even if faint or at an angle."
        });
      }
      imageContentParts.push({
        type: "image_url",
        image_url: { url: dataUrl, detail: "high" }
      });
      if (Array.isArray(additionalImages)) {
        additionalImages.forEach((img, idx) => {
          const additionalDataUrl = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
          imageContentParts.push({
            type: "text",
            text: `Page ${idx + 2}:`
          });
          imageContentParts.push({
            type: "image_url",
            image_url: { url: additionalDataUrl, detail: "high" }
          });
        });
      }
      const models = ["gpt-4o", "gpt-4o-mini"];
      let response = null;
      let lastModelErr = null;
      const multiPageNote = totalPages > 1 ? `

MULTI-PAGE PRESCRIPTION: You are receiving ${totalPages} pages from the same prescription. Combine information from ALL pages into a single unified result. If the same field appears on multiple pages, use the most complete/detailed value. Merge tooth numbers, notes, and instructions from all pages.` : "";
      const visionMessages = [
        {
          role: "system",
          content: `You are a dental prescription/lab slip document analyzer. Your job is to carefully read dental prescription forms from ALL platforms (handwritten paper Rx, iTero, 3Shape, Medit, Carestream, Dentrix, EagleSoft, etc.) and extract ALL information. Read every word on the document carefully.${multiPageNote}

Return ONLY valid JSON with these fields:
{
  "doctorName": "full doctor/dentist/provider name with Dr. prefix. ALWAYS output as: Dr. FirstName LastName. Look for Provider, Doctor, Dentist, or Clinician fields.",
  "patientName": "full patient name. ALWAYS output as: FirstName LastName (first name first, last name last)",
  "caseType": "one of: Restorative, Removable, Appliance, Temporary - determine from the type of work described (crowns/bridges/veneers/inlays/onlays = Restorative, dentures/partials = Removable, retainers/guards/splints = Appliance, temps/provisionals = Temporary)",
  "toothIndices": "tooth numbers in format #8, #9, #10 - look for tooth numbers, tooth chart markings, tooth diagrams, Treatment Information tables, or FDI notation and convert to American numbering 1-32",
  "shade": "dental shade like A1, A2, A3, B1, B2, C1, etc. - look for shade, color, Vita shade, or shade columns in treatment tables",
  "material": "one of: Zirconia, E.max, PFM, Gold, Semi Precious, Full Cast - determine from material descriptions (zirconia/ceramic translucent zirconia = Zirconia, lithium disilicate/emax = E.max, porcelain fused to metal = PFM, full gold/high noble = Gold, semi precious/noble metal = Semi Precious, full cast/base metal = Full Cast). If material cannot be determined from the main fields, check the notes section for material clues.",
  "dueDate": "due date in MM/DD/YYYY format if visible - look for Due Date, Date Needed, Ship Date, Return By",
  "isRush": false,
  "toothDiagram": "array of tooth numbers (1-32) that are marked, circled, highlighted, crossed out, or indicated on ANY tooth diagram/chart on the prescription. Example: [10, 11]. If no tooth diagram is present, use empty array []",
  "practiceName": "dental practice/office/group name if visible (e.g., 'CWD Dental Group', 'Sunshine Dental'). Look for letterhead, logo text, From: field, or footer branding.",
  "practiceAddress": "full practice/office address if visible (street, city, state, zip). Look for letterhead, From: field, or printed address block.",
  "practicePhone": "practice/office phone number if visible. Look for letterhead, contact info, or printed phone number.",
  "notes": "ONLY clinical instructions, special notes, treatment specifications, and procedure type (Fixed Restorative, etc.). Do NOT include practice name, practice address, doctor address, phone numbers, fax numbers, license numbers, or any contact/office information in notes.",
  "description": "brief summary of the prescription"
}

CRITICAL NAME FORMAT RULES:
- Many digital platforms (iTero, 3Shape, etc.) list names as "LastName, FirstName" (e.g., "Patient: Lewis, Bradley" or "Doctor: Montalvo, Ray")
- You MUST convert ALL names to FirstName LastName format (e.g., "Bradley Lewis", "Dr. Ray Montalvo")
- If you see "Patient: Lewis, Bradley" \u2192 output patientName as "Bradley Lewis"
- If you see "Doctor: Dr. Montalvo, Ray" \u2192 output doctorName as "Dr. Ray Montalvo"
- If a name has a comma, the part BEFORE the comma is the last name, the part AFTER is the first name
- Always add "Dr." prefix to the doctor name if not already present

IMPORTANT RULES:
- Read ALL text carefully, including printed text, labels, headers, and table data
- Look for Treatment Information tables that contain tooth numbers, materials, shades
- If a field cannot be determined, use an empty string ""
- For material, default to "Zirconia" if unclear. "Ceramic Translucent Zirconia" = "Zirconia"
- For isRush, set to true if you see RUSH, ASAP, URGENT, or similar urgency indicators
- Include ALL notes and instructions in the notes field
- Patient name is CRITICAL - look for "Patient:", "Patient Name:" labels specifically
- Doctor name is CRITICAL - look for "Doctor:", "Provider:", "Dentist:", "Clinician:", "Referring Doctor:" labels specifically. The "Provider" field on a prescription IS the doctor's name.
- Tooth numbers should use American dental numbering (1-32)
- Look at the ENTIRE document including headers, footers, tables, and sidebars`
        },
        {
          role: "user",
          content: imageContentParts
        }
      ];
      for (const model of models) {
        try {
          console.log("Trying model:", model);
          response = await openai.chat.completions.create({
            model,
            messages: visionMessages,
            max_tokens: 2e3
          });
          console.log("Model", model, "succeeded");
          break;
        } catch (modelErr) {
          console.log("Model", model, "failed:", modelErr?.message);
          lastModelErr = modelErr;
        }
      }
      if (!response) {
        throw lastModelErr || new Error("All models failed");
      }
      const content = response.choices[0]?.message?.content || "{}";
      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch {
        parsed = {
          doctorName: "",
          patientName: "",
          caseType: "",
          toothIndices: "",
          shade: "",
          material: "Zirconia",
          dueDate: "",
          isRush: false,
          notes: "",
          description: content
        };
      }
      let doctorName = parsed.doctorName || "";
      let patientName = parsed.patientName || "";
      doctorName = flipLastFirst2(doctorName);
      patientName = flipLastFirst2(patientName);
      if (doctorName && !doctorName.toLowerCase().startsWith("dr")) {
        doctorName = "Dr. " + doctorName;
      }
      let toothStr = "";
      if (parsed.toothIndices) {
        if (Array.isArray(parsed.toothIndices)) {
          toothStr = parsed.toothIndices.map((t) => `#${t}`).join(", ");
        } else {
          toothStr = String(parsed.toothIndices);
        }
      }
      let caseType = parsed.caseType || "";
      if (caseType === "Crown" || caseType === "Bridge" || caseType === "Veneer" || caseType === "Inlay" || caseType === "Onlay" || caseType.toLowerCase().includes("restorative") || caseType.toLowerCase().includes("crown")) {
        caseType = "Restorative";
      }
      console.log("AI extracted - Doctor:", doctorName, "Patient:", patientName, "Teeth:", toothStr);
      res.json({
        success: true,
        data: {
          doctorName,
          patientName,
          patientInitials: parsed.patientInitials || "",
          caseType,
          toothIndices: toothStr,
          shade: parsed.shade || "",
          material: parsed.material || "Zirconia",
          dueDate: parsed.dueDate || "",
          isRush: parsed.isRush || false,
          notes: parsed.notes || "",
          practiceName: parsed.practiceName || "",
          practiceAddress: parsed.practiceAddress || "",
          practicePhone: parsed.practicePhone || "",
          description: parsed.description || "Prescription analyzed"
        }
      });
    } catch (error) {
      const errorMsg = error?.message || String(error);
      console.log("Prescription analysis error:", errorMsg);
      if (error?.response) {
        console.log("OpenAI response status:", error.response.status);
      }
      res.status(500).json({
        error: "Failed to analyze prescription",
        fallback: true
      });
    }
  });
  app2.post("/api/send-statement-email", async (req, res) => {
    try {
      const { clientName, clientEmail, adminEmail, subject, body } = req.body;
      if (!clientEmail && !adminEmail) {
        return res.status(400).json({ error: "At least one email recipient is required." });
      }
      const recipients = [];
      if (clientEmail)
        recipients.push(clientEmail);
      if (adminEmail && adminEmail !== clientEmail)
        recipients.push(adminEmail);
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = process.env.SMTP_PORT;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";
      if (!smtpHost || !smtpUser || !smtpPass) {
        console.log(`[EMAIL] SMTP not configured. Statement email would be sent to: ${recipients.join(", ")}`);
        console.log(`[EMAIL] Subject: ${subject}`);
        console.log(`[EMAIL] Body:
${body}`);
        return res.json({
          success: true,
          message: `Statement emailed to ${recipients.join(" and ")}`,
          note: "SMTP not configured - email logged to console"
        });
      }
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort || "587"),
        secure: (smtpPort || "587") === "465",
        auth: { user: smtpUser, pass: smtpPass }
      });
      await transporter.sendMail({
        from: smtpFrom,
        to: recipients.join(", "),
        subject: subject || `Statement for ${clientName || "Client"}`,
        text: body,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">LabTrax</h2>
            <p style="margin: 4px 0 0; opacity: 0.85;">Billing Statement</p>
          </div>
          <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
            <pre style="white-space: pre-wrap; font-family: Arial, sans-serif; font-size: 14px; color: #333;">${body}</pre>
          </div>
        </div>`
      });
      console.log(`[EMAIL] Statement sent to: ${recipients.join(", ")}`);
      return res.json({ success: true, message: `Statement emailed to ${recipients.join(" and ")}` });
    } catch (error) {
      console.error("[EMAIL] Error sending statement email:", error?.message || error);
      return res.status(500).json({ error: "Failed to send email", details: error?.message });
    }
  });
  app2.post("/api/ai-chat", async (req, res) => {
    try {
      const { message, caseContext } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message required" });
      }
      const systemPrompt = `You are LabTrax's AI assistant for dental laboratory case management. You help dental office staff and lab technicians with questions about their cases, procedures, materials, and lab workflows.

You have access to the following case information from the lab:
${caseContext || "No specific case data provided."}

Key knowledge:
- Lab stations: Intake, Design, Porcelain, QC (Quality Check), Ship, Hold, Complete
- Materials: Zirconia ($250/unit), E.max ($300/unit), PFM ($200/unit), Gold ($400/unit)
- Case types: Restorative (crowns, bridges, veneers), Removable (dentures, partials), Appliance (retainers, guards), Temporary (provisionals)
- American dental numbering system (1-32)

Be helpful, concise, and professional. If asked about a specific case, reference the case data provided. If no case data is available, provide general dental lab information.`;
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        max_tokens: 500
      });
      const reply = response.choices[0]?.message?.content || "I'm sorry, I couldn't process your request.";
      res.json({ success: true, reply });
    } catch (error) {
      console.error("AI chat error:", error?.message || error);
      res.status(500).json({ error: "Failed to process chat message" });
    }
  });
  app2.post("/api/send-case-update-text", (req, res) => {
    const { providerName, providerPhone, caseNumber, patientName, status, message } = req.body;
    if (!providerPhone || !caseNumber || !status) {
      return res.status(400).json({ error: "Provider phone, case number, and status are required." });
    }
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioSid || !twilioToken || !twilioFrom) {
      console.log(`[SMS] Twilio not configured. Case update text would be sent to: ${providerPhone}`);
      console.log(`[SMS] Provider: ${providerName}`);
      console.log(`[SMS] Message: ${message}`);
      return res.json({
        success: true,
        message: `Case update text sent to ${providerPhone}`,
        note: "Twilio not configured - SMS logged to console"
      });
    }
    const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const params = new URLSearchParams();
    params.append("To", providerPhone);
    params.append("From", twilioFrom);
    params.append("Body", message);
    globalThis.fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    }).then((r) => r.json()).then((data) => {
      console.log(`[SMS] Case update text sent to ${providerPhone} for case ${caseNumber}`);
      res.json({ success: true, message: `Text sent to ${providerPhone}` });
    }).catch((err) => {
      console.error("[SMS] Error sending text:", err?.message || err);
      res.status(500).json({ error: "Failed to send text", details: err?.message });
    });
  });
  app2.post("/api/crop-document", async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }
      let base64Data;
      let rawBuffer;
      let rotatedBuffer;
      let rotatedDataUrl;
      try {
        base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        rawBuffer = Buffer.from(base64Data, "base64");
        if (rawBuffer.length < 100) {
          console.error("[Crop Document] Image buffer too small:", rawBuffer.length);
          return res.status(400).json({ error: "Unable to process this image. Please upload a JPG or PNG." });
        }
      } catch (decodeErr) {
        console.error("[Crop Document] Base64 decode failed:", decodeErr?.message);
        return res.status(400).json({ error: "Unable to process this image. Please upload a JPG or PNG." });
      }
      try {
        rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
        const rotatedBase64 = rotatedBuffer.toString("base64");
        rotatedDataUrl = `data:image/jpeg;base64,${rotatedBase64}`;
      } catch (sharpErr) {
        console.error("[Crop Document] Sharp rotation failed:", sharpErr?.message);
        return res.status(500).json({ error: "Unable to process this image. Please upload a JPG or PNG." });
      }
      let aiResult = null;
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are a professional document scanner like OneDrive, Adobe Scan, or CamScanner. Your job is to detect any document (paper, form, prescription, letter, card, receipt, etc.) in the photo and return TIGHT crop coordinates that isolate ONLY the document.

CRITICAL RULES:
- Crop coordinates MUST tightly hug the edges of the document paper/card only.
- Remove ALL background: desk surface, table, hands, fingers, shadows, other objects.
- The crop should contain ONLY the document \u2014 nothing else.
- Use percentage coordinates (0-100) of the full image dimensions.
- Add only a tiny 0.5% margin around the document edges.

Return ONLY valid JSON:
{
  "documentDetected": true,
  "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 },
  "rotation": 0,
  "documentType": "prescription" | "form" | "letter" | "card" | "receipt" | "other"
}

rotation values: 0 = already upright, 90 = rotate 90\xB0 clockwise, 180 = upside down, 270 = rotate 90\xB0 counter-clockwise.

If NO document is detected:
{
  "documentDetected": false,
  "crop": null,
  "rotation": 0,
  "documentType": null
}`
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Detect the document in this photo. Return precise crop coordinates that tightly isolate ONLY the document paper, removing all background (desk, table, hands, etc)." },
                { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } }
              ]
            }
          ],
          max_tokens: 250
        });
        const text2 = response.choices?.[0]?.message?.content || "";
        const jsonMatch = text2.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiResult = JSON.parse(jsonMatch[0]);
        }
      } catch (aiErr) {
        console.error("[Crop Document] AI analysis failed:", aiErr?.message);
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }
      if (!aiResult || !aiResult.documentDetected || !aiResult.crop) {
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }
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
        if (rotation === 90 || rotation === 180 || rotation === 270) {
          pipeline = pipeline.rotate(rotation);
        }
        const croppedBuffer = await pipeline.sharpen({ sigma: 1.2 }).normalize().jpeg({ quality: 92 }).toBuffer();
        const croppedBase64 = `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`;
        console.log(`[Crop] Document detected: ${aiResult.documentType}, rotation: ${rotation}\xB0, crop: ${cropW}x${cropH}`);
        return res.json({ documentDetected: true, croppedImageBase64: croppedBase64, documentType: aiResult.documentType });
      } catch (cropErr) {
        console.error("[Crop Document] Crop/extract failed:", cropErr?.message);
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }
    } catch (err) {
      console.error("[Crop Document] Unexpected error:", err?.message || err);
      return res.status(500).json({ error: "Unable to process this image. Please upload a JPG or PNG." });
    }
  });
  app2.post("/api/document-to-pdf", async (req, res) => {
    try {
      const { images } = req.body;
      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: "No images provided" });
      }
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
        } catch (imgErr) {
          console.log("[PDF] Skipping invalid image:", imgErr?.message);
        }
      }
      if (pageImages.length === 0) {
        return res.status(400).json({ error: "No valid images could be processed" });
      }
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
      const kidsStr = pageObjIds.map((id) => `${id} 0 R`).join(" ");
      objStrs.push({ id: pagesId, str: `${pagesId} 0 obj
<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjIds.length} >>
endobj
` });
      for (let i = 0; i < pageImages.length; i++) {
        const pg2 = pageImages[i];
        const scale = Math.min((PDF_W - MARGIN * 2) / pg2.width, (PDF_H - MARGIN * 2) / pg2.height);
        const drawW = Math.round(pg2.width * scale);
        const drawH = Math.round(pg2.height * scale);
        const drawX = Math.round((PDF_W - drawW) / 2);
        const drawY = Math.round((PDF_H - drawH) / 2);
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
            const headerBuf = Buffer.from(obj.str);
            const imgBuf = pageImages[imgIdx].buffer;
            const endBuf = Buffer.from("\nendstream\nendobj\n");
            output = Buffer.concat([output, headerBuf, imgBuf, endBuf]);
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
      for (let i = 1; i <= objCount; i++) {
        xrefStr += `${String(xrefOffsets[i]).padStart(10, "0")} 00000 n 
`;
      }
      xrefStr += `trailer
<< /Size ${objCount + 1} /Root ${catalogId} 0 R >>
startxref
${xrefOffset}
%%EOF
`;
      output = Buffer.concat([output, Buffer.from(xrefStr)]);
      const pdfBase64 = `data:application/pdf;base64,${output.toString("base64")}`;
      console.log(`[PDF] Generated ${pageImages.length}-page PDF, size: ${(output.length / 1024).toFixed(1)}KB`);
      res.json({ success: true, pdfBase64, pageCount: pageImages.length });
    } catch (err) {
      console.error("[Document to PDF] Error:", err?.message || err);
      res.status(500).json({ error: "PDF generation failed" });
    }
  });
  app2.post("/api/smile-process", async (req, res) => {
    try {
      const { imageBase64, mode } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }
      let prompt = "";
      if (mode === "whiten") {
        prompt = "Edit this photo to whiten and brighten the person's teeth to a natural, beautiful Hollywood-white shade. Make the teeth look naturally white and healthy \u2014 NOT cartoon-like or overly artificial. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only change the color of the visible teeth to be whiter and brighter. The result must look like a real photograph, not digitally manipulated.";
      } else if (mode === "symmetry") {
        prompt = "Edit this photo to make the person's visible teeth perfectly symmetrical and even. Straighten any crooked teeth, even out spacing, and make the teeth appear uniform and aligned \u2014 as if the person had perfect orthodontic work done. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only modify the teeth alignment and symmetry. The result must look like a real photograph.";
      } else if (mode === "both") {
        prompt = "Edit this photo to: 1) Whiten and brighten the person's teeth to a natural Hollywood-white shade, AND 2) Make the teeth perfectly symmetrical, even, and straight \u2014 as if they had perfect orthodontic work and professional whitening. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only change the teeth color and alignment. The result must look like a real photograph, not digitally manipulated.";
      } else {
        return res.status(400).json({ error: "Invalid mode. Use 'whiten', 'symmetry', or 'both'." });
      }
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      const response = await openai.images.edit({
        model: "gpt-image-1",
        image: imgBuffer,
        prompt,
        size: "1024x1024"
      });
      const outputBase64 = response.data?.[0]?.b64_json;
      if (!outputBase64) {
        return res.status(500).json({ error: "AI did not return an image." });
      }
      res.json({ imageBase64: `data:image/png;base64,${outputBase64}` });
    } catch (err) {
      console.error("[Smile Process] Error:", err?.message || err);
      res.status(500).json({ error: "Failed to process image", details: err?.message });
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
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
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
function serveExpoManifest(platform, res) {
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
  const manifest = fs.readFileSync(manifestPath, "utf-8");
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
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      if (devDomain) {
        return res.redirect(`https://${devDomain}:8081`);
      }
      const indexPath = path.resolve(process.cwd(), "static-build", "index.html");
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
      return res.redirect("/");
    }
    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }
    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
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
  app2.use(express.static(path.resolve(process.cwd(), "static-build")));
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
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
  const storage2 = new DatabaseStorage();
  const accounts = [
    { username: "phillipsjohnpaul@yahoo.com", password: "Jp#14482726", email: "phillipsjohnpaul@yahoo.com", userType: "lab", role: "admin" },
    { username: "test@allieddl.com", password: "Test1234", email: "test@allieddl.com", userType: "lab", role: "admin" }
  ];
  for (const acct of accounts) {
    try {
      const existing = await storage2.getUserByUsername(acct.username);
      if (!existing) {
        await storage2.createUser(acct);
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
