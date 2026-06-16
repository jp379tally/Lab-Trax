---
name: iTero Rx object-storage mirror gap
description: The single-file iTero poller endpoint was missing the object-storage mirror that ZIP import paths had, causing Rx PDFs to 404 after any server restart.
---

## Rule

Every code path in `import-from-itero-rx` (and any future iTero-style import endpoint) that writes a file to `uploads/case-media/` via multer **must** also call `writeCaseMediaToObjectStorage` after the transaction commits.

**Why:** The server's local disk is ephemeral — any restart or re-deployment wipes it. Files saved only to disk 404 permanently once the server restarts. The ZIP import paths (`import-from-itero-zip`, `processOneIteroZipFile`, `import-from-itero-zip-batch`) all had this mirror; the single-file poller route (`import-from-itero-rx`) was missing it. This caused TestFlight users to see "couldn't be opened" errors on Rx PDFs attached to iTero-imported cases.

**How to apply:**
- Pattern: fire-and-forget after transaction commits, read buf from disk via `fs.promises.readFile(req.file.path)`, then call `writeCaseMediaToObjectStorage(filename, buf, mimetype)`.
- Failures are caught and logged as warn — never block or roll back the response.
- Test: mock `../lib/case-media-object-storage.js` with `vi.hoisted()` and poll up to 2 s for the fire-and-forget to complete, then assert `toHaveBeenCalledOnce()`.
- Guarded by: `cases-ai-reader.test.ts` — "mirrors Rx PDF to object storage after successful import".
