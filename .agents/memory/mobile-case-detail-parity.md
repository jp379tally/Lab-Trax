---
name: Mobile case-detail desktop parity (notes/dates)
description: Non-obvious server-contract + desktop-default facts the mobile case-detail edit screen must mirror 1:1.
---

# Mobile case-detail ⇄ desktop parity constraints

The Phase 2 rule is **strict 1:1 with desktop — no mobile-only divergence**. Two
defaults are easy to get wrong because the "obvious" mobile choice is the unsafe one.

## Note visibility default = `internal_lab_only`
Desktop's note composer defaults `shareWithProvider: false` → `internal_lab_only`.
Mobile MUST default the same.

**Why:** defaulting a new note to `shared_with_provider` is both a strict-parity
violation AND an information-disclosure footgun — a tech jotting a casual internal
note would expose it to the provider by default. An architect review blocked M1 over
exactly this.
**How to apply:** any new note-entry UI defaults to internal; sharing is an explicit
opt-in toggle, never the default.

## `dueDate` is NOT clearable; `expectedDeliveryDate` IS
Server contract on `PATCH /cases/:id`: `dueDate` is `z.string().optional()`
(non-nullable) while `expectedDeliveryDate` is nullable. A changed-fields-only PATCH
builder only sends a truthy `dueDate`, so a "Clear due date" control is a silent
no-op.
**How to apply:** don't offer a Clear/null action for `dueDate`; only
`expectedDeliveryDate` may be cleared to `null`. Mirrors desktop.

## Status edit path
Mobile changes case status through the **same canonical `PATCH /cases/:id`** desktop
uses — there is no separate mobile status endpoint. Keep it that way.
