/**
 * Shared server-side AI chat history persistence.
 *
 * Both the legacy chat endpoint (`/ai-chat`) and the agentic endpoints
 * (`/ai-agent`, `/ai-agent/stream`) persist each user+assistant exchange into
 * the `ai_chat_history` table so a user's conversation follows them across
 * devices (second device, reinstall, mobile↔desktop). `GET /ai-chat/history`
 * reads it back. Keeping the writer in one place ensures every entry point uses
 * the same shape, trimming, and disclaimer metadata.
 */

import { db } from "@workspace/db";
import { aiChatHistory } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { wrapDbError } from "./http";

/** Max stored messages per user (50 turns = 100 messages). */
export const MAX_HISTORY_ROWS = 100;

/** Number of recent messages to load and send to the AI / client as context. */
export const HISTORY_LOAD_LIMIT = 50;

export function generateHistoryId(): string {
  return randomBytes(16).toString("hex");
}

export interface PersistExchangeOptions {
  /** Curated knowledge section ids injected into the prompt (assistant row). */
  knowledgeSectionIds?: string[];
  /** Whether the retention legal disclaimer was injected (assistant row). */
  retentionDisclaimer?: boolean;
}

/**
 * Persist a single user+assistant exchange and trim old rows so each user keeps
 * at most {@link MAX_HISTORY_ROWS} messages. Best-effort: callers should invoke
 * this fire-and-forget so a persistence failure never blocks or breaks the AI
 * reply. Returns a promise that resolves once the write completes.
 */
export async function persistAiChatExchange(
  userId: string,
  userContent: string,
  assistantContent: string,
  opts: PersistExchangeOptions = {},
): Promise<void> {
  const now = new Date();
  await db
    .insert(aiChatHistory)
    .values([
      {
        id: generateHistoryId(),
        userId,
        role: "user",
        content: userContent,
        createdAt: now,
      },
      {
        id: generateHistoryId(),
        userId,
        role: "assistant",
        content: assistantContent,
        ...(opts.knowledgeSectionIds && opts.knowledgeSectionIds.length > 0
          ? { knowledgeSectionIds: opts.knowledgeSectionIds }
          : {}),
        ...(opts.retentionDisclaimer ? { retentionDisclaimer: true } : {}),
        // +1ms so ordering by createdAt keeps the assistant reply after the prompt.
        createdAt: new Date(now.getTime() + 1),
      },
    ])
    .catch((err: unknown): never =>
      wrapDbError(err, { fallback: "Failed to persist AI chat history." }),
    );

  // Keep only the most recent MAX_HISTORY_ROWS rows per user.
  const subq = db
    .select({ id: aiChatHistory.id })
    .from(aiChatHistory)
    .where(eq(aiChatHistory.userId, userId))
    .orderBy(desc(aiChatHistory.createdAt))
    .limit(MAX_HISTORY_ROWS);

  await db
    .delete(aiChatHistory)
    .where(
      and(
        eq(aiChatHistory.userId, userId),
        sql`${aiChatHistory.id} NOT IN (${subq})`,
      ),
    );
}

/** Load recent history for a user, oldest-first for chat display. */
export async function loadAiChatHistory(
  userId: string,
): Promise<
  Array<{
    id: string;
    role: string;
    content: string;
    knowledgeSectionIds: string[] | null;
    retentionDisclaimer: boolean | null;
    createdAt: Date;
  }>
> {
  const rows = await db
    .select({
      id: aiChatHistory.id,
      role: aiChatHistory.role,
      content: aiChatHistory.content,
      knowledgeSectionIds: aiChatHistory.knowledgeSectionIds,
      retentionDisclaimer: aiChatHistory.retentionDisclaimer,
      createdAt: aiChatHistory.createdAt,
    })
    .from(aiChatHistory)
    .where(eq(aiChatHistory.userId, userId))
    .orderBy(desc(aiChatHistory.createdAt))
    .limit(HISTORY_LOAD_LIMIT);

  return rows.reverse();
}
