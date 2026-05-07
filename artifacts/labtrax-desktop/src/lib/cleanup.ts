export function formatTriggeredBy(
  value: string,
  run?: { status?: string; errorMessage?: string | null },
): { label: string; isManual: boolean; isAutomatic: boolean } {
  if (
    run?.status === "error" &&
    run.errorMessage?.toLowerCase().includes("interrupted")
  ) {
    return { label: "Automatic (server restart detection)", isManual: false, isAutomatic: true };
  }
  if (
    !value ||
    value === "scheduler" ||
    value === "scheduled" ||
    value === "nightly" ||
    value === "cron"
  ) {
    return { label: "Scheduled", isManual: false, isAutomatic: false };
  }
  if (value.startsWith("admin:")) {
    const name = value.slice("admin:".length).trim();
    return { label: name ? `Manual (${name})` : "Manual", isManual: true, isAutomatic: false };
  }
  if (value === "api" || value === "script") {
    return { label: "Script", isManual: false, isAutomatic: false };
  }
  return { label: value, isManual: false, isAutomatic: false };
}
