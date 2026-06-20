import { ALL_SECTIONS } from "./packs/index";
import type {
  KnowledgeGroup,
  KnowledgeSection,
  SelectKnowledgeOptions,
} from "./types";

const DEFAULT_MAX_CHARS = 6000;

/**
 * Common English words that carry no topical signal. Excluded from query
 * tokens so they do not inflate body-match scores.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our",
  "the", "to", "we", "what", "when", "where", "which", "who", "why", "with",
  "you", "your", "this", "that", "these", "those", "should", "would", "could",
  "will", "have", "has", "had", "about", "into", "if", "so", "but", "not",
]);

function tokenize(text: string): string[] {
  const matches: string[] = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return matches.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Render one section into the form injected into the prompt. */
function renderSection(section: KnowledgeSection): string {
  return `### ${section.title}\n${section.body}`;
}

/**
 * Score a section against the query tokens. Keyword hits dominate, title hits
 * are strong, body hits are weak. Pure and deterministic.
 */
function scoreSection(
  section: KnowledgeSection,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) return 0;

  const keywordSet = new Set(section.keywords.map((k) => k.toLowerCase()));
  const keywordText = section.keywords.join(" ").toLowerCase();
  const titleTokens = new Set(tokenize(section.title));
  const bodyLower = section.body.toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (keywordSet.has(token)) {
      score += 10;
    } else if (keywordText.includes(token)) {
      // partial keyword phrase match (e.g. "crown" within "crown & bridge")
      score += 4;
    }
    if (titleTokens.has(token)) {
      score += 5;
    }
    // word-boundary body match
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(bodyLower)) {
      score += 1;
    }
  }
  return score;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Select the most relevant knowledge sections for a query, in priority order,
 * without exceeding the structured representation. Pure — no I/O.
 */
export function selectKnowledgeSections(
  query: string,
  options: SelectKnowledgeOptions = {},
): KnowledgeSection[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (maxChars <= 0) return [];

  const queryTokens = tokenize(query ?? "");
  if (queryTokens.length === 0) return [];

  const groups: KnowledgeGroup[] | undefined = options.groups;
  const candidates = ALL_SECTIONS.filter(
    (s) => !groups || groups.includes(s.group),
  );

  const scored = candidates
    .map((section, index) => ({
      section,
      index,
      score: scoreSection(section, queryTokens),
    }))
    .filter((c) => c.score > 0)
    // Highest score first; stable tie-break by original order for determinism.
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const selected: KnowledgeSection[] = [];
  let used = 0;
  const separatorLen = 2; // "\n\n" between sections
  for (const candidate of scored) {
    const rendered = renderSection(candidate.section);
    const cost = rendered.length + (selected.length > 0 ? separatorLen : 0);
    if (used + cost > maxChars) continue;
    selected.push(candidate.section);
    used += cost;
  }
  return selected;
}

/**
 * Return a ready-to-inject knowledge block (sections joined by blank lines)
 * for the query, capped at the character budget. Returns "" when nothing is
 * relevant. The caller is responsible for any surrounding header.
 */
export function selectKnowledge(
  query: string,
  options: SelectKnowledgeOptions = {},
): string {
  const sections = selectKnowledgeSections(query, options);
  return sections.map(renderSection).join("\n\n");
}
