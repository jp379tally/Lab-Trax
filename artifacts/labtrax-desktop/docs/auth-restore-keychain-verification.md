# Desktop saved sign-in: OS keychain verification

The packaged-app smoke test runs on Windows, macOS, and Linux. It creates an
isolated temporary OS profile, uses synthetic non-account tokens, and records
only the operating system, scenario, status, and outcome. It never records
token contents or uploads the temporary profile.

Run it from the repository root:

```sh
pnpm --filter @workspace/labtrax-desktop run electron:auth-restore-smoke
```

On Linux without a visible display:

```sh
xvfb-run -a pnpm --filter @workspace/labtrax-desktop run electron:auth-restore-smoke
```

When `safeStorage` is available, the packaged smoke verifies that a saved
sign-in survives a process restart and that invalid saved data is rejected,
removed, and reported in the login screen. If the OS reports that safeStorage
is unavailable, the smoke verifies the keychain-unavailable status and login
banner instead. That run cannot exercise encrypted round-trip or corrupt-blob
handling until a keyring is available.

## Manual locked-keychain check

The hosted CI runners cannot reliably lock an interactive OS keychain. Use a
dedicated test account and a disposable OS profile; do not use a production
user's profile or capture screenshots containing account details.

1. Sign in to the packaged LabTrax Desktop app with **Remember me** enabled.
2. Close the app fully and confirm the next launch restores the sign-in.
3. Lock or make the OS keychain unavailable, then launch the app again:
   - **macOS:** In Keychain Access, select the `login` keychain and choose
     **Lock Keychain "login"**. Unlock it again in Keychain Access after the
     app reports the outcome.
   - **Windows:** Locking the Windows session does not lock DPAPI. The
     automated Windows run checks the current user's real DPAPI-backed
     storage. To test a different user profile, use a disposable second
     account and copied synthetic test data; that should be recorded as
     `decrypt-failed`, not as a locked keychain.
   - **Linux:** Use the desktop keyring manager (such as Passwords and Keys)
     to lock the login keyring. If the session has no keyring service, the
     automated Linux run forces libsecret and checks the unavailable state.
4. Record only the observed restore status and user-facing outcome:
   - `ok` — saved sign-in restored; no warning shown.
   - `keychain-unavailable` — the app keeps the saved data and explains that
     it cannot access or save sign-in until keychain access returns.
   - `decrypt-failed` — unreadable saved data is cleared and the app asks the
     user to sign in again.
5. Restore keychain access, relaunch, and confirm the expected recovery or
   sign-in-again outcome. Do not write down, screenshot, or include token
   contents in test evidence.

Record the OS, scenario, returned status, and user-visible outcome only. A
locked-keychain result of `decrypt-failed` is distinct from
`keychain-unavailable`; note it as observed rather than assuming the OS reports
both states the same way.
