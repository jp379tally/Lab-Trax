---
name: LabTrax Desktop PWA stale clients
description: Why deployed desktop-web UI changes don't reach returning users, and the SW fix.
---
The desktop web app (`artifacts/labtrax-desktop`) uses vite-plugin-pwa with
`registerType: "autoUpdate"` + `strategies: "injectManifest"` (custom `src/sw.ts`).

**Pitfall:** with injectManifest, vite-plugin-pwa does NOT auto-inject
`skipWaiting`/`clientsClaim` — that only happens for the generateSW strategy.
If the custom `sw.ts` omits them, a newly deployed service worker installs but
stays in the "waiting" state forever, so returning users keep being served the
OLD precached `index.html` + hashed chunks. Symptom: "we republished but users
still don't see the new UI" (e.g. a missing invoice Save button) even though the
live chunk demonstrably contains the new code.

**How to diagnose:** fetch the live invoices route chunk (not `index-*.js`) and
grep for the new string — if it's present, the deploy is fine and the culprit is
the SW. Then `curl <site>/sw.js` and grep for `skipWaiting`; if absent, that's it.

**Fix:** in `src/sw.ts` call `self.skipWaiting()` at top level and
`self.clients.claim()` in an `activate` listener. The injected autoUpdate
registrar then reloads open clients onto the fresh build. A new sw.js carrying
these calls self-activates on install, so it recovers users stuck on the old SW
once it's deployed (browsers always re-fetch sw.js).

**Why:** ties into the general "code correct but UI missing = stale client" rule.
