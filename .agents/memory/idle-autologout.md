---
name: Idle auto-logout architecture
description: How inactivity logout and Remember Username are implemented across desktop and mobile.
---

# Idle auto-logout and Remember Username

## Desktop (artifacts/labtrax-desktop)

**Idle timer** — `AppLayout.tsx` (wraps entire authed shell):
- Module-level `IDLE_TIMEOUT_MS = 2 * 60 * 1000`
- `useRef` tracks `lastActivityRef` (timestamp of last user action)
- `useEffect` adds passive event listeners (mousemove/mousedown/keydown/wheel/touchstart) that update the timestamp; a `setInterval` every 10s checks if elapsed ≥ 2 min
- On timeout: sets `sessionStorage.setItem("labtrax_auto_logout", "1")` then calls `logout()`
- On unmount: clears interval and removes listeners

**Login page** — `login.tsx`:
- On mount: reads `localStorage.getItem("labtrax_desktop_remembered_username")` → pre-fills username, checks `sessionStorage("labtrax_auto_logout")` → shows notice
- "Remember my username" checkbox: saves/clears `labtrax_desktop_remembered_username` in localStorage on submit
- Auto-logout notice: sky-blue banner shown once (sessionStorage cleared on read)

## Mobile (artifacts/labtrax)

**Idle timer** — already existed in `lib/auth-context.tsx`:
- `INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000` (was 3 min)
- Timer fires `setIsLocked(true)` → shows LockScreen (biometric/password), NOT full logout
- Touch detection: `PanResponder` in `app/_layout.tsx` calls `resetInactivityTimer()` on every touch
- AppState listener locks immediately when app goes to background

**Why lock not logout on mobile:** biometric unlock is the appropriate UX; full logout destroys the session and is too disruptive on mobile.

**Remember Username** — `components/LoginScreen.tsx`:
- AsyncStorage key: `@labtrax_remembered_username`
- useEffect on mount reads and pre-fills; handleLogin saves/clears based on checkbox state
