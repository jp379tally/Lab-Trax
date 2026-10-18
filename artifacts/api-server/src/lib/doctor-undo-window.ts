/** Shared duration only; case assignment and directory merge audits are separate. */
export function readDoctorUndoWindowMs(): number {
  const raw = process.env["DOCTOR_MERGE_UNDO_WINDOW_MINUTES"];
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) return 10 * 60 * 1000;
  return Math.floor(n * 60 * 1000);
}
