---
name: Editable draft-invoice preview price overrides
description: How inline price edits in the desktop Rx drop-zone preview flow into case creation, and the two non-obvious contracts that keep them aligned.
---

The desktop Rx drop-zone (DashboardDropZone) shows a draft-invoice preview
(POST /invoices/preview-draft) and lets the user edit each line's unit price /
mark it no-charge before POST /cases. Two contracts make this work — both are
easy to silently break.

## 1. $0 needs an explicit override flag or the server auto-prices it back
POST /cases auto-prices any restoration whose `unitPrice` is not > 0. So a
deliberate "no charge" ($0) line would be overwritten with the fee-schedule
price. The fix: an optional `priceOverridden: boolean` on the restoration
schema. When true, `userSupplied` and `needsAutoPrice` treat the line as
manual even at $0 (priceSource "manual").

**Why:** without the flag there is no way to distinguish "user left it blank,
auto-price it" from "user deliberately set $0". The flag is the only signal.

**How to apply:** any client (desktop, future mobile) that lets a user set a
$0 / no-charge restoration must send `priceOverridden: true`, not just
`unitPrice: 0`.

## 2. Preview line ↔ create restoration mapping is positional
The preview groups restorations into lines (by material/type, or bridge spans).
To map a user's edit on a grouped line back to the right restorations, the
preview response returns `restorationIndices` per line — indices into the
request `restorations` array (the server's synthetic restoration id IS the
input index). The client keys overrides by `restorationIndices.join("-")` and
applies them by position when building the create payload.

**Why:** this only stays correct because the preview effect and the create flow
build the `restorations` array from the *same* teeth list in the *same* order
(teeth in order, or a single stub when no teeth). If those two builders ever
diverge in order/contents, edits attach to the wrong restorations.

**How to apply:** keep the preview-effect restoration builder and the
proceedCreateCase restoration builder structurally identical. The grouping
helper exposes `groupedRestorationIds` (SyncLineItem) which the endpoint maps
to `restorationIndices`.
