export type KnowledgeGroup = "labtrax" | "dental" | "hipaa";

/**
 * A single curated knowledge section. Sections are the unit of retrieval:
 * `selectKnowledge` scores and selects whole sections within a budget.
 */
export interface KnowledgeSection {
  /** Stable unique id, e.g. "labtrax.cases". */
  id: string;
  group: KnowledgeGroup;
  /** Short human-readable heading. */
  title: string;
  /**
   * Topic keywords used by the selector. Lowercase, single words or short
   * phrases. These dominate relevance scoring.
   */
  keywords: string[];
  /** The reference text injected into the AI system prompt. */
  body: string;
}

export interface SelectKnowledgeOptions {
  /**
   * Maximum number of characters the returned block may occupy. The selector
   * never exceeds this budget. Defaults to a conservative prompt-friendly size.
   */
  maxChars?: number;
  /** Restrict selection to a subset of groups. Defaults to all groups. */
  groups?: KnowledgeGroup[];
}
