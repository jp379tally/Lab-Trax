export type DueTomorrowSort =
  | "entered"
  | "case_number"
  | "doctor"
  | "location"
  | "due_date"
  | "type";

export const DUE_TOMORROW_SORT_LABELS: Record<DueTomorrowSort, string> = {
  entered: "Entered date",
  case_number: "Case number",
  doctor: "Doctor",
  location: "Location",
  due_date: "Due date",
  type: "Case Type",
};

export interface DueTomorrowSortableCase {
  id?: string | null;
  caseNumber?: string | null;
  doctorName?: string | null;
  createdAt?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
}

export interface DueTomorrowSortSelectors<T> {
  getLocationLabel: (caseItem: T) => string | null | undefined;
  getTypeIndicator: (caseItem: T) => string | null | undefined;
}

function comparableDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function comparableText(value: unknown): string | null {
  const normalized =
    typeof value === "string" ? value.trim().toLocaleLowerCase() : null;
  return normalized || null;
}

function compareNullable(
  a: string | number | null,
  b: string | number | null,
  direction: "asc" | "desc" = "asc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "desc" ? -result : result;
}

function dueTimeMinutes(time: string | null | undefined): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function compareDueDate(
  a: DueTomorrowSortableCase,
  b: DueTomorrowSortableCase,
): number {
  const dateResult = compareNullable(
    comparableDate(a.dueDate),
    comparableDate(b.dueDate),
  );
  if (dateResult !== 0) return dateResult;
  if (comparableDate(a.dueDate) === null) return 0;
  return compareNullable(dueTimeMinutes(a.dueTime), dueTimeMinutes(b.dueTime));
}

function caseIdTieBreak(
  a: DueTomorrowSortableCase,
  b: DueTomorrowSortableCase,
): number {
  return (a.id ?? "").localeCompare(b.id ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Sorts an already-filtered Due Tomorrow bucket without mutating it.
 * Missing values sort last and case id provides a deterministic final order.
 */
export function sortDueTomorrowCases<T extends DueTomorrowSortableCase>(
  cases: readonly T[],
  sort: DueTomorrowSort,
  selectors: DueTomorrowSortSelectors<T>,
): T[] {
  return [...cases].sort((a, b) => {
    let result = 0;
    switch (sort) {
      case "entered":
        result = compareNullable(
          comparableDate(a.createdAt),
          comparableDate(b.createdAt),
          "desc",
        );
        break;
      case "case_number":
        result = compareNullable(
          comparableText(a.caseNumber),
          comparableText(b.caseNumber),
        );
        break;
      case "doctor":
        result = compareNullable(
          comparableText(a.doctorName),
          comparableText(b.doctorName),
        );
        break;
      case "location":
        result = compareNullable(
          comparableText(selectors.getLocationLabel(a)),
          comparableText(selectors.getLocationLabel(b)),
        );
        break;
      case "due_date":
        result = compareDueDate(a, b);
        break;
      case "type":
        result = compareNullable(
          comparableText(selectors.getTypeIndicator(a)),
          comparableText(selectors.getTypeIndicator(b)),
        );
        break;
    }
    return result || caseIdTieBreak(a, b);
  });
}