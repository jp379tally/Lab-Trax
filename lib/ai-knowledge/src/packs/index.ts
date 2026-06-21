import type { KnowledgeSection } from "../types";
import { LABTRAX_SECTIONS } from "./labtrax";
import { DENTAL_SECTIONS } from "./dental";
import { HIPAA_SECTIONS } from "./hipaa";
import { OSHA_SECTIONS } from "./osha";

export { LABTRAX_SECTIONS } from "./labtrax";
export { DENTAL_SECTIONS } from "./dental";
export { HIPAA_SECTIONS } from "./hipaa";
export { OSHA_SECTIONS } from "./osha";

/** All curated knowledge sections across every group, in a stable order. */
export const ALL_SECTIONS: KnowledgeSection[] = [
  ...LABTRAX_SECTIONS,
  ...DENTAL_SECTIONS,
  ...HIPAA_SECTIONS,
  ...OSHA_SECTIONS,
];
