---
name: AI Rx compressImageForAI hang
description: Why the analyze-prescription API was never called from the device — compressImageForAI hung in manipulateAsync before sendToAI was ever reached.
---

## The rule
`compressImageForAI` must not use `ImageManipulator.manipulateAsync` for typical phone photos (< 2 000 000 base64 chars ≈ 1.5 MB JPEG). Send those as-is. For very large images, wrap the resize in a `Promise.race` with a timeout so a hung manipulator cannot block the pipeline indefinitely.

**Why:** Confirmed by deployment logs — zero `/api/analyze-prescription` calls from jpp's TestFlight device. The 45-s watchdog fired every time before the API was called. `manipulateAsync` on some iOS devices hangs without throwing, and there was no timeout around it. Every real prescription photo (quality 0.8) produces a data URI > 200 000 chars, which was the old trigger threshold.

**How to apply:** The threshold is 2 000 000 chars (line ~1271 in scan.tsx). If you ever reintroduce a resize step for data URIs on native, always wrap `manipulateAsync` in a `Promise.race` with an 8-second timeout so it cannot hang indefinitely.
