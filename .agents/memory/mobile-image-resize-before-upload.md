---
name: Mobile image resize before upload
description: Always resize images client-side on mobile before uploading; full-res camera photos are ~100x larger than needed and cause multi-second stalls.
---

# Always resize images client-side before upload on mobile

**Rule:** Before any image upload from the mobile app (profile photos, logos,
attachments), resize with `ImageManipulator.manipulateAsync()` to a
reasonable output size first. Never send the raw ImagePicker URI directly
to XHR if the image could come from the camera roll.

**Why:** A modern iPhone camera roll photo at quality 0.8 is still 3–8 MB.
The server typically resizes it immediately (e.g., profile photos → 200×200
px with sharp). Sending 5 MB to receive a 30 KB result is ~150× wasted
bandwidth. On a typical mobile connection this is the difference between
an instant upload and one that stalls for 30+ seconds (the user sees
"Uploading…" indefinitely).

**How to apply:**
```ts
import * as ImageManipulator from "expo-image-manipulator";

const resized = await ImageManipulator.manipulateAsync(
  originalUri,
  [{ resize: { width: targetPx, height: targetPx } }],
  { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
);
// use resized.uri for the upload
```

**Size guidelines:**
- Profile photos: 600×600 (server will downsample to 200×200)
- Lab logos: 1200 wide (server/PDF render determines final size)
- Case attachments: keep original; don't resize (these are clinical images)

**ImagePicker quality:** Set `quality: 1` when using a manipulator step
afterward — avoid double-compression. The manipulator's `compress` setting
does the single, intentional compression.

**Note:** `expo-image-manipulator` v14 still exports `manipulateAsync`
as the primary API; the new builder pattern (`ImageManipulator.Image(...)`)
also works but `manipulateAsync` is simpler for one-shot resize.
