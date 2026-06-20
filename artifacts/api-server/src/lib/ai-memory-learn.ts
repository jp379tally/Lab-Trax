/**
 * Auto-learning of per-lab AI memory from real chat exchanges.
 *
 * After an AI chat reply, this module asks the model to extract candidate
 * glossary terms, preferences, and durable facts that are clearly specific to
 * this lab. Candidates are written to `ai_memory_candidates` with status
 * 'pending' — they are NEVER added to `ai_memory` or fed into any prompt until
 * a lab admin approves them. This keeps the existing AI request/response
 * contract unchanged: learning is a background side effect only.
 */
import type OpenAI from "openai";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db, aiMemory, aiMemoryCandidates } from "@workspace/db";
import { logger } from "./logger";

export const CANDIDATE_KINDS = ["glossary", "preference", "fact"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export interface RawCandidate {
  kind: CandidateKind;
  key: string;
  value: string;
}

/** Max candidates persisted from a single exchange. */
const MAX_CANDIDATES_PER_EXCHANGE = 5;
const MAX_KEY_LEN = 200;
const MAX_VALUE_LEN = 2000;

const EXTRACTION_SYSTEM_PROMPT = `You extract durable, reusable memory entries about a specific dental lab from a single chat exchange between a user and an AI assistant.

Only extract information that is clearly TRUE, lab-specific, and worth remembering for future conversations. Be conservative: most exchanges contain nothing worth saving — in that case return an empty array.

Categories:
- "glossary": a lab-specific term, abbreviation, or shorthand and its meaning (e.g. "PFZ" = "porcelain fused to zirconia").
- "preference": how this lab likes things done (tone, defaults, conventions, workflow choices the user states).
- "fact": a durable fact about this lab (hours, policies, equipment, staff roles) that will stay true over time.

Do NOT extract:
- One-off questions, case-specific data (patient names, specific case numbers, due dates), pricing numbers, or transient state.
- General dental knowledge that is not specific to this lab.
- Anything you are unsure about.

Return STRICT JSON: {"candidates": [{"kind": "glossary"|"preference"|"fact", "key": string, "value": string}]}.
"key" is a short label (the term or name). "value" is the definition/preference/fact. Maximum 5 candidates.`;

function normalizeKind(raw: unknown): CandidateKind | null {
  const k = String(raw ?? "").trim().toLowerCase();
  return (CANDIDATE_KINDS as readonly string[]).includes(k)
    ? (k as CandidateKind)
    : null;
}

/**
 * Ask the model to extract candidate memory entries from one exchange.
 * Returns [] on any error or when nothing relevant is found.
 */
export async function extractMemoryCandidates(
  openai: OpenAI,
  userMessage: string,
  assistantMessage: string,
): Promise<RawCandidate[]> {
  const user = String(userMessage ?? "").slice(0, 4000);
  const assistant = String(assistantMessage ?? "").slice(0, 4000);
  if (!user.trim()) return [];

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `USER MESSAGE:\n${user}\n\nASSISTANT REPLY:\n${assistant}`,
        },
      ],
    });
  } catch (err) {
    logger.warn({ err }, "ai-memory-learn: extraction request failed");
    return [];
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const rawList = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(rawList)) return [];

  const out: RawCandidate[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const kind = normalizeKind((item as Record<string, unknown>).kind);
    const key = String((item as Record<string, unknown>).key ?? "").trim();
    const value = String((item as Record<string, unknown>).value ?? "").trim();
    if (!kind || !key || !value) continue;
    out.push({
      kind,
      key: key.slice(0, MAX_KEY_LEN),
      value: value.slice(0, MAX_VALUE_LEN),
    });
    if (out.length >= MAX_CANDIDATES_PER_EXCHANGE) break;
  }
  return out;
}

/**
 * Persist extracted candidates as pending rows for the given lab orgs,
 * skipping any that already exist as approved memory or as an existing
 * pending candidate (case-insensitive on key, scoped per kind). Returns the
 * number of rows inserted.
 */
export async function persistCandidates(
  labIds: string[],
  candidates: RawCandidate[],
  sourceUserId: string | null,
): Promise<number> {
  if (labIds.length === 0 || candidates.length === 0) return 0;

  // Dedupe within this batch first (per kind+lowercased key).
  const seen = new Set<string>();
  const unique: RawCandidate[] = [];
  for (const c of candidates) {
    const sig = `${c.kind}::${c.key.toLowerCase()}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(c);
  }

  let inserted = 0;
  for (const labId of labIds) {
    for (const c of unique) {
      // Skip if an active memory entry with this kind+key already exists.
      const existingMemory = await db.query.aiMemory.findFirst({
        where: and(
          eq(aiMemory.labOrganizationId, labId),
          eq(aiMemory.kind, c.kind),
          ilike(aiMemory.key, c.key),
          isNull(aiMemory.deletedAt),
        ),
      });
      if (existingMemory) continue;

      // Skip if a pending or already-rejected candidate exists (avoid
      // re-proposing something an admin already dismissed, and avoid dupes).
      const existingCandidate = await db.query.aiMemoryCandidates.findFirst({
        where: and(
          eq(aiMemoryCandidates.labOrganizationId, labId),
          eq(aiMemoryCandidates.kind, c.kind),
          ilike(aiMemoryCandidates.key, c.key),
          or(
            eq(aiMemoryCandidates.status, "pending"),
            eq(aiMemoryCandidates.status, "rejected"),
          ),
        ),
      });
      if (existingCandidate) continue;

      await db.insert(aiMemoryCandidates).values({
        labOrganizationId: labId,
        kind: c.kind,
        key: c.key,
        value: c.value,
        status: "pending",
        sourceUserId,
      });
      inserted++;
    }
  }
  return inserted;
}

/**
 * Background entry point: extract candidates from one exchange and persist
 * them as pending suggestions. Fire-and-forget; never throws. Safe to call
 * unconditionally — it no-ops when there is no AI client or no lab scope.
 */
export async function learnFromExchange(opts: {
  openai: OpenAI | null;
  labIds: string[];
  userMessage: string;
  assistantMessage: string;
  userId: string | null;
}): Promise<void> {
  const { openai, labIds, userMessage, assistantMessage, userId } = opts;
  if (!openai || labIds.length === 0) return;
  try {
    const candidates = await extractMemoryCandidates(
      openai,
      userMessage,
      assistantMessage,
    );
    if (candidates.length === 0) return;
    await persistCandidates(labIds, candidates, userId);
  } catch (err) {
    logger.warn({ err }, "ai-memory-learn: learnFromExchange failed");
  }
}

export { aiMemoryCandidates };
