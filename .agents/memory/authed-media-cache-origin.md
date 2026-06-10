---
name: Authed media cache same-origin guard
description: Security rule for authed-media-cache.ts — Bearer token must only be attached to same-origin URLs.
---

## Rule

In `authed-media-cache.ts`, always call `isSameApiOrigin(absolute)` after resolving the URL. If the result is false, return `absolute` directly **without** attaching an Authorization header and **without** caching.

## Why

`resolveMediaUrl` returns external `http/https` URLs unchanged. `FileSystem.downloadAsync` with `{ headers: { Authorization: "Bearer ..." } }` would then send the JWT to a third-party host. Any attacker-controlled media URL in a case record could silently exfiltrate the user's token.

The prior `caseMediaSource` code enforced same-origin checks explicitly; new media-cache code must replicate that guard.

## How to apply

```typescript
import { isSameApiOrigin } from "./case-media-source";

const absolute = resolveMediaUrl(url);
if (!isSameApiOrigin(absolute)) return absolute; // no auth, no cache
```

Local URIs (`file://`, `data:`, `assets-library://`, `ph://`) must be returned early before reaching this check.
