export const DASHBOARD_SECTION_LABELS = {
  recentCases: "Recent Cases",
  pastDue: "Past Due",
  dueToday: "Due Today",
  dueTomorrow: "Due Tomorrow",
  noDueDate: "No Due Date",
  unassignedDocuments: "Unassigned Documents",
  exceptionCases: "Exception Cases",
} as const;

export type DashboardSectionLabelKey = keyof typeof DASHBOARD_SECTION_LABELS;
export type DashboardSectionLabel =
  (typeof DASHBOARD_SECTION_LABELS)[DashboardSectionLabelKey];
