/**
 * Shared server-side AI chat history persistence.
 *
 * The agentic endpoints (`/ai-agent`, `/ai-agent/stream`) persist each
 * user+assistant exchange into the `ai_chat_history` table so a user's
 * conversation follows them across devices (second device, reinstall,
 * mobile↔desktop). `GET /ai-chat/history` reads it back. This lib is the single
 * writer of `ai_chat_history`, ensuring every entry point uses the same shape,
 * trimming, and disclaimer metadata. (The legacy `POST /ai-chat` endpoint that
 * originally wrote here has been retired.)
 */

import { db } from "@workspace/db";
import { aiChatHistory } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { wrapDbError } from "./http";

/**
 * Max stored messages per user. Raised from 100 → 1000 so that, with the
 * "load earlier messages" pagination on both clients, long-time users can
 * scroll meaningfully far back through their conversation rather than hitting
 * the old 50-turn ceiling.
 */
export const MAX_HISTORY_ROWS = 1000;

/** Number of recent messages to load and send to the AI / client as context. */
export const HISTORY_LOAD_LIMIT = 50;

/** Hard cap on a single history page so a client can't request unbounded rows. */
export const HISTORY_PAGE_MAX = 100;

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

export interface AiChatHistoryRow {
  id: string;
  role: string;
  content: string;
  knowledgeSectionIds: string[] | null;
  retentionDisclaimer: boolean | null;
  createdAt: Date;
}

export interface LoadAiChatHistoryOptions {
  /** Max messages to return in this page (clamped to {@link HISTORY_PAGE_MAX}). */
  limit?: number;
  /**
   * Cursor for "load earlier": the id of the oldest message the client already
   * holds. Only messages strictly older than this row are returned, so repeated
   * calls page backwards through the full stored history.
   */
  before?: string;
}

export interface LoadAiChatHistoryResult {
  /** This page of messages, oldest-first for chat display. */
  messages: AiChatHistoryRow[];
  /** True when older messages exist before the oldest row in this page. */
  hasMore: boolean;
}

/**
 * Load a page of history for a user, oldest-first for chat display.
 *
 * Without `before` this returns the most recent {@link HISTORY_LOAD_LIMIT}
 * messages (the original behaviour). With `before` set to the oldest message id
 * the client currently holds, it returns the page of messages immediately
 * older than that, enabling a "load earlier messages" affordance. `hasMore`
 * reports whether still-older messages remain so the client can hide the
 * affordance at the start of the conversation.
 */
export async function loadAiChatHistory(
  userId: string,
  opts: LoadAiChatHistoryOptions = {},
): Promise<LoadAiChatHistoryResult> {
  const requested = opts.limit ?? HISTORY_LOAD_LIMIT;
  const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(requested)));

  // Resolve the cursor row (oldest message the client already holds) so we can
  // page strictly backwards from it. Scoped to userId so a foreign id is inert.
  let cursor: { createdAt: Date; id: string } | null = null;
  if (opts.before) {
    const [c] = await db
      .select({ createdAt: aiChatHistory.createdAt, id: aiChatHistory.id })
      .from(aiChatHistory)
      .where(
        and(eq(aiChatHistory.userId, userId), eq(aiChatHistory.id, opts.before)),
      )
      .limit(1);
    if (c) {
      cursor = { createdAt: c.createdAt, id: c.id };
    } else {
      // An unknown/invalid `before` cursor (a foreign id, a stale client-local
      // id, or an already-trimmed row) must NOT silently fall through to the
      // latest page — that would re-send messages the client already shows as a
      // duplicate and, on "load earlier", cause an infinite scroll loop. Treat
      // it as "no older messages remain".
      return { messages: [], hasMore: false };
    }
  }

  const conditions = [eq(aiChatHistory.userId, userId)];
  if (cursor) {
    // (createdAt, id) tuple comparison keeps paging stable even if two rows
    // share a createdAt timestamp.
    conditions.push(
      sql`(${aiChatHistory.createdAt} < ${cursor.createdAt} OR (${aiChatHistory.createdAt} = ${cursor.createdAt} AND ${aiChatHistory.id} < ${cursor.id}))`,
    );
  }

  // Fetch one extra row to detect whether older messages remain.
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
    .where(and(...conditions))
    .orderBy(desc(aiChatHistory.createdAt), desc(aiChatHistory.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page.reverse(), hasMore };
}
