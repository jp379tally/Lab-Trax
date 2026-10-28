export function invoiceSharesNotesWithProvider(metadata: unknown): boolean {
  let value = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }

  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).shareNotesWithProvider === true
  );
}
