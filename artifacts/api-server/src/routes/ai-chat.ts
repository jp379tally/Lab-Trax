import { type IRouter } from "express";
import { db } from "@workspace/db";
import { aiChatHistory } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { loadAiChatHistory } from "../lib/ai-chat-history";

/**
 * AI chat history endpoints.
 *
 * The legacy message-sending endpoints (`POST /ai-chat`, `POST /ai-chat/stream`)
 * were retired once every client moved to the agentic `/ai-agent` routes. History
 * is now written exclusively by the shared `persistAiChatExchange` lib (invoked
 * from `/ai-agent` + `/ai-agent/stream`); these routes only read it back and
 * clear it, giving each user a single cross-device conversation history.
 */
const loadHistory = loadAiChatHistory;

export function registerAiChatRoutes(router: IRouter): void {
  /** GET /ai-chat/history — returns the last N stored messages for this user */
  router.get("/ai-chat/history", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    try {
      const rows = await loadHistory(userId);
      return res.json({ messages: rows });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat history fetch error");
      return res.status(500).json({ error: "Failed to load chat history." });
    }
  });

  /** DELETE /ai-chat/history — clears all stored messages for this user */
  router.delete("/ai-chat/history", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    try {
      await db.delete(aiChatHistory).where(eq(aiChatHistory.userId, userId));
      return res.json({ success: true });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat history clear error");
      return res.status(500).json({ error: "Failed to clear chat history." });
    }
  });
}
