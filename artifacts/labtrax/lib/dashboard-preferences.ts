export const DASHBOARD_PREFS_KEY = "labtrax_dashboard_prefs_v2";

export interface DashboardPrefs {
  exceptionsOpen: boolean;
  pastDueOpen: boolean;
  dueTodayOpen: boolean;
  dueTomorrowOpen: boolean;
  recentOpen: boolean;
}

export const DEFAULT_DASHBOARD_PREFS: DashboardPrefs = {
  exceptionsOpen: true,
  pastDueOpen: true,
  dueTodayOpen: true,
  dueTomorrowOpen: true,
  recentOpen: true,
};

const BOOLEAN_PREF_KEYS: (keyof DashboardPrefs)[] = [
  "exceptionsOpen",
  "pastDueOpen",
  "dueTodayOpen",
  "dueTomorrowOpen",
  "recentOpen",
];

export async function loadDashboardPrefs(
  getItem: (
    key: string,
  ) => string | null | PromiseLike<string | null>,
): Promise<Partial<DashboardPrefs>> {
  try {
    const raw = await getItem(DASHBOARD_PREFS_KEY);
    if (typeof raw !== "string" || !raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    const values = parsed as Record<string, unknown>;
    const prefs: Partial<DashboardPrefs> = {};
    for (const key of BOOLEAN_PREF_KEYS) {
      if (typeof values[key] === "boolean") prefs[key] = values[key];
    }
    return prefs;
  } catch {
    // Stored preferences are optional and must not prevent dashboard startup.
    return {};
  }
}
