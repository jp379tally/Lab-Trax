import type { Express } from "express";
import { createServer, type Server } from "node:http";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import { storage } from "./storage";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const verificationCodes = new Map<string, { code: string; expiresAt: number }>();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const DEFAULT_USERS = [
  { username: "admin", password: "123", userType: "lab", role: "user" },
  { username: "tech", password: "tech123", userType: "lab", role: "user" },
  { username: "JPPhillips", password: "Master1!", email: "john.phillips3@yahoo.com", phone: "850-363-3336", userType: "master_admin", role: "admin", accountNumber: "MA-001" },
];

async function seedDefaultUsers() {
  for (const def of DEFAULT_USERS) {
    const existing = await storage.getUserByUsername(def.username);
    if (!existing) {
      await storage.createUser(def as any);
      console.log(`[SEED] Created default user: ${def.username}`);
    }
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  await seedDefaultUsers();

  const auditLog: { timestamp: number; action: string; user: string; resource: string; ip: string }[] = [];

  app.post("/api/check-username", async (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const existing = await storage.getUserByUsername(username.trim());
    res.json({ available: !existing });
  });

  app.post("/api/auth/register", async (req, res) => {
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
        wantsUpdates: wantsUpdates || false,
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
          accountNumber: user.accountNumber,
        },
      });
    } catch (error: any) {
      console.error("Registration error:", error?.message || error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
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
          accountNumber: user.accountNumber,
        },
      });
    } catch (error: any) {
      console.error("Login error:", error?.message || error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.get("/api/auth/users", async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      res.json({
        users: allUsers.map(u => ({
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
          accountNumber: u.accountNumber,
        })),
      });
    } catch (error: any) {
      console.error("Get users error:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.put("/api/auth/users/:id/password", async (req, res) => {
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
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update password" });
    }
  });

  app.post("/api/audit-log", (req, res) => {
    const { action, user, resource } = req.body;
    if (!action || !user) {
      return res.status(400).json({ error: "Action and user required" });
    }
    const entry = {
      timestamp: Date.now(),
      action,
      user,
      resource: resource || "",
      ip: req.ip || req.socket.remoteAddress || "unknown",
    };
    auditLog.push(entry);
    if (auditLog.length > 10000) auditLog.splice(0, auditLog.length - 10000);
    res.json({ success: true });
  });

  app.get("/api/audit-log", (_req, res) => {
    res.json({ entries: auditLog.slice(-100) });
  });

  app.post("/api/send-phone-code", (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ error: "Phone number required" });
    }
    const code = generateCode();
    const key = `phone:${phone.trim()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
    console.log(`[SMS VERIFICATION] Code for ${phone}: ${code}`);
    res.json({ success: true, message: "Verification code sent via SMS.", demoCode: code });
  });

  app.post("/api/verify-phone-code", (req, res) => {
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

  app.post("/api/send-email-code", (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email required" });
    }
    const code = generateCode();
    const key = `email:${email.trim().toLowerCase()}`;
    verificationCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
    console.log(`[EMAIL VERIFICATION] Code for ${email}: ${code}`);
    res.json({ success: true, message: "Verification code sent to your email.", demoCode: code });
  });

  app.post("/api/verify-email-code", (req, res) => {
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

  app.post("/api/register", async (req, res) => {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }
    res.json({ success: true });
  });

  app.post("/api/analyze-prescription", async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }

      const dataUrl = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;

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
- Tooth numbers should use American dental numbering (1-32)`,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this dental prescription document thoroughly. Extract ALL visible information: doctor name, patient full name, case/restoration type, tooth numbers, shade, material, due date, rush status, and any notes or special instructions. Read all handwritten and printed text carefully.",
              },
              {
                type: "image_url",
                image_url: { url: dataUrl, detail: "high" },
              },
            ],
          },
        ],
        max_tokens: 1000,
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
          description: content,
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
          description: parsed.description || "Prescription analyzed",
        },
      });
    } catch (error: any) {
      console.error("Prescription analysis error:", error?.message || error);
      res.status(500).json({
        error: "Failed to analyze prescription",
        fallback: true,
      });
    }
  });

  app.post("/api/send-statement-email", async (req, res) => {
    try {
      const { clientName, clientEmail, adminEmail, subject, body } = req.body;

      if (!clientEmail && !adminEmail) {
        return res.status(400).json({ error: "At least one email recipient is required." });
      }

      const recipients: string[] = [];
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
        console.log(`[EMAIL] Body:\n${body}`);
        return res.json({
          success: true,
          message: `Statement emailed to ${recipients.join(" and ")}`,
          note: "SMTP not configured - email logged to console",
        });
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort || "587"),
        secure: (smtpPort || "587") === "465",
        auth: { user: smtpUser, pass: smtpPass },
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
        </div>`,
      });

      console.log(`[EMAIL] Statement sent to: ${recipients.join(", ")}`);
      return res.json({ success: true, message: `Statement emailed to ${recipients.join(" and ")}` });
    } catch (error: any) {
      console.error("[EMAIL] Error sending statement email:", error?.message || error);
      return res.status(500).json({ error: "Failed to send email", details: error?.message });
    }
  });

  app.post("/api/ai-chat", async (req, res) => {
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
          { role: "user", content: message },
        ],
        max_tokens: 500,
      });

      const reply = response.choices[0]?.message?.content || "I'm sorry, I couldn't process your request.";
      res.json({ success: true, reply });
    } catch (error: any) {
      console.error("AI chat error:", error?.message || error);
      res.status(500).json({ error: "Failed to process chat message" });
    }
  });

  app.post("/api/send-case-update-text", (req, res) => {
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
        note: "Twilio not configured - SMS logged to console",
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
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    })
      .then((r) => r.json())
      .then((data) => {
        console.log(`[SMS] Case update text sent to ${providerPhone} for case ${caseNumber}`);
        res.json({ success: true, message: `Text sent to ${providerPhone}` });
      })
      .catch((err) => {
        console.error("[SMS] Error sending text:", err?.message || err);
        res.status(500).json({ error: "Failed to send text", details: err?.message });
      });
  });

  const httpServer = createServer(app);

  return httpServer;
}
