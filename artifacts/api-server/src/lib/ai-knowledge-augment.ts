import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import { db, aiMemory } from "@workspace/db";
import { selectKnowledgeSections } from "@workspace/ai-knowledge";
import type { KnowledgeSection } from "@workspace/ai-knowledge";

const KIND_LABELS: Record<string, string> = {
  glossary: "Glossary",
  preference: "Preferences",
  fact: "Facts",
};

/**
 * Keywords that indicate a query is asking about record-retention periods or
 * disposal rules. When any of these appear, a prominent legal-advice disclaimer
 * is injected at the top of the knowledge block so staff cannot miss it even
 * if they read only the first part of the AI reply.
 *
 * Lowercase; matched as substrings of the lowercased query.
 */
export const RETENTION_SIGNALS: readonly string[] = [
  "retention",
  "retain",
  "how long",
  "record retention",
  "keep records",
  "keep for",
  "must keep",
  "years",
  "state law",
  "state rules",
  "state requirements",
  "state board",
  "dispose",
  "disposal",
  "destroy records",
  "delete records",
  "lab records",
  "dental records",
  "case records",
  "rx records",
  "minor patient",
  "adult patient",
  "age of majority",
];

/**
 * Returns true when the query contains at least one retention-signal keyword
 * that warrants surfacing the legal-advice disclaimer prominently.
 */
export function hasRetentionSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return RETENTION_SIGNALS.some((signal) => lower.includes(signal));
}

/** Prominent disclaimer injected at the top of any knowledge block that draws
 *  on retention content. Placed first so it is visible even if the user reads
 *  only part of the AI response. */
const RETENTION_LEGAL_DISCLAIMER =
  "⚠️ NOT LEGAL ADVICE — Record-retention periods vary by state and are " +
  "updated by legislation. The figures below are a general reference only. " +
  "Verify current requirements with your state dental board and qualified " +
  "legal counsel before disposing of any records.";

/** Prominent disclaimer injected when the knowledge block includes HIPAA /
 *  privacy guidance. Placed first so staff cannot miss it even if they only
 *  skim the first paragraph of the AI reply. */
const HIPAA_PRIVACY_DISCLAIMER =
  "⚠️ NOT COMPLIANCE ADVICE — This is general HIPAA guidance only. " +
  "Requirements vary by covered entity and situation. Consult your compliance " +
  "officer before making patient-data decisions.";

/**
 * Keywords that indicate a query is asking about Business Associate Agreements
 * (BAAs) or business associate obligations under HIPAA. When any of these
 * appear, a prominent legal-advice disclaimer is injected so staff do not act
 * on AI guidance alone when negotiating or signing BAAs.
 *
 * Lowercase; matched as substrings of the lowercased query.
 */
export const BAA_SIGNALS: readonly string[] = [
  "baa",
  "business associate",
  "business associate agreement",
  "covered entity",
  "covered entities",
  "subcontractor",
  "vendor agreement",
  "hipaa agreement",
  "hipaa contract",
  "sign a baa",
  "require a baa",
  "need a baa",
  "baa required",
  "baa signed",
  "baa in place",
  "associate contract",
  "data processing agreement",
];

/**
 * Returns true when the query contains at least one BAA-signal keyword that
 * warrants surfacing the BAA legal-advice disclaimer.
 */
export function hasBaaSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return BAA_SIGNALS.some((signal) => lower.includes(signal));
}

/** Prominent disclaimer injected when a query concerns BAA obligations. */
const BAA_LEGAL_DISCLAIMER =
  "⚠️ NOT LEGAL ADVICE — Business Associate Agreement requirements depend on " +
  "your specific relationships, services, and applicable law. The guidance " +
  "below is a general reference only. Consult qualified legal counsel before " +
  "drafting, signing, or declining any Business Associate Agreement.";

/**
 * Keywords that indicate a query is asking about HIPAA breach notification
 * obligations, timelines, or state-specific privacy breach rules. When any of
 * these appear, a prominent legal-advice disclaimer is injected.
 *
 * Lowercase; matched as substrings of the lowercased query.
 */
export const BREACH_SIGNALS: readonly string[] = [
  "breach",
  "breach notification",
  "notify patients",
  "notify hhs",
  "report a breach",
  "report the breach",
  "data breach",
  "security incident",
  "unauthorized access",
  "unauthorized disclosure",
  "impermissible disclosure",
  "60 day",
  "60-day",
  "breach timeline",
  "notification deadline",
  "breach report",
  "state breach",
  "state notification",
  "safe harbor",
  "risk assessment",
  "low probability",
  "four-factor",
  "four factor",
];

/**
 * Returns true when the query contains at least one breach-signal keyword that
 * warrants surfacing the breach-notification legal-advice disclaimer.
 */
export function hasBreachSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return BREACH_SIGNALS.some((signal) => lower.includes(signal));
}

/** Prominent disclaimer injected when a query concerns breach notification. */
const BREACH_LEGAL_DISCLAIMER =
  "⚠️ NOT LEGAL ADVICE — HIPAA breach notification timelines and state-law " +
  "requirements vary and carry legal consequences. The information below is a " +
  "general reference only. Contact qualified legal counsel and, if applicable, " +
  "your compliance officer immediately when a potential breach is identified.";

/**
 * Privacy-sensitive keywords that indicate a query is asking about patient
 * data handling. When any of these appear, HIPAA knowledge sections are
 * guaranteed a share of the prompt budget so staff always receive compliance
 * guidance without having to know to ask for it.
 *
 * Lowercase; matched as substrings of the lowercased query.
 */
export const HIPAA_PRIVACY_SIGNALS: readonly string[] = [
  "patient",
  "phi",
  "hipaa",
  "privacy",
  "share",
  "photo",
  "photos",
  "who can see",
  "attachment",
  "attachments",
  "image",
  "images",
  "record",
  "records",
  "disclosure",
  "disclose",
  "confidential",
  "personal information",
  "health information",
  "secure",
  "security",
];

/**
 * Returns true when the query contains at least one privacy-signal keyword
 * that warrants surfacing HIPAA compliance guidance.
 */
export function hasPrivacySignal(query: string): boolean {
  const lower = query.toLowerCase();
  return HIPAA_PRIVACY_SIGNALS.some((signal) => lower.includes(signal));
}

/** Render one section into prompt form — matches the format used by selectKnowledge. */
function renderKnowledgeSection(section: KnowledgeSection): string {
  return `### ${section.title}\n${section.body}`;
}

/**
 * Metadata returned alongside the knowledge block.
 * sectionIds — IDs of every knowledge section included in the block.
 * retentionDisclaimer — true when the retention legal-advice disclaimer was injected.
 * baaDisclaimer — true when the BAA legal-advice disclaimer was injected.
 * breachDisclaimer — true when the breach-notification legal-advice disclaimer was injected.
 * privacyDisclaimer — true when the HIPAA/compliance disclaimer was injected.
 */
export interface KnowledgeBlockMeta {
  block: string;
  sectionIds: string[];
  retentionDisclaimer: boolean;
  baaDisclaimer: boolean;
  breachDisclaimer: boolean;
  privacyDisclaimer: boolean;
}

/**
 * Build a curated knowledge block for the given user query. Returns metadata
 * including the formatted block, the list of section IDs that were selected,
 * and which compliance disclaimers were injected. The block is an empty
 * string when nothing relevant is found so callers can append it
 * unconditionally without altering the prompt when there is no match.
 *
 * When the query contains a privacy-signal keyword (e.g. "patient", "photo",
 * "share"), up to half the character budget is reserved for HIPAA knowledge
 * sections so compliance guidance is always surfaced proactively. The
 * remaining budget is filled by the normal relevance-scored selection across
 * all groups, with HIPAA sections already included skipped to avoid
 * duplication.
 *
 * Compliance disclaimers (retention, BAA, breach) are injected at the top
 * of the block when the query matches their respective signal arrays so they
 * are visible even if the user reads only the first part of the AI response.
 */
export function buildKnowledgeBlockWithMeta(
  query: string,
  maxChars = 2000,
): KnowledgeBlockMeta {
  const retentionDisclaimer = hasRetentionSignal(query);
  const baaDisclaimer = hasBaaSignal(query);
  const breachDisclaimer = hasBreachSignal(query);
  const privacySignal = hasPrivacySignal(query);

  // Build a combined disclaimer prefix for all matching compliance topics.
  // Retention/BAA/breach apply unconditionally when their signals fire;
  // the HIPAA compliance disclaimer is added when a privacy signal is detected.
  const disclaimers: string[] = [];
  if (retentionDisclaimer) disclaimers.push(RETENTION_LEGAL_DISCLAIMER);
  if (baaDisclaimer) disclaimers.push(BAA_LEGAL_DISCLAIMER);
  if (breachDisclaimer) disclaimers.push(BREACH_LEGAL_DISCLAIMER);
  if (privacySignal) disclaimers.push(HIPAA_PRIVACY_DISCLAIMER);
  const prefix = disclaimers.length > 0 ? `${disclaimers.join("\n\n")}\n\n` : "";

  const emptyMeta: KnowledgeBlockMeta = {
    block: "",
    sectionIds: [],
    retentionDisclaimer: false,
    baaDisclaimer: false,
    breachDisclaimer: false,
    privacyDisclaimer: false,
  };

  if (!privacySignal) {
    const sections = selectKnowledgeSections(query, { maxChars });
    if (sections.length === 0) return emptyMeta;
    const knowledge = sections.map(renderKnowledgeSection).join("\n\n");
    const block = `\nREFERENCE KNOWLEDGE (curated; use only if relevant to the question):\n${prefix}${knowledge}`;
    return { block, sectionIds: sections.map((s) => s.id), retentionDisclaimer, baaDisclaimer, breachDisclaimer, privacyDisclaimer: false };
  }

  // Privacy signal detected: reserve a budget share for HIPAA sections.
  const hipaaReserved = Math.min(Math.floor(maxChars * 0.5), 1500);
  const hipaaSections = selectKnowledgeSections(query, {
    maxChars: hipaaReserved,
    groups: ["hipaa"],
  });

  const hipaaIds = new Set(hipaaSections.map((s) => s.id));

  // Calculate characters consumed by HIPAA sections (including separators).
  const hipaaUsed = hipaaSections.reduce(
    (n, s, i) => n + renderKnowledgeSection(s).length + (i > 0 ? 2 : 0),
    0,
  );
  const remainingBudget = maxChars - hipaaUsed;

  // Fill remaining budget from all groups, skipping already-included sections.
  const generalSections =
    remainingBudget > 0
      ? selectKnowledgeSections(query, { maxChars: remainingBudget }).filter(
          (s) => !hipaaIds.has(s.id),
        )
      : [];

  const allSections = [...hipaaSections, ...generalSections];
  const knowledge = allSections.map(renderKnowledgeSection).join("\n\n");
  if (!knowledge) return emptyMeta;

  const block = `\nREFERENCE KNOWLEDGE (curated; use only if relevant to the question):\n${prefix}${knowledge}`;
  return { block, sectionIds: allSections.map((s) => s.id), retentionDisclaimer, baaDisclaimer, breachDisclaimer, privacyDisclaimer: true };
}

/**
 * Build a curated knowledge block for the given user query. Returns an empty
 * string when nothing relevant is found so callers can append it
 * unconditionally without altering the prompt when there is no match.
 *
 * @deprecated Prefer buildKnowledgeBlockWithMeta when you need the section IDs or disclaimer flags.
 */
export function buildKnowledgeBlock(query: string, maxChars = 2000): string {
  return buildKnowledgeBlockWithMeta(query, maxChars).block;
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
