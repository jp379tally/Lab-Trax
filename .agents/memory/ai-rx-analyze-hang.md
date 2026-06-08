---
name: AI Rx analyze-prescription hang
description: Spinner hangs before any API call when ImageManipulator.manipulateAsync is called without a timeout anywhere in the compress/quality pipeline.
---

## The rule

Every call to `ImageManipulator.manipulateAsync` anywhere in the AI pipeline must be wrapped in a `Promise.race` with an 8-second timeout. Without a timeout it hangs indefinitely on some iOS devices (confirmed by production logs — the API never receives the request at all).

**Why:** `compressImageForAI` has two separate code paths that both called `manipulateAsync`:
1. **Data URI path** (b64Len > 2 000 000): writes data URI to temp file then calls `manipulateAsync`. Fixed first (build 207).
2. **File URI loop** (lines 1400–1426 in scan.tsx): iterates candidate file URIs and calls `manipulateAsync` directly with **no timeout**. Fixed second (build 210).

Additionally `ensureHighQualityBase64` also calls `manipulateAsync` for file URIs — that one already had the 8s timeout from build 207.

Root-cause chain confirmed by deployment logs: every attempt after the early-morning 6AM session showed **zero requests reaching `/api/analyze-prescription`**, meaning the hang occurred entirely on-device before any network call.

## Second bug: empty payload even after timeout fix (build 211)

Even when `manipulateAsync` does NOT hang (returns within 8s), it can return a URI pointing to an empty or near-empty file on some iOS devices. The original code read the file unconditionally:

```js
const fileBase64 = await FileSystem.readAsStringAsync(manipulated.uri, ...);
return `data:image/jpeg;base64,${fileBase64}`;  // no length check!
```

Production evidence: one request reached the server with `imageBase64.length=31, rawB64.length=8` — exactly `data:image/jpeg;base64,` (23 chars) + 8 garbage chars. Server rejected it with 400 IMAGE_TOO_SMALL.

The same missing check existed in the `handleFinishedReview` fallback path (the catch block that copies the file and reads it directly).

**Fix (build 211):** After every `readAsStringAsync` call in the compress pipeline, check `fileBase64.length >= 5000` before returning. If it's too short, log and fall through to the next URI attempt instead of returning garbage. Same guard in the `handleFinishedReview` fallback — throw instead of using sub-5000 char data.

## Invoice auto-generation

`addCase()` in `app-context.tsx` automatically creates an `INV-<caseNumber>` invoice on every case creation. Line items are populated only when `material` is set. If AI doesn't detect material, invoice is created with $0 / empty line items — expected; user fills in manually. The "generate invoice" step is NOT a separate action.

**How to apply:**
- Whenever you write or review code that calls `ImageManipulator.manipulateAsync` on native, always wrap with 8s `Promise.race`.
- After every `readAsStringAsync` in the AI compress pipeline, gate on `fileBase64.length >= 5000` before using the data.
- Also reduce initial capture quality so photos rarely reach the > 2M char threshold at all:
  - `takePictureAsync({ quality: 0.65 })` instead of `0.8`
  - `croppedImageQuality: 72` in document scanner instead of `90`
- The 45s watchdog in `handleFinishedReview` is a last-resort safety net — it must never be the primary timeout for the image path.
- The red capture button calls **`handleDocumentScan`** (not `handleTakePhoto`). Document scanner failures fall back to `handleTakePhoto`.
