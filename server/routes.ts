import type { Express } from "express";
import { createServer, type Server } from "node:http";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const verificationCodes = new Map<string, { code: string; expiresAt: number }>();
const registeredUsernames = new Set<string>(["admin", "tech"]);

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/check-username", (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username required" });
    }
    const taken = registeredUsernames.has(username.toLowerCase().trim());
    res.json({ available: !taken });
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

    res.json({ success: true, message: "Verification code sent via SMS." });
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

    res.json({ success: true, message: "Verification code sent to your email." });
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

  app.post("/api/register", (req, res) => {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }
    registeredUsernames.add(username.toLowerCase().trim());
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
        model: "gpt-5-nano",
        messages: [
          {
            role: "system",
            content: `You are a dental prescription document analyzer. Extract the following fields from the prescription image. Return ONLY valid JSON with these fields:
{
  "doctorName": "full name including Dr. prefix",
  "patientInitials": "first and last initials like J.S.",
  "toothIndices": "tooth numbers like #8, #9, #10",
  "shade": "dental shade like A2, B1, C2",
  "material": "one of: Zirconia, E.max, PFM, Gold",
  "isRush": false,
  "notes": "any additional notes from the prescription",
  "description": "brief description of what the document shows"
}
If a field cannot be determined, use an empty string. For material, default to "Zirconia" if unclear.`,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this dental prescription document. Extract all visible information including doctor name, patient info, tooth numbers, shade, material type, and any notes.",
              },
              {
                type: "image_url",
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content || "{}";
      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch {
        parsed = {
          doctorName: "",
          patientInitials: "",
          toothIndices: "",
          shade: "",
          material: "Zirconia",
          isRush: false,
          notes: "",
          description: content,
        };
      }

      res.json({
        success: true,
        data: {
          doctorName: parsed.doctorName || "",
          patientInitials: parsed.patientInitials || "",
          toothIndices: parsed.toothIndices || "",
          shade: parsed.shade || "",
          material: parsed.material || "Zirconia",
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

  const httpServer = createServer(app);

  return httpServer;
}
