var __defProp = Object.defineProperty;
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

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  insertUserSchema: () => insertUserSchema,
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
var pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
var db = drizzle(pool, { schema: schema_exports });

// server/storage.ts
import { eq } from "drizzle-orm";
var DatabaseStorage = class {
  async getUser(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }
  async getUserByUsername(username) {
    const allUsers = await db.select().from(users);
    return allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
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
};
var storage = new DatabaseStorage();

// server/routes.ts
var openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
});
var verificationCodes = /* @__PURE__ */ new Map();
function generateCode() {
  return Math.floor(1e5 + Math.random() * 9e5).toString();
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
  app2.put("/api/auth/users/:id/password", async (req, res) => {
    try {
      const { id } = req.params;
      const { currentPassword, newPassword } = req.body;
      const user = await storage.getUser(id);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.password !== currentPassword) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      await storage.updateUser(id, { password: newPassword });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update password" });
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
    if (auditLog.length > 1e4) auditLog.splice(0, auditLog.length - 1e4);
    res.json({ success: true });
  });
  app2.get("/api/audit-log", (_req, res) => {
    res.json({ entries: auditLog.slice(-100) });
  });
  app2.post("/api/send-phone-code", (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }
    const code = generateCode();
    const key = `phone:${phone.trim()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1e3 });
    console.log(`[SMS VERIFICATION] Code for ${phone}: ${code}`);
    res.json({ success: true, message: "Verification code sent via SMS.", demoCode: code });
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
  app2.post("/api/send-email-code", (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email required" });
    }
    const code = generateCode();
    const key = `email:${email.trim().toLowerCase()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1e3 });
    console.log(`[EMAIL VERIFICATION] Code for ${email}: ${code}`);
    res.json({ success: true, message: "Verification code sent to your email.", demoCode: code });
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
  app2.post("/api/register", async (req, res) => {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }
    res.json({ success: true });
  });
  app2.post("/api/analyze-prescription", async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }
      const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a dental prescription/lab slip document analyzer. Your job is to carefully read handwritten or printed dental prescription forms and extract ALL information. Read every word on the document carefully.

Return ONLY valid JSON with these fields:
{
  "doctorName": "full doctor/dentist name including Dr. prefix - look for fields labeled Doctor, Dentist, DDS, DMD, or the practice/office name",
  "patientName": "full patient name - look for fields labeled Patient, Patient Name, Pt, or similar",
  "caseType": "one of: Restorative, Removable, Appliance, Temporary - determine from the type of work described (crowns/bridges/veneers = Restorative, dentures/partials = Removable, retainers/guards = Appliance, temps/provisionals = Temporary)",
  "toothIndices": "tooth numbers in format #8, #9, #10 - look for tooth numbers, tooth chart markings, or FDI notation and convert to American numbering 1-32",
  "shade": "dental shade like A1, A2, A3, B1, B2, C1, etc. - look for shade, color, or Vita shade references",
  "material": "one of: Zirconia, E.max, PFM, Gold - determine from material descriptions like zirconia, lithium disilicate, porcelain fused to metal, full gold, etc.",
  "dueDate": "due date in MM/DD/YYYY format if visible - look for Due Date, Date Needed, Ship Date, Return By",
  "isRush": false,
  "notes": "ALL other instructions, special notes, or comments written by the doctor including margin notes, preparation details, contact preferences, or any other text on the form",
  "description": "brief summary of the prescription"
}

IMPORTANT RULES:
- Read ALL handwritten text carefully, even if partially legible
- If a field cannot be determined, use an empty string ""
- For material, default to "Zirconia" if unclear
- For isRush, set to true if you see RUSH, ASAP, URGENT, or similar urgency indicators
- Include ALL notes and instructions in the notes field, even if they seem minor
- Patient name is CRITICAL - look everywhere on the form for it
- Tooth numbers should use American dental numbering (1-32)`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this dental prescription document thoroughly. Extract ALL visible information: doctor name, patient full name, case/restoration type, tooth numbers, shade, material, due date, rush status, and any notes or special instructions. Read all handwritten and printed text carefully."
              },
              {
                type: "image_url",
                image_url: { url: dataUrl, detail: "high" }
              }
            ]
          }
        ],
        max_tokens: 1e3
      });
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
      res.json({
        success: true,
        data: {
          doctorName: parsed.doctorName || "",
          patientName: parsed.patientName || "",
          patientInitials: parsed.patientInitials || "",
          caseType: parsed.caseType || "",
          toothIndices: parsed.toothIndices || "",
          shade: parsed.shade || "",
          material: parsed.material || "Zirconia",
          dueDate: parsed.dueDate || "",
          isRush: parsed.isRush || false,
          notes: parsed.notes || "",
          description: parsed.description || "Prescription analyzed"
        }
      });
    } catch (error) {
      console.error("Prescription analysis error:", error?.message || error);
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
      if (clientEmail) recipients.push(clientEmail);
      if (adminEmail && adminEmail !== clientEmail) recipients.push(adminEmail);
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
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express.urlencoded({ extended: false }));
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
      if (!path2.startsWith("/api")) return;
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
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    next();
  });
}
(async () => {
  setupCors(app);
  setupSecurityHeaders(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  configureExpoAndLanding(app);
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true
    },
    () => {
      log(`express server serving on port ${port}`);
    }
  );
})();
