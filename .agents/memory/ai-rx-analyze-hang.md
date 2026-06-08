---
name: AI Rx analyze-prescription hang
description: Spinner hangs before any API call when ensureHighQualityBase64 calls ImageManipulator with no timeout on a raw file URI from takePictureAsync.
---

## The rule

Any call to `ImageManipulator.manipulateAsync` must be wrapped in a `Promise.race` with an 8-second timeout. Without a timeout it can hang indefinitely on some iOS devices, blocking the entire AI pipeline silently.

**Why:** `handleCapturePhotoFromCamera` called `takePictureAsync()` without `base64: true`, producing a raw `file:///...` URI. `ensureHighQualityBase64` then called `ImageManipulator.manipulateAsync` on that URI with no timeout. On affected devices the call never resolves. The 45-second watchdog eventually fires and moves the user to a blank form. Confirmed by deployment logs: no `POST /api/analyze-prescription` appeared at all during the hanging session — the request never left the device.

**How to apply:**
- `handleCapturePhotoFromCamera`: call `takePictureAsync({ base64: true })` and use `photo.base64` when length > 5000. This avoids the file-system read path entirely (fastest fix).
- `ensureHighQualityBase64` and `compressImageForAI`: any `ImageManipulator.manipulateAsync` call must be `Promise.race([manipulate(...), new Promise(r => setTimeout(() => r(null), 8000))])`. A null result means timed out — fall through to the next strategy or return the original URI.
