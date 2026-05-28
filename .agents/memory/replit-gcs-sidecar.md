---
name: Replit GCS sidecar auth
description: How to get usable OAuth tokens / direct download URLs when using Replit Object Storage with @google-cloud/storage.
---

When `@google-cloud/storage` is configured with Replit's `external_account` (federated) credentials pointing at the local sidecar (`http://127.0.0.1:1106`), two things are NOT available that people often assume are:

1. **`file.getSignedUrl()` does not work.** It requires a private-key service account to sign locally. Federated/external_account credentials have no private key, so signing throws and returns null. Do not rely on signed URLs as the proxy-bypass fast path on Replit.

2. **You cannot GET the sidecar `/token` endpoint directly.** It is a POST-only STS endpoint and returns `405 Method Not Allowed` on GET. Any code shaped like `await fetch(`${SIDECAR}/token`)` is broken and will silently return null forever.

**The right way to get an access token** for building a direct `https://storage.googleapis.com/<bucket>/<obj>?access_token=...` URL:

```ts
const authClient = await storageClient.authClient.getClient();
const tokenResponse = await authClient.getAccessToken();
const accessToken = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
```

The `google-auth-library` client knows how to do the federated STS exchange against the sidecar correctly.

**Why:** Replit's reverse proxy drops long-running connections (~145 MB+ streamed files time out — observed repeatedly with `LabTrax-Windows-Portable.zip`). Streaming large GCS objects through the API server is not viable; we have to redirect the browser to GCS directly. With federated creds the only working pattern is the access-token-in-URL direct path above.

**How to apply:** Any `/downloads/*`-style route that streams from Object Storage on Replit must redirect (302) to a direct GCS URL built with `authClient.getAccessToken()` before falling back to a server-side stream. Token URLs are sensitive — set `Cache-Control: no-store` and keep token lifetimes short.
