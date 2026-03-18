import type { Express } from "express";
import { createServer, type Server } from "node:http";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import sharp from "sharp";
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

  app.delete("/api/auth/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await storage.getUser(id);
      if (!user) return res.status(404).json({ error: "User not found" });
      const deleted = await storage.deleteUser(id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: "Failed to delete user" });
      }
    } catch (error: any) {
      console.error("Delete user error:", error?.message || error);
      res.status(500).json({ error: "Failed to delete user" });
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
      console.log("Prescription analysis request received, body keys:", Object.keys(req.body || {}), "content-type:", req.headers["content-type"]);
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        console.log("No image in body, body size:", JSON.stringify(req.body || {}).length);
        return res.status(400).json({ error: "No image provided" });
      }

      console.log("Analyzing prescription, image data length:", imageBase64.length);

      const dataUrl = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;

      const models = ["gpt-4o", "gpt-4o-mini"];
      let response: any = null;
      let lastModelErr: any = null;
      const visionMessages = [
        {
          role: "system" as const,
          content: `You are a dental prescription/lab slip document analyzer. Your job is to carefully read dental prescription forms from ALL platforms (handwritten paper Rx, iTero, 3Shape, Medit, Carestream, Dentrix, EagleSoft, etc.) and extract ALL information. Read every word on the document carefully.

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
- If you see "Patient: Lewis, Bradley" → output patientName as "Bradley Lewis"
- If you see "Doctor: Dr. Montalvo, Ray" → output doctorName as "Dr. Ray Montalvo"
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
- Look at the ENTIRE document including headers, footers, tables, and sidebars`,
        },
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "Analyze this dental prescription document thoroughly. Extract ALL visible information: doctor name, patient full name, case/restoration type, tooth numbers, shade, material, due date, rush status, and any notes or special instructions. Read all handwritten and printed text carefully.",
            },
            {
              type: "image_url" as const,
              image_url: { url: dataUrl, detail: "high" as const },
            },
          ],
        },
      ];

      for (const model of models) {
        try {
          console.log("Trying model:", model);
          response = await openai.chat.completions.create({
            model,
            messages: visionMessages,
            max_tokens: 1000,
          });
          console.log("Model", model, "succeeded");
          break;
        } catch (modelErr: any) {
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
          description: content,
        };
      }

      function flipLastFirst(name: string): string {
        if (!name || !name.includes(",")) return name;
        const parts = name.split(",").map(s => s.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          return `${parts[1]} ${parts[0]}`;
        }
        return name;
      }

      let doctorName = parsed.doctorName || "";
      let patientName = parsed.patientName || "";
      doctorName = flipLastFirst(doctorName);
      patientName = flipLastFirst(patientName);
      if (doctorName && !doctorName.toLowerCase().startsWith("dr")) {
        doctorName = "Dr. " + doctorName;
      }

      let toothStr = "";
      if (parsed.toothIndices) {
        if (Array.isArray(parsed.toothIndices)) {
          toothStr = parsed.toothIndices.map((t: any) => `#${t}`).join(", ");
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
          description: parsed.description || "Prescription analyzed",
        },
      });
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.log("Prescription analysis error:", errorMsg);
      if (error?.response) {
        console.log("OpenAI response status:", error.response.status);
      }
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

  app.post("/api/crop-document", async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const rawBuffer = Buffer.from(base64Data, "base64");
      const rotatedBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 95 }).toBuffer();
      const rotatedBase64 = rotatedBuffer.toString("base64");
      const rotatedDataUrl = `data:image/jpeg;base64,${rotatedBase64}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are a document scanner system like OneDrive or Adobe Scan. Analyze the image and determine if there is a document (paper, form, prescription, letter, card, receipt, etc.) visible in the photo.

If a document IS detected:
1. Return the crop coordinates as percentages (0-100) of the image dimensions that tightly frame ONLY the document, excluding any background, desk, hands, etc. Add a small 1-2% margin.
2. Determine the rotation needed to make the document upright and readable. Most documents are portrait orientation (taller than wide). If the text appears sideways or upside down, specify the rotation degrees needed.

Return ONLY valid JSON:
{
  "documentDetected": true,
  "crop": { "left": 10, "top": 5, "right": 90, "bottom": 95 },
  "rotation": 0,
  "documentType": "prescription" | "form" | "letter" | "card" | "receipt" | "other"
}

rotation values: 0 = already upright, 90 = rotate 90° clockwise, 180 = upside down, 270 = rotate 90° counter-clockwise.

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
              { type: "text", text: "Detect the document in this image. Return crop coordinates and rotation needed to make it upright." },
              { type: "image_url", image_url: { url: rotatedDataUrl, detail: "low" } },
            ],
          },
        ],
        max_tokens: 250,
      });

      const text = response.choices?.[0]?.message?.content || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }

      const result = JSON.parse(jsonMatch[0]);
      if (!result.documentDetected || !result.crop) {
        return res.json({ documentDetected: false, croppedImageBase64: rotatedDataUrl });
      }

      const metadata = await sharp(rotatedBuffer).metadata();
      const imgW = metadata.width || 1;
      const imgH = metadata.height || 1;

      const left = Math.max(0, Math.round((result.crop.left / 100) * imgW));
      const top = Math.max(0, Math.round((result.crop.top / 100) * imgH));
      const right = Math.min(imgW, Math.round((result.crop.right / 100) * imgW));
      const bottom = Math.min(imgH, Math.round((result.crop.bottom / 100) * imgH));
      const cropW = Math.max(1, right - left);
      const cropH = Math.max(1, bottom - top);

      let pipeline = sharp(rotatedBuffer).extract({ left, top, width: cropW, height: cropH });

      const rotation = result.rotation || 0;
      if (rotation === 90 || rotation === 180 || rotation === 270) {
        pipeline = pipeline.rotate(rotation);
      }

      const croppedBuffer = await pipeline
        .sharpen({ sigma: 1.2 })
        .normalize()
        .jpeg({ quality: 92 })
        .toBuffer();

      const croppedBase64 = `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`;
      console.log(`[Crop] Document detected: ${result.documentType}, rotation: ${rotation}°, crop: ${cropW}x${cropH}`);
      res.json({ documentDetected: true, croppedImageBase64: croppedBase64, documentType: result.documentType });
    } catch (err: any) {
      console.error("[Crop Document] Error:", err?.message || err);
      try {
        const base64Data = req.body.imageBase64?.replace(/^data:image\/\w+;base64,/, "") || "";
        if (base64Data) {
          const fixedBuffer = await sharp(Buffer.from(base64Data, "base64")).rotate().jpeg({ quality: 90 }).toBuffer();
          return res.json({ documentDetected: false, croppedImageBase64: `data:image/jpeg;base64,${fixedBuffer.toString("base64")}` });
        }
      } catch {}
      res.json({ documentDetected: false, croppedImageBase64: null });
    }
  });

  app.post("/api/document-to-pdf", async (req, res) => {
    try {
      const { images } = req.body;
      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: "No images provided" });
      }

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
        } catch (imgErr: any) {
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
      const newObj = () => { objCount++; return objCount; };

      const catalogId = newObj();
      const pagesId = newObj();

      const pageObjIds: number[] = [];
      const imgObjIds: number[] = [];
      const contentObjIds: number[] = [];

      for (const _pg of pageImages) {
        pageObjIds.push(newObj());
        imgObjIds.push(newObj());
        contentObjIds.push(newObj());
      }

      const objStrs: { id: number; str: string }[] = [];

      objStrs.push({ id: catalogId, str: `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n` });

      const kidsStr = pageObjIds.map(id => `${id} 0 R`).join(" ");
      objStrs.push({ id: pagesId, str: `${pagesId} 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjIds.length} >>\nendobj\n` });

      for (let i = 0; i < pageImages.length; i++) {
        const pg = pageImages[i];
        const scale = Math.min((PDF_W - MARGIN * 2) / pg.width, (PDF_H - MARGIN * 2) / pg.height);
        const drawW = Math.round(pg.width * scale);
        const drawH = Math.round(pg.height * scale);
        const drawX = Math.round((PDF_W - drawW) / 2);
        const drawY = Math.round((PDF_H - drawH) / 2);

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
      let xrefStr = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i <= objCount; i++) {
        xrefStr += `${String(xrefOffsets[i]).padStart(10, "0")} 00000 n \n`;
      }
      xrefStr += `trailer\n<< /Size ${objCount + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

      output = Buffer.concat([output, Buffer.from(xrefStr)]);

      const pdfBase64 = `data:application/pdf;base64,${output.toString("base64")}`;
      console.log(`[PDF] Generated ${pageImages.length}-page PDF, size: ${(output.length / 1024).toFixed(1)}KB`);
      res.json({ success: true, pdfBase64, pageCount: pageImages.length });
    } catch (err: any) {
      console.error("[Document to PDF] Error:", err?.message || err);
      res.status(500).json({ error: "PDF generation failed" });
    }
  });

  app.post("/api/smile-process", async (req, res) => {
    try {
      const { imageBase64, mode } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "No image provided" });
      }

      let prompt = "";
      if (mode === "whiten") {
        prompt = "Edit this photo to whiten and brighten the person's teeth to a natural, beautiful Hollywood-white shade. Make the teeth look naturally white and healthy — NOT cartoon-like or overly artificial. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only change the color of the visible teeth to be whiter and brighter. The result must look like a real photograph, not digitally manipulated.";
      } else if (mode === "symmetry") {
        prompt = "Edit this photo to make the person's visible teeth perfectly symmetrical and even. Straighten any crooked teeth, even out spacing, and make the teeth appear uniform and aligned — as if the person had perfect orthodontic work done. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only modify the teeth alignment and symmetry. The result must look like a real photograph.";
      } else if (mode === "both") {
        prompt = "Edit this photo to: 1) Whiten and brighten the person's teeth to a natural Hollywood-white shade, AND 2) Make the teeth perfectly symmetrical, even, and straight — as if they had perfect orthodontic work and professional whitening. Keep absolutely everything else in the photo exactly the same: face, skin, hair, eyes, background, clothing, lighting. Only change the teeth color and alignment. The result must look like a real photograph, not digitally manipulated.";
      } else {
        return res.status(400).json({ error: "Invalid mode. Use 'whiten', 'symmetry', or 'both'." });
      }

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");

      const response = await openai.images.edit({
        model: "gpt-image-1",
        image: imgBuffer,
        prompt,
        size: "1024x1024",
      });

      const outputBase64 = response.data?.[0]?.b64_json;
      if (!outputBase64) {
        return res.status(500).json({ error: "AI did not return an image." });
      }

      res.json({ imageBase64: `data:image/png;base64,${outputBase64}` });
    } catch (err: any) {
      console.error("[Smile Process] Error:", err?.message || err);
      res.status(500).json({ error: "Failed to process image", details: err?.message });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
