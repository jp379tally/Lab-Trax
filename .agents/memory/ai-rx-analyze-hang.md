---
name: AI Rx analyze-prescription hang
description: Spinner hangs before any API call when ImageManipulator.manipulateAsync is called without a timeout anywhere in the compress/quality pipeline.
---

## The rule

Every call to `ImageManipulator.manipulateAsync` anywhere in the AI pipeline must be wrapped in a `Promise.race` with an 8-second timeout. Without a timeout it hangs indefinitely on some iOS devices (confirmed by production logs — the API never receives the request at all).

**Why:** `compressImageForAI` has two separate code paths that both called `manipulateAsync`:
1. **Data URI path** (b64Len > 2 000 000): writes data URI to temp file then calls `manipulateAsync`. Fixed first (build 207).
2. **File URI loop** (lines 1400–1426 in scan.tsx): iterates candidate file URIs and calls `manipulateAsync` directly with **no timeout**. Fixed second (build 209).

Additionally `ensureHighQualityBase64` also calls `manipulateAsync` for file URIs — that one already had the 8s timeout from build 207.

Root-cause chain confirmed by deployment logs: every attempt after the early-morning 6AM session showed **zero requests reaching `/api/analyze-prescription`**, meaning the hang occurred entirely on-device before any network call.

**How to apply:**
- Whenever you write or review code that calls `ImageManipulator.manipulateAsync` on native, always wrap with:
  ```js
  const result = await Promise.race([
    ImageManipulator.manipulateAsync(uri, actions, options),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!result) { /* timed out — use fallback */ }
  ```
- Also reduce initial capture quality so photos rarely reach the > 2M char threshold at all:
  - `takePictureAsync({ quality: 0.65 })` instead of `0.8`
  - `croppedImageQuality: 72` in document scanner instead of `90`
- The 45s watchdog in `handleFinishedReview` is a last-resort safety net — it must never be the primary timeout for the image path.
- The red capture button calls **`handleDocumentScan`** (not `handleTakePhoto`). Document scanner failures fall back to `handleTakePhoto`.
