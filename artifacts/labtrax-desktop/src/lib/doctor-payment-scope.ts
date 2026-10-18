export type DoctorScopedRow = {
  id: string;
  practiceId?: string | null;
  providerOrganizationId?: string | null;
  doctorName?: string | null;
  doctorIdentity?: string | null;
  doctorDisplayName?: string | null;
  doctorIdentityKeys?: string[] | null;
  doctorDisplayNames?: string[] | null;
  paymentSession?: {
    providerOrganizationId?: string | null;
    doctorIdentity?: string | null;
    doctorDisplayName?: string | null;
    doctorName?: string | null;
  } | null;
};

/** The durable identity is case/whitespace insensitive, unlike its display name. */
export function normalizeDoctorIdentity(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() || "";
}

export function doctorIdentityForRow(row: DoctorScopedRow): string {
  return doctorIdentityKeysForRow(row)[0] ?? "";
}

export function doctorIdentityKeysForRow(row: DoctorScopedRow): string[] {
  const explicitKeys = row.doctorIdentityKeys?.length
    ? row.doctorIdentityKeys
    : [
        row.doctorIdentity,
        row.paymentSession?.doctorIdentity,
      ].filter((value): value is string => Boolean(value));
  const keys = [
    ...explicitKeys,
    ...(explicitKeys.length
      ? []
      : [row.doctorName, row.paymentSession?.doctorName]),
  ]
    .map(normalizeDoctorIdentity)
    .filter(Boolean);
  return [...new Set(keys)];
}

/** Display names come from the immutable snapshot, never from the identity. */
export function doctorDisplayNameForRow(row: DoctorScopedRow): string {
  return (
    row.doctorDisplayName ||
    row.doctorDisplayNames?.[0] ||
    row.paymentSession?.doctorDisplayName ||
    row.doctorName ||
    row.paymentSession?.doctorName ||
    ""
  );
}

export function visibleDoctorScopedRows<T extends DoctorScopedRow>(
  rows: T[],
  practiceFilter: string,
  doctorFilter: string,
): T[] {
  return rows.filter((row) => {
    const practiceId =
      row.practiceId ||
      row.providerOrganizationId ||
      row.paymentSession?.providerOrganizationId ||
      "";
    if (practiceFilter !== "all" && practiceId !== practiceFilter) return false;
    const doctorKeys = doctorIdentityKeysForRow(row);
    if (doctorFilter === "entire") return doctorKeys.length === 0;
    return doctorFilter === "all" || doctorKeys.includes(normalizeDoctorIdentity(doctorFilter));
  });
}

export function retainVisibleSelection(
  selected: Set<string>,
  visibleIds: Iterable<string>,
): Set<string> {
  const visible = new Set(visibleIds);
  for (const id of selected) {
    if (!visible.has(id)) {
      return new Set([...selected].filter((selectedId) => visible.has(selectedId)));
    }
  }
  return selected;
}