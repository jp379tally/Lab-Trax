---
name: Desktop installer endpoint is server-side authoritative
description: GET /desktop-installer picks the best available slot itself; a dead download link is usually fixed by Publishing the API, not rebuilding the installer.
---

The public desktop-installer endpoint is server-side authoritative about which
installer the client downloads: for locally-served `/downloads/` URLs it resolves
the configured URL to the best *available* App Storage slot (configured/active
kind → portable ZIP → macOS DMG); none available → no usable URL +
`fileFound:false`. External `https://` URLs are returned as-is and reported
available.

**Why:** the old handler echoed the configured URL blindly, so a missing EXE
produced a dead Windows link even when the ZIP/DMG slot was populated. The
fallback used to live only client-side.

**How to apply:** when a desktop download link is "dead", first check which slots
are actually populated in prod App Storage. If any exists, just Publishing the API
(deploying the resolution logic) fixes it — you do NOT need to rebuild/republish
the paid, manual-only desktop installer. Only re-run the manual build+upload if
every slot is genuinely empty.
