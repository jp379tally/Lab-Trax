/**
 * The case a history-timeline entry actually belongs to.
 *
 * The case-detail History merges entries from the linked original case and
 * from remake children into the timeline of the case on screen, so an entry
 * can belong to a different case than the one being viewed.
 *
 * The attachment file route (`/api/cases/:caseId/attachments/:id/file`) is
 * scoped to the case in its URL — that scoping is how the server authorizes
 * the read. A URL built from the *viewed* case therefore 404s for a linked
 * case's attachment and the thumbnail falls back to "Unavailable".
 *
 * Prefer the source case the merge tagged the entry with, then the case id the
 * event row itself carries, and only fall back to the viewed case when neither
 * is present (e.g. legacy mobile events, which have no canonical caseId).
 */
export function historyEventCaseId(
  event:
    | { _sourceCaseId?: string | null; caseId?: string | null }
    | null
    | undefined,
  viewedCaseId: string,
): string {
  return event?._sourceCaseId || event?.caseId || viewedCaseId;
}
