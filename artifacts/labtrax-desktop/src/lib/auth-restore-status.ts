/**
 * Maps the auth-store's "tried to restore your saved sign-in" outcome to a
 * user-facing notice.
 *
 * The desktop main process tries to decrypt `auth-tokens.bin` via the OS
 * keychain on launch. Three things can go wrong without it being the user's
 * fault:
 *   - "empty"                — the user has just never signed in here; no UI.
 *   - "keychain-unavailable" — fresh Linux session with no gnome-keyring,
 *                              locked Keychain, etc. Tokens can be neither
 *                              read nor stored. Show a banner so the user
 *                              understands why "remember me" doesn't stick.
 *   - "decrypt-failed"       — the blob exists but won't decrypt (key rotated,
 *                              file corrupt). The main process clears the
 *                              blob; the renderer shows a one-time toast
 *                              explaining the user has been signed out.
 *   - "ok"                   — tokens loaded; no notice.
 *
 * Kept as a pure function so it can be unit-tested without React.
 */
export type AuthRestoreStatus =
  | "ok"
  | "empty"
  | "keychain-unavailable"
  | "decrypt-failed";

export interface AuthRestoreNotice {
  kind: "banner" | "toast";
  tone: "info" | "warning";
  message: string;
}

export function describeAuthRestoreStatus(
  status: AuthRestoreStatus,
): AuthRestoreNotice | null {
  if (status === "keychain-unavailable") {
    return {
      kind: "banner",
      tone: "warning",
      message:
        "We can't unlock your saved sign-in on this machine — LabTrax won't be able to keep you signed in until the OS keychain is available.",
    };
  }
  if (status === "decrypt-failed") {
    return {
      kind: "toast",
      tone: "warning",
      message: "Your saved sign-in expired — please sign in again.",
    };
  }
  return null;
}
