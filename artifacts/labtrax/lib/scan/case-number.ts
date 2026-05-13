// Pure helpers extracted from `app/(tabs)/scan.tsx` so the case-number,
// notes-composition, and patient-initials logic can be unit-tested without
// standing up the screen.

export function nextCaseNumber(yy: string, existingCaseNumbers: string[]): string {
  const prefix = `${yy}-`;
  const max = existingCaseNumbers.reduce((acc, n) => {
    if (!n.startsWith(prefix)) return acc;
    const parts = n.split("-");
    const v = parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(v)) return acc;
    return v > acc ? v : acc;
  }, 0);
  return `${prefix}${max + 1}`;
}

export function buildPatientInitials(patientName: string): string {
  return patientName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + ".")
    .join("");
}

export function buildToothDiagram(toothIndices: string): number[] | undefined {
  const trimmed = (toothIndices || "").trim();
  if (!trimmed) return undefined;
  const nums = trimmed.match(/\d+/g);
  if (!nums) return undefined;
  const teeth: number[] = [];
  for (const n of nums) {
    const v = parseInt(n, 10);
    if (v >= 1 && v <= 32) teeth.push(v);
  }
  return teeth.length > 0 ? teeth : undefined;
}

export function buildFinalNotes(input: {
  removableSubtype?: string;
  removableArch?: "Upper" | "Lower" | "Both" | "";
  removableStage?: string;
  notes: string;
}): string {
  const { removableSubtype, removableArch, removableStage, notes } = input;
  const archLabel = removableArch === "Both" ? "Upper & Lower" : removableArch || "";
  return [
    removableSubtype ? `[${removableSubtype}]` : "",
    archLabel ? `[${archLabel}]` : "",
    removableStage ? `[Stage: ${removableStage}]` : "",
    notes.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

export function effectiveToothIndices(input: {
  caseType: string;
  removableArch?: "Upper" | "Lower" | "Both" | "";
  toothIndices: string;
}): string {
  const { caseType, removableArch, toothIndices } = input;
  if (caseType === "Removable" && removableArch) {
    return removableArch === "Both" ? "Upper, Lower" : removableArch;
  }
  return toothIndices.trim();
}
