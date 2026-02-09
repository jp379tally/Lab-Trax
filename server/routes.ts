import type { Express } from "express";
import { createServer, type Server } from "node:http";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export async function registerRoutes(app: Express): Promise<Server> {
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
