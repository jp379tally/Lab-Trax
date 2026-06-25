export function redirectSystemPath({
  path,
  initial,
}: { path: string; initial: boolean }) {
  // Default landing for the authenticated app is the Dashboard tab. Case
  // deep-links (https://<domain>/cases/<caseNumber>) are still resolved and
  // navigated to by the Linking handler in app/_layout.tsx, so squashing the
  // system path here to Dashboard does not drop them.
  return '/dashboard';
}
