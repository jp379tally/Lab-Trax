---
name: Mobile CaseStatus canonical migration
description: Why the labtrax mobile CaseStatus model normalizes statuses on ingest instead of trusting the server feed
---

The mobile app's `CaseStatus` (artifacts/labtrax/lib/data.ts) uses canonical
lowercase values identical to the server's `cases.status` column
(received, in_design, scan, in_milling, post_mill, sintering_furnace,
model_room, in_porcelain, qc, shipped, on_hold, complete).

**Non-obvious trap:** the server's legacy mobile endpoints
(`GET /api/legacy/cases` and `/api/legacy/cases/:id` in
api-server `routes/labtrax-routes.ts`) still translate canonical→UPPERCASE via
`DESKTOP_TO_MOBILE_STATUS` before sending to mobile. Historical `lab_cases`
JSON blobs also hold uppercase tokens. So a "the server already returns
lowercase" assumption is WRONG for the legacy feed.

**The rule:** mobile must normalize statuses on every ingest boundary —
server fetch, AsyncStorage hydration, and any canonical-case adapter — via
`normalizeCaseStatus()` / `normalizeCaseStatuses()` in lib/data.ts. Do NOT
change the server endpoints to fix this on the mobile side.

**Why:** mixing uppercase and lowercase tokens silently broke status filters
and progress bars (lookup maps keyed one way, data the other). Centralizing in
one alias map (STATUS_ALIASES) covering legacy-uppercase, desktop-bridge, and
canonical tokens means there is a single place to extend.

**How to apply:** when adding a new ingest path or a new status, extend
STATUS_ALIASES + STATIONS, and keep any status-keyed lookup map
(e.g. CaseProgressBar STATUS_PROGRESS) keyed by canonical lowercase. Custom
station labels (AsyncStorage) are migrated on load by remapping keys through
normalizeCaseStatus.
