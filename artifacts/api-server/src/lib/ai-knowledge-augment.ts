import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import { db, aiMemory } from "@workspace/db";
import { selectKnowledge } from "@workspace/ai-knowledge";

const KIND_LABELS: Record<string, string> = {
  glossary: "Glossary",
  preference: "Preferences",
  fact: "Facts",
};

/**
 * Build a curated knowledge block for the given user query. Returns an empty
 * string when nothing relevant is found so callers can append it
 * unconditionally without altering the prompt when there is no match.
 */
export function buildKnowledgeBlock(query: string, maxChars = 2000): string {
  const knowledge = selectKnowledge(query, { maxChars });
  if (!knowledge) return "";
  return `\nREFERENCE KNOWLEDGE (curated; use only if relevant to the question):\n${knowledge}`;
}

/**
 * Build a per-lab memory block from the soft-deletable `ai_memory` table for
 * the given lab organization ids. Returns an empty string when there is no
 * stored memory so the prompt is unchanged in that case.
 */
export async function buildLabMemoryBlock(labIds: string[]): Promise<string> {
  if (labIds.length === 0) return "";

  const rows = await db
    .select()
    .from(aiMemory)
    .where(
      and(
        inArray(aiMemory.labOrganizationId, labIds),
        isNull(aiMemory.deletedAt),
      ),
    )
    .orderBy(asc(aiMemory.kind), asc(aiMemory.key));

  if (rows.length === 0) return "";

  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push(`- ${r.key}: ${r.value}`);
    byKind.set(r.kind, list);
  }

  const sections: string[] = [];
  for (const kind of ["glossary", "preference", "fact"]) {
    const list = byKind.get(kind);
    if (list && list.length > 0) {
      sections.push(`${KIND_LABELS[kind] ?? kind}:\n${list.join("\n")}`);
    }
  }

  if (sections.length === 0) return "";

  return `\nLAB-SPECIFIC MEMORY (admin-curated terminology, preferences, and facts for this lab — honor these):\n${sections.join("\n\n")}`;
}

export { aiMemory };
