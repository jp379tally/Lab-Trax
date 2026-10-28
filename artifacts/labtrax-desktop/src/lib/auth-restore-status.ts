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
 *                              unreadable, or corrupt). The main process
 *                              attempts to clear the blob; the renderer
 *                              explains that the user must sign in again.
 *   - "session-expired"      — the saved tokens were restored, but the server
 *                              rejected the session. The renderer asks the
 *                              user to sign in again.
 *   - "restore-failed"       — saved tokens were restored but the server
 *                              could not verify them; the user can retry or
 *                              sign in manually.
 *   - "ok"                   — tokens loaded; no notice.
 *
 * Kept as a pure function so it can be unit-tested without React.
 */
export type AuthRestoreStatus =
  | "ok"
  | "empty"
  | "keychain-unavailable"
  | "decrypt-failed"
  | "session-expired"
  | "restore-failed";

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
        "LabTrax can't access this device's OS keychain yet. It will keep checking and restore your saved sign-in automatically when access returns. You can sign in manually now; to stay signed in next time, unlock or enable the OS keychain (on Linux, start gnome-keyring or kwallet).",
    };
  }
  if (status === "decrypt-failed") {
    return {
      kind: "toast",
      tone: "warning",
      message:
        "LabTrax couldn't read the saved sign-in on this device. Sign in again to continue. LabTrax won't use the unreadable saved data.",
    };
  }
  if (status === "session-expired") {
    return {
      kind: "toast",
      tone: "warning",
      message:
        "Your saved sign-in was restored, but the session has expired. Sign in again to continue.",
    };
  }
  if (status === "restore-failed") {
    return {
      kind: "toast",
      tone: "warning",
      message:
        "LabTrax recovered your saved sign-in but couldn't verify it with the server. Check your connection and sign in again if needed.",
    };
  }
  return null;
}
