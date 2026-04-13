import type { Express } from "express";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { db } from "./db";
import { users, labCases, organizations, organizationMemberships } from "../shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { hashPassword } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { requireAuth } from "./middleware/auth";

import authRoutes from "./routes/auth";
import organizationRoutes from "./routes/organizations";
import caseRoutes from "./routes/cases";
import invoiceRoutes from "./routes/invoices";

const verificationCodes = new Map<string, { code: string; expiresAt: number }>();
const passwordResetTokens = new Map<string, { userId: string; expiresAt: number }>();
const DEMO_SEED_USERS_ENABLED = process.env.LABTRAX_ENABLE_DEMO_SEEDS === "true";
let cachedOpenAIClient: OpenAI | null | undefined;

function getOpenAIClient(): OpenAI | null {
  if (cachedOpenAIClient !== undefined) {
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
    ...(baseURL ? { baseURL } : {}),
  });

  return cachedOpenAIClient;
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

const DEFAULT_USERS = [
  { username: "labadmin_demo", password: "LabTraxDemo#2026", userType: "lab", role: "admin", email: "labadmin_demo@labtrax.local", accountNumber: "LAB-001" },
  { username: "labtech_demo", password: "LabTraxDemo#2026", userType: "lab", role: "user", email: "labtech_demo@labtrax.local", accountNumber: "LAB-002" },
  { username: "master_demo", password: "LabTraxDemo#2026", userType: "master_admin", role: "admin", email: "master_demo@labtrax.local", accountNumber: "MA-001" },
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
      email: (def as any).email || null,
      phone: (def as any).phone || null,
      userType: def.userType,
      role: def.role,
      accountNumber: (def as any).accountNumber || null,
      initials: def.username.slice(0, 2).toUpperCase(),
    });
    existingUsernames.add(def.username.toLowerCase());
    console.log(`[SEED] Created demo user: ${def.username}`);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  await seedDefaultUsers();

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get("/api/labs/groups", async (_req, res) => {
    try {
      const orgs = await db
        .select()
        .from(organizations)
        .where(eq(organizations.type, "lab"));

      const memberships = orgs.length
        ? await db
            .select()
            .from(organizationMemberships)
            .where(
              and(
                inArray(
                  organizationMemberships.organizationId,
                  orgs.map((o) => o.id)
                ),
                eq(organizationMemberships.status, "active")
              )
            )
        : [];

      const memberUserIds = [
        ...new Set(memberships.map((m) => m.userId)),
      ];
      const memberUsers = memberUserIds.length
        ? await db
            .select()
            .from(users)
            .where(inArray(users.id, memberUserIds))
        : [];
      const userMap = new Map(memberUsers.map((u) => [u.id, u]));

      const groups = orgs.map((org) => {
        const orgMemberships = memberships.filter(
          (m) => m.organizationId === org.id
        );
        const adminMembership = orgMemberships.find(
          (m) => m.role === "owner" || m.role === "admin"
        );
        const adminUser = adminMembership
          ? userMap.get(adminMembership.userId)
          : undefined;
        return {
          organizationId: org.id,
          practiceName: org.displayName || org.name,
          username: adminUser?.username || "",
          practiceAddress: [org.addressLine1, org.city, org.state, org.zip]
            .filter(Boolean)
            .join(", "),
          memberCount: orgMemberships.length,
        };
      });

      res.json({ groups });
    } catch (error: any) {
      console.error("List lab groups error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch lab groups" });
    }
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/organizations", organizationRoutes);
  app.use("/api/cases", caseRoutes);
  app.use("/api/invoices", invoiceRoutes);

  app.post("/api/audit-log", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const allUsers = await db.select().from(users);
    const existing = allUsers.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    res.json({ available: !existing });
  });

  app.post("/api/legacy/cases", requireAuth, async (req, res) => {
    try {
      const { id, ownerId, caseData } = req.body;
      if (!id || !ownerId || !caseData) {
        return res.status(400).json({ error: "id, ownerId, and caseData are required" });
      }
      await db.insert(labCases).values({
        id,
        ownerId,
        caseData: typeof caseData === "string" ? caseData : JSON.stringify(caseData),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: labCases.id,
        set: { ownerId, caseData: typeof caseData === "string" ? caseData : JSON.stringify(caseData), updatedAt: new Date() },
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Legacy upsert case error:", error?.message || error);
      res.status(500).json({ error: "Failed to save case" });
    }
  });

  app.get("/api/legacy/cases", requireAuth, async (req, res) => {
    try {
      const ownerIdsParam = req.query.ownerIds as string;
      if (!ownerIdsParam) {
        return res.json({ cases: [] });
      }
      const ownerIds = ownerIdsParam.split(",").filter(Boolean);
      if (ownerIds.length === 0) return res.json({ cases: [] });
      const rows = await db.select().from(labCases).where(inArray(labCases.ownerId, ownerIds));
      const cases = rows.map(r => {
        try { return JSON.parse(r.caseData); } catch { return null; }
      }).filter(Boolean);
      res.json({ cases });
    } catch (error: any) {
      console.error("Legacy get cases error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch cases" });
    }
  });

  app.delete("/api/legacy/cases/:caseId", requireAuth, async (req, res) => {
    try {
      const { caseId } = req.params;
      await db.delete(labCases).where(eq(labCases.id, caseId));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Legacy delete case error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete case" });
    }
  });

  app.post("/api/send-phone-code", async (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }
    const code = generateCode();
    const key = `phone:${phone.trim()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

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
          body: params.toString(),
        });
        const twilioData = await twilioResp.json() as any;
        if (twilioData.error_code) {
          console.error(`[SMS VERIFICATION] Twilio error: ${twilioData.message}`);
          return res.status(500).json({ error: "Failed to send verification code. Please try again." });
        }
      } catch (err: any) {
        console.error(`[SMS VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code. Please try again." });
      }
    } else {
      console.log(`[SMS VERIFICATION] Twilio not configured. Code for ${phone}: ${code}`);
    }

    const isDev = process.env.NODE_ENV === "development";
    res.json({ success: true, message: "Verification code sent via SMS.", ...(isDev && (!twilioSid || !twilioToken || !twilioFrom) ? { demoCode: code } : {}) });
  });

  app.post("/api/verify-phone-code", (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "Phone and code required" });
    const key = `phone:${phone.trim()}`;
    const stored = verificationCodes.get(key);
    if (!stored) return res.json({ verified: false, error: "No code sent. Please request a new one." });
    if (Date.now() > stored.expiresAt) { verificationCodes.delete(key); return res.json({ verified: false, error: "Code expired." }); }
    if (stored.code !== code.trim()) return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    res.json({ verified: true });
  });

  app.post("/api/send-email-code", async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") return res.status(400).json({ error: "Email required" });
    const code = generateCode();
    const key = `email:${email.trim().toLowerCase()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

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
          auth: { user: smtpUser, pass: smtpPass },
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
          </div>`,
        });
      } catch (err: any) {
        console.error(`[EMAIL VERIFICATION] Failed:`, err?.message || err);
        return res.status(500).json({ error: "Failed to send verification code." });
      }
    } else {
      console.log(`[EMAIL VERIFICATION] SMTP not configured. Code for ${email}: ${code}`);
    }

    const isDev = process.env.NODE_ENV === "development";
    res.json({ success: true, message: "Verification code sent.", ...(isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoCode: code } : {}) });
  });

  app.post("/api/verify-email-code", (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code required" });
    const key = `email:${email.trim().toLowerCase()}`;
    const stored = verificationCodes.get(key);
    if (!stored) return res.json({ verified: false, error: "No code sent." });
    if (Date.now() > stored.expiresAt) { verificationCodes.delete(key); return res.json({ verified: false, error: "Code expired." }); }
    if (stored.code !== code.trim()) return res.json({ verified: false, error: "Incorrect code." });
    verificationCodes.delete(key);
    res.json({ verified: true });
  });

  app.post("/api/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent." });

      const token = generateResetToken();
      passwordResetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });

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
          host: smtpHost, port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465", auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: smtpFrom, to: user.email!,
          subject: "LabTrax - Password Reset",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Password Reset</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Hi ${user.username},</p><p>Click below to reset your password:</p>
              <p style="text-align: center; margin: 24px 0;"><a href="${resetLink}" style="display: inline-block; background: #4A6CF7; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a></p>
              <p style="color: #666; font-size: 13px;">Expires in 30 minutes. Username: <strong>${user.username}</strong></p>
            </div></div>`,
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Reset link for ${user.email}: ${resetLink}`);
      }

      const isDev = process.env.NODE_ENV === "development";
      res.json({ success: true, message: "If an account with that email exists, a password reset link has been sent.", ...(isDev && (!smtpHost || !smtpUser || !smtpPass) ? { demoResetLink: resetLink } : {}) });
    } catch (error: any) {
      console.error("Forgot password error:", error?.message || error);
      res.status(500).json({ error: "Failed to process request." });
    }
  });

  app.post("/api/forgot-username", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") return res.status(400).json({ error: "Email address is required." });
      const allUsers = await db.select().from(users);
      const user = allUsers.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
      if (!user) return res.json({ success: true, message: "If an account with that email exists, your username has been sent." });

      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;
      const smtpPort = process.env.SMTP_PORT;
      const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@labtrax.com";

      if (smtpHost && smtpUser && smtpPass) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: parseInt(smtpPort || "587"),
          secure: (smtpPort || "587") === "465", auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({
          from: smtpFrom, to: user.email!,
          subject: "LabTrax - Username Recovery",
          html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
            <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;"><h2 style="margin:0;">LabTrax</h2><p style="margin:4px 0 0; opacity:0.85;">Username Recovery</p></div>
            <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
              <p>Your username is: <strong>${user.username}</strong></p>
            </div></div>`,
        });
      } else {
        console.log(`[EMAIL] SMTP not configured. Username for ${user.email}: ${user.username}`);
      }
      res.json({ success: true, message: "If an account with that email exists, your username has been sent." });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to process request." });
    }
  });

  app.post("/api/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required." });
      const resetData = passwordResetTokens.get(token);
      if (!resetData) return res.status(400).json({ error: "Invalid or expired reset token." });
      if (Date.now() > resetData.expiresAt) { passwordResetTokens.delete(token); return res.status(400).json({ error: "Reset token has expired." }); }

      const hashed = await hashPassword(newPassword);
      await db.update(users).set({ password: hashed }).where(eq(users.id, resetData.userId));
      passwordResetTokens.delete(token);
      res.json({ success: true, message: "Password has been reset successfully." });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to reset password." });
    }
  });

  app.post("/api/send-case-update-text", requireAuth, async (req, res) => {
    const { providerPhone, caseNumber, patientName, status, message } = req.body;
    if (!providerPhone || !caseNumber) return res.status(400).json({ error: "Provider phone and case number required" });

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioSid || !twilioToken || !twilioFrom) return res.status(500).json({ error: "Twilio not configured" });

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
        body: params.toString(),
      });
      res.json({ success: true, message: `Text sent to ${providerPhone}` });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to send text" });
    }
  });

  app.post("/api/analyze-prescription", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ success: false, error: "AI integrations are not configured." });

      const { imageBase64, additionalImages } = req.body;
      if (!imageBase64) return res.status(400).json({ success: false, error: "No image provided" });

      const isHEIC = imageBase64.includes("data:image/heic") || imageBase64.includes("data:image/heif");
      if (isHEIC) return res.status(400).json({ success: false, error: "HEIC format is not supported. Please convert to JPEG or PNG first." });

      const imageContents: Array<{ type: "image_url"; image_url: { url: string; detail: "auto" } }> = [];

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
- Return ONLY the JSON object, no other text`;

      const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "auto" } }> = [
        { type: "text", text: `Analyze this dental prescription (${imageContents.length} page${imageContents.length > 1 ? "s" : ""}).` },
        ...imageContents,
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 1000,
        temperature: 0.1,
      });

      const text = response.choices?.[0]?.message?.content || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("AI analyze-prescription: No JSON found in response:", text.substring(0, 200));
        return res.json({ success: false, error: "AI could not parse the prescription" });
      }

      const data = JSON.parse(jsonMatch[0]);

      const cleanedData: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined && value !== "" && value !== "null") {
          cleanedData[key] = value;
        }
      }

      console.log("AI analyze-prescription: Success, fields:", Object.keys(cleanedData).join(", "));
      return res.json({ success: true, data: cleanedData });
    } catch (err: any) {
      console.error("AI analyze-prescription error:", err?.message || err);
      return res.status(500).json({ success: false, error: "AI analysis failed. Please try again." });
    }
  });

  app.post("/api/crop-document", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured." });

      const { imageBase64 } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      let base64Data: string;
      let rawBuffer: Buffer;
      let rotatedBuffer: Buffer;
      let rotatedDataUrl: string;

      try {
        base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        rawBuffer = Buffer.from(base64Data, "base64");
        if (rawBuffer.length < 100) return res.status(400).json({ error: "Unable to process this image." });
      } catch { return res.status(400).json({ error: "Unable to process this image." }); }

      try {
        rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
        rotatedDataUrl = `data:image/jpeg;base64,${rotatedBuffer.toString("base64")}`;
      } catch { return res.status(500).json({ error: "Unable to process this image." }); }

      let aiResult: any = null;
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: `You are a professional document scanner. Detect any document in the photo and return TIGHT crop coordinates that isolate ONLY the document. Use percentage coordinates (0-100). Return ONLY valid JSON: { "documentDetected": true, "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 }, "rotation": 0, "documentType": "prescription" }` },
            { role: "user", content: [
              { type: "text", text: "Detect the document in this photo." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } },
            ]},
          ],
          max_tokens: 250,
        });
        const text = response.choices?.[0]?.message?.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) aiResult = JSON.parse(jsonMatch[0]);
      } catch { return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl }); }

      if (!aiResult?.documentDetected || !aiResult?.crop) return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });

      try {
        const metadata = await sharp(rotatedBuffer).metadata();
        const imgW = metadata.width || 1;
        const imgH = metadata.height || 1;
        const left = Math.max(0, Math.round((aiResult.crop.left / 100) * imgW));
        const top = Math.max(0, Math.round((aiResult.crop.top / 100) * imgH));
        const right = Math.min(imgW, Math.round((aiResult.crop.right / 100) * imgW));
        const bottom = Math.min(imgH, Math.round((aiResult.crop.bottom / 100) * imgH));
        const cropW = Math.max(1, right - left);
        const cropH = Math.max(1, bottom - top);

        let pipeline = sharp(rotatedBuffer).extract({ left, top, width: cropW, height: cropH });
        const rotation = aiResult.rotation || 0;
        if (rotation === 90 || rotation === 180 || rotation === 270) pipeline = pipeline.rotate(rotation);
        const croppedBuffer = await pipeline.sharpen({ sigma: 1.2 }).normalize().jpeg({ quality: 92 }).toBuffer();
        return res.json({ documentDetected: true, croppedImageBase64: `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`, documentType: aiResult.documentType });
      } catch { return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl }); }
    } catch { return res.status(500).json({ error: "Unable to process this image." }); }
  });

  app.post("/api/detect-document", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured." });

      const { imageBase64 } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      let base64Data: string;
      let rotatedDataUrl: string;

      try {
        base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const rawBuffer = Buffer.from(base64Data, "base64");
        if (rawBuffer.length < 100) return res.status(400).json({ error: "Unable to process this image." });
        const rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 85 }).toBuffer();
        rotatedDataUrl = `data:image/jpeg;base64,${rotatedBuffer.toString("base64")}`;
      } catch { return res.status(400).json({ error: "Unable to process this image." }); }

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: `You are a professional document scanner. Detect the document in the photo and return TIGHT crop coordinates as percentages (0-100). Return ONLY valid JSON: { "documentDetected": true, "crop": { "left": 15, "top": 8, "right": 85, "bottom": 92 }, "documentType": "prescription" }. If no document found: { "documentDetected": false }` },
            { role: "user", content: [
              { type: "text", text: "Detect the document edges in this photo." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "auto" } },
            ]},
          ],
          max_tokens: 200,
        });
        const text = response.choices?.[0]?.message?.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return res.json(result);
        }
        return res.json({ documentDetected: false });
      } catch { return res.json({ documentDetected: false }); }
    } catch { return res.status(500).json({ error: "Unable to process this image." }); }
  });

  app.post("/api/apply-crop", requireAuth, async (req, res) => {
    try {
      const { imageBase64, crop } = req.body;
      if (!imageBase64 || !crop) return res.status(400).json({ error: "Image and crop coordinates required" });

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const rawBuffer = Buffer.from(base64Data, "base64");
      const rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
      const metadata = await sharp(rotatedBuffer).metadata();
      const imgW = metadata.width || 1;
      const imgH = metadata.height || 1;

      const left = Math.max(0, Math.round((crop.left / 100) * imgW));
      const top = Math.max(0, Math.round((crop.top / 100) * imgH));
      const right = Math.min(imgW, Math.round((crop.right / 100) * imgW));
      const bottom = Math.min(imgH, Math.round((crop.bottom / 100) * imgH));
      const cropW = Math.max(1, right - left);
      const cropH = Math.max(1, bottom - top);

      const croppedBuffer = await sharp(rotatedBuffer)
        .extract({ left, top, width: cropW, height: cropH })
        .sharpen({ sigma: 1.2 })
        .normalize()
        .jpeg({ quality: 92 })
        .toBuffer();

      return res.json({ croppedImageBase64: `data:image/jpeg;base64,${croppedBuffer.toString("base64")}` });
    } catch { return res.status(500).json({ error: "Unable to crop image." }); }
  });

  app.post("/api/document-to-pdf", requireAuth, async (req, res) => {
    try {
      const { images } = req.body;
      if (!images || !Array.isArray(images) || images.length === 0) return res.status(400).json({ error: "No images provided" });

      const pageImages: { buffer: Buffer; width: number; height: number }[] = [];
      for (const img of images) {
        try {
          if (typeof img !== "string" || (!img.startsWith("data:") && img.length < 100)) continue;
          const b64 = img.replace(/^data:image\/\w+;base64,/, "");
          const buf = Buffer.from(b64, "base64");
          if (buf.length < 100) continue;
          const rotated = await sharp(buf).rotate().jpeg({ quality: 95 }).toBuffer();
          const meta = await sharp(rotated).metadata();
          pageImages.push({ buffer: rotated, width: meta.width || 612, height: meta.height || 792 });
        } catch {}
      }
      if (pageImages.length === 0) return res.status(400).json({ error: "No valid images" });

      const PDF_W = 612;
      const PDF_H = 792;
      const MARGIN = 18;
      let objCount = 0;
      const newObj = () => { objCount++; return objCount; };
      const catalogId = newObj();
      const pagesId = newObj();
      const pageObjIds: number[] = [];
      const imgObjIds: number[] = [];
      const contentObjIds: number[] = [];
      for (const _pg of pageImages) { pageObjIds.push(newObj()); imgObjIds.push(newObj()); contentObjIds.push(newObj()); }

      const objStrs: { id: number; str: string }[] = [];
      objStrs.push({ id: catalogId, str: `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n` });
      objStrs.push({ id: pagesId, str: `${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>\nendobj\n` });

      for (let i = 0; i < pageImages.length; i++) {
        const pg = pageImages[i];
        const scale = Math.min((PDF_W - MARGIN * 2) / pg.width, (PDF_H - MARGIN * 2) / pg.height);
        const drawW = Math.round(pg.width * scale), drawH = Math.round(pg.height * scale);
        const drawX = Math.round((PDF_W - drawW) / 2), drawY = Math.round((PDF_H - drawH) / 2);
        const contentStr = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Img${i} Do\nQ\n`;
        objStrs.push({ id: contentObjIds[i], str: `${contentObjIds[i]} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}endstream\nendobj\n` });
        objStrs.push({ id: pageObjIds[i], str: `${pageObjIds[i]} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_W} ${PDF_H}] /Contents ${contentObjIds[i]} 0 R /Resources << /XObject << /Img${i} ${imgObjIds[i]} 0 R >> >> >>\nendobj\n` });
        objStrs.push({ id: imgObjIds[i], str: `${imgObjIds[i]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.buffer.length} >>\nstream\n` });
      }

      const sortedObjs = objStrs.sort((a, b) => a.id - b.id);
      let output = Buffer.from("%PDF-1.4\n");
      const xrefOffsets: number[] = new Array(objCount + 1).fill(0);
      for (const obj of sortedObjs) {
        xrefOffsets[obj.id] = output.length;
        if (obj.str.includes("/DCTDecode")) {
          const imgIdx = imgObjIds.indexOf(obj.id);
          if (imgIdx >= 0) {
            output = Buffer.concat([output, Buffer.from(obj.str), pageImages[imgIdx].buffer, Buffer.from("\nendstream\nendobj\n")]);
          } else { output = Buffer.concat([output, Buffer.from(obj.str)]); }
        } else { output = Buffer.concat([output, Buffer.from(obj.str)]); }
      }

      const xrefOffset = output.length;
      let xrefStr = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i <= objCount; i++) xrefStr += `${String(xrefOffsets[i]).padStart(10, "0")} 00000 n \n`;
      xrefStr += `trailer\n<< /Size ${objCount + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      output = Buffer.concat([output, Buffer.from(xrefStr)]);

      res.json({ success: true, pdfBase64: `data:application/pdf;base64,${output.toString("base64")}`, pageCount: pageImages.length });
    } catch (err: any) { res.status(500).json({ error: "PDF generation failed" }); }
  });

  app.post("/api/smile-process", requireAuth, async (req, res) => {
    try {
      const openai = getOpenAIClient();
      if (!openai) return res.status(503).json({ error: "AI integrations are not configured." });

      const { imageBase64, mode } = req.body;
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });

      let prompt = "";
      if (mode === "whiten") prompt = "Edit this photo to whiten and brighten the person's teeth to a natural, beautiful Hollywood-white shade. Keep everything else the same.";
      else if (mode === "symmetry") prompt = "Edit this photo to make the person's visible teeth perfectly symmetrical and even. Keep everything else the same.";
      else if (mode === "both") prompt = "Edit this photo to whiten teeth AND make them perfectly symmetrical. Keep everything else the same.";
      else return res.status(400).json({ error: "Invalid mode." });

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      const response = await openai.images.edit({ model: "gpt-image-1", image: imgBuffer, prompt, size: "1024x1024" });
      const outputBase64 = response.data?.[0]?.b64_json;
      if (!outputBase64) return res.status(500).json({ error: "AI did not return an image." });
      res.json({ imageBase64: `data:image/png;base64,${outputBase64}` });
    } catch (err: any) { res.status(500).json({ error: "Failed to process image" }); }
  });

  app.delete("/api/admin/cleanup-email", async (req, res) => {
    try {
      const { email, adminKey } = req.body;
      const cleanupKey = process.env.LABTRAX_ADMIN_CLEANUP_KEY;
      if (!cleanupKey) return res.status(404).json({ error: "Not found" });
      if (adminKey !== cleanupKey) return res.status(403).json({ error: "Unauthorized" });
      if (!email) return res.status(400).json({ error: "Email required" });
      const allUsers = await db.select().from(users);
      const matches = allUsers.filter(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (matches.length === 0) return res.json({ success: true, deleted: 0, message: "No users found" });
      const { sql } = await import("drizzle-orm");
      let deletedCount = 0;
      for (const u of matches) {
        await db.transaction(async (tx) => {
          const uid = u.id;
          await tx.execute(sql`DELETE FROM user_sessions WHERE user_id = ${uid}`);
          await tx.execute(sql`DELETE FROM lab_cases WHERE owner_id = ${uid}`);
          await tx.execute(sql`DELETE FROM organization_memberships WHERE user_id = ${uid}`);
          await tx.execute(sql`DELETE FROM organization_join_requests WHERE requested_by_user_id = ${uid}`);
          await tx.execute(sql`DELETE FROM organization_invites WHERE invited_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organization_invites SET accepted_by_user_id = NULL WHERE accepted_by_user_id = ${uid}`);
          await tx.execute(sql`DELETE FROM organization_connections WHERE requested_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organization_connections SET approved_by_user_id = NULL WHERE approved_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organizations SET created_by_user_id = NULL WHERE created_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organization_memberships SET invited_by_user_id = NULL WHERE invited_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organization_memberships SET approved_by_user_id = NULL WHERE approved_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE organization_join_requests SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE cases SET created_by_user_id = NULL WHERE created_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_notes SET author_user_id = NULL WHERE author_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_attachments SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_locations SET moved_by_user_id = NULL WHERE moved_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_submission_queue SET submitted_by_user_id = NULL WHERE submitted_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_submission_queue SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE case_events SET actor_user_id = NULL WHERE actor_user_id = ${uid}`);
          await tx.execute(sql`UPDATE invoices SET created_by_user_id = NULL WHERE created_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE invoices SET updated_by_user_id = NULL WHERE updated_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE payments SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ${uid}`);
          await tx.execute(sql`UPDATE audit_logs SET user_id = NULL WHERE user_id = ${uid}`);
          await tx.delete(users).where(eq(users.id, uid));
        });
        deletedCount++;
      }
      res.json({ success: true, deleted: deletedCount, found: matches.length });
    } catch { res.status(500).json({ error: "Cleanup failed" }); }
  });

  const httpServer = createServer(app);
  return httpServer;
}
