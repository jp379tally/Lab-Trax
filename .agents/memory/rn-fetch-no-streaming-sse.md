---
name: RN global fetch cannot stream SSE
description: On-device React Native fetch has no ReadableStream resp.body; SSE consumers must use expo/fetch
---

On native devices (iOS/Android), React Native's built-in global `fetch` never exposes a streaming `resp.body` (ReadableStream) — it is `null` even on a 200 response. Any SSE/streaming consumer (`resp.body.getReader()`) using bare `fetch` silently falls into its error branch on-device while:

- the **server logs a successful 200** (the request completes; only client-side body reading fails), and
- **web preview and vitest both pass** (jsdom/browser fetch streams fine),

making it invisible to every non-device test surface. Symptom looks like a backend outage ("Something went wrong") with a perfectly healthy backend.

**Fix:** import `{ fetch as expoFetch } from "expo/fetch"` (WinterCG-compliant, streams on native) for any call that reads `resp.body`. JSON bodies are fine; only the RN `{uri,name,type}` FormData limitation (see expo-native-upload.md) needs XHR instead.

**Testing:** `vitest.setup.ts` mocks `expo/fetch` through the shared fetchHandler, so tests that need to queue a raw streaming Response must mock the `expo/fetch` vi.fn directly (mockResolvedValueOnce + mockReset in afterEach restores the setup implementation), not spy on `globalThis.fetch`.

**How to apply:** whenever adding a streaming/SSE consumer to the mobile app, grep for `getReader()` and confirm the fetch feeding it is expo/fetch, never global fetch.

**Firewall:** `artifacts/labtrax/app/__tests__/streaming-fetch-guard.test.ts` is a source-grep regression firewall that scans `app/`, `lib/`, `components/` for `.body.getReader()` and fails CI if the nearest preceding assignment of the receiver isn't from the expo/fetch import. It requires the simple `<var>.body.getReader()` form (assign the response to a variable first). Documented in REGRESSION_GUARDRAILS.md under "Streaming Fetch Firewall".
