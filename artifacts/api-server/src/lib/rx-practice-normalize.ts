import { normalizeDoctorForCompare } from "./doctor-similarity.js";

/**
 * Normalizes an Rx practice name for alias storage and lookup.
 *
 * Trims leading/trailing whitespace, collapses any sequence of internal
 * whitespace to a single space, and lowercases the result.  This makes alias
 * keys stable across OCR output that may produce varying numbers of spaces.
 */
export function normalizeRxPracticeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalizes a doctor name for the per-doctor practice memory
 * (`rx_doctor_practice_memory`).
 *
 * Unlike the practice-name key above, a doctor name needs the "Dr."/"Dr" title
 * and punctuation to collapse too, so "Dr. Avery Example", "dr avery
 * example", and "Avery  Example" all resolve to the SAME remembered
 * practice. This deliberately reuses the shared doctor-compare normalization
 * that powers duplicate clustering and the AI "did you mean?" suggestions, so
 * the memory key can never drift from how the app decides two doctor names are
 * the same person.
 *
 * Returns "" when nothing meaningful remains — callers must treat that as "no
 * usable key" rather than storing an empty row.
 */
export function normalizeRxDoctorName(name: string): string {
  return normalizeDoctorForCompare(name);
}
