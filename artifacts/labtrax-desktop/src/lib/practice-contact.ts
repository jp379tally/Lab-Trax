/**
 * Contact details for the practice a case is assigned to.
 *
 * Two sources can supply them and they are not interchangeable:
 *  - the authorized case detail payload (`providerOrganizationContact`), which
 *    the server only returns for the practice the case is actually linked to;
 *  - the organizations list the drawer already loads, which may omit a
 *    practice the viewer cannot list but can still see through the case.
 *
 * The resolver below keeps those straight so a different practice's address or
 * phone can never be shown next to this case's practice name.
 */
export interface PracticeContactDetails {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
}

export interface ResolvedPracticeContact {
  /** Display name for the practice, or null when nothing names it. */
  name: string | null;
  /** Formatted address lines, empty when the practice has no address on file. */
  addressLines: string[];
  /** Raw phone number as stored, or null when none is on file. */
  phone: string | null;
}

/**
 * Street / city-state-zip lines, skipping anything missing. Returns an empty
 * array rather than placeholder text when no address field is populated.
 */
export function formatPracticeAddressLines(
  contact: PracticeContactDetails | null | undefined,
): string[] {
  if (!contact) return [];
  const lines: string[] = [];
  const line1 = (contact.addressLine1 ?? "").trim();
  const line2 = (contact.addressLine2 ?? "").trim();
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);
  const cityState = [contact.city, contact.state]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const cityStateZip = [cityState, (contact.zip ?? "").trim()]
    .filter(Boolean)
    .join(" ");
  if (cityStateZip) lines.push(cityStateZip);
  return lines;
}

/**
 * Pick the contact record that belongs to the practice currently selected on
 * the case.
 *
 * `caseContact` is preferred because it is the authorized, case-scoped copy,
 * but it describes `casePracticeId` only — once a different practice is staged
 * in the editor it no longer applies and the list entry (if the viewer has
 * one) takes over. When neither source describes the selected practice, no
 * contact details are reported at all; stale details are worse than none.
 */
export function resolvePracticeContact({
  selectedPracticeId,
  casePracticeId,
  caseContact,
  listOrganization,
}: {
  selectedPracticeId: string | null | undefined;
  casePracticeId: string | null | undefined;
  caseContact: PracticeContactDetails | null | undefined;
  listOrganization:
    | (PracticeContactDetails & { id?: string; displayName?: string | null })
    | null
    | undefined;
}): ResolvedPracticeContact {
  if (!selectedPracticeId) {
    return { name: null, addressLines: [], phone: null };
  }
  const listMatches =
    !!listOrganization &&
    (listOrganization.id === undefined || listOrganization.id === selectedPracticeId);
  const resolvedList = listMatches ? listOrganization : null;
  const scopedCaseContact =
    casePracticeId && selectedPracticeId === casePracticeId ? caseContact ?? null : null;

  const contact = scopedCaseContact ?? resolvedList ?? null;
  const name =
    (resolvedList?.displayName ?? "").trim() ||
    (resolvedList?.name ?? "").trim() ||
    (scopedCaseContact?.name ?? "").trim() ||
    null;

  return {
    name,
    addressLines: formatPracticeAddressLines(contact),
    phone: (contact?.phone ?? "").trim() || null,
  };
}
