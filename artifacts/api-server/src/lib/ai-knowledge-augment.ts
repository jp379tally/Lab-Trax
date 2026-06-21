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

// ─── Material & shade suggestion block ──────────────────────────────────────

/** Universal Numbering System: anterior teeth (esthetic zone) */
const ANTERIOR_TEETH = new Set([6, 7, 8, 9, 10, 11, 22, 23, 24, 25, 26, 27]);

/** Universal Numbering System: posterior teeth (load-bearing zone) */
const POSTERIOR_TEETH = new Set([
  1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 28, 29, 30, 31, 32,
]);

const RESTORATION_TERMS = [
  "crown", "bridge", "veneer", "inlay", "onlay", "implant", "restoration",
  "fpd", "pontic", "abutment", "unit", "all-on", "all on",
];

/**
 * Extract Universal tooth numbers from a user query.
 * Recognises: "#9", "tooth 9", "tooth #9", "teeth #8-10", "#8-10".
 */
function parseMentionedTeeth(query: string): number[] {
  const found: number[] = [];

  // "tooth #9", "tooth 9", "#9-11" (range)
  const wordRe = /(?:tooth|teeth)\s*#?(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/gi;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(query)) !== null) {
    const start = parseInt(m[1]!, 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    for (let t = Math.min(start, end); t <= Math.max(start, end) && t <= 32; t++) {
      if (t >= 1) found.push(t);
    }
  }

  // Standalone "#9" or "#8-10"
  const hashRe = /(?<!\w)#(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?!\w)/g;
  while ((m = hashRe.exec(query)) !== null) {
    const start = parseInt(m[1]!, 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    for (let t = Math.min(start, end); t <= Math.max(start, end) && t <= 32; t++) {
      if (t >= 1) found.push(t);
    }
  }

  return [...new Set(found)];
}

function hasRestorationTerm(query: string): boolean {
  const lower = query.toLowerCase();
  return RESTORATION_TERMS.some((term) => lower.includes(term));
}

/**
 * When the user's query mentions a tooth number **and** a restoration type,
 * returns a guidance block that encourages the AI to suggest an appropriate
 * material and shade based on the tooth's position in the arch.
 *
 * Returns an empty string when no tooth+restoration context is detected so
 * the prompt is unchanged — callers can append this unconditionally.
 */
export function buildMaterialSuggestionBlock(query: string): string {
  const teeth = parseMentionedTeeth(query);
  if (teeth.length === 0 || !hasRestorationTerm(query)) return "";

  const anteriorTeeth = teeth.filter((t) => ANTERIOR_TEETH.has(t));
  const posteriorTeeth = teeth.filter((t) => POSTERIOR_TEETH.has(t));

  const lines: string[] = [
    "MATERIAL & SHADE SUGGESTION GUIDANCE (the user mentioned a tooth number and restoration type — apply the rules below proactively):",
    "- Suggest a material and shade unless the Rx already specifies both.",
    "- Always check lab memory (Preferences/Glossary) for the doctor's standing material choices before recommending a change.",
  ];

  if (anteriorTeeth.length > 0) {
    lines.push(
      `- ANTERIOR teeth detected (${anteriorTeeth.map((t) => `#${t}`).join(", ")}): esthetics are the priority.`,
      "  • Lithium Disilicate (Emax) is typically preferred for crowns, veneers, and short-span anterior bridges — natural translucency, good strength for single units.",
      "  • High-translucency zirconia (4Y/5Y) or layered zirconia is a solid alternative when greater strength is needed.",
      "  • PFM is now less common in the esthetic zone; only suggest it if the doctor has a standing preference.",
      "  • Recommend recording a VITA Classical shade (e.g. A2, A3) or bleach shade (BL1–BL4). If no shade is on the Rx, flag it — mismatched shade is the leading remake cause for anterior work. A stump shade may also be needed for highly translucent materials.",
    );
  }

  if (posteriorTeeth.length > 0) {
    lines.push(
      `- POSTERIOR teeth detected (${posteriorTeeth.map((t) => `#${t}`).join(", ")}): strength and occlusal durability are the priority.`,
      "  • Monolithic zirconia (3Y) is typically preferred for high-load molars, second molars, and long-span posterior bridges.",
      "  • Lithium Disilicate (Emax) suits premolars (#4–5, #12–13, #28–29) where esthetics remain important and occlusal load is moderate.",
      "  • For PFM or full-cast restorations, confirm the alloy type; noble/high-noble alloys may carry a metal surcharge.",
      "  • Shade matters less in the posterior but should still be recorded; A3 or A3.5 covers most natural posterior teeth.",
    );
  }

  return `\n${lines.join("\n")}`;
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
