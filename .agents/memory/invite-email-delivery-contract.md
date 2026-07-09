---
name: Invite email delivery contract
description: Truthful invite email outcomes — tri-state DNS preflight, safe failure reasons, delivery status recorded on the invite row.
---

# Invite email delivery contract

- Invite email sends must never be silent: every attempt records lastEmailAttemptAt/lastEmailStatus (sent/failed/skipped) + lastEmailError on the invite row, and create/resend responses expose an `emailDelivery` outcome (create stays 201 even on failure; resend is 502 on send failure, 409 on recipient opt-out).
- **Why:** invites used to report success while the email silently failed; lab owners couldn't tell why staff never received them.
- **How to apply:** any new email-sending flow around invites (or similar user-facing sends) should reuse the shared delivery helper pattern: record the outcome, expose it in the response, and surface it in listings/UI.

## Safe failure reasons

Raw SMTP/provider errors must never reach clients — only an allowlist of safe reasons (disabled_in_test, smtp_not_configured, reserved_domain, undeliverable_domain, recipient_opted_out) passes through; everything else collapses to "send_failed". Full detail goes to server logs only.

## DNS preflight is tri-state

Domain deliverability preflight returns deliverable/undeliverable/unknown. Only a definitive negative (ENOTFOUND/ENODATA/NXDOMAIN on BOTH MX and A lookups) is "undeliverable". Transient lookup errors are "unknown", are NEVER cached, and fall through to a real SMTP attempt (with a warn log).
**Why:** a binary check treated transient DNS failures as permanent and cached them, silently blocking mail to perfectly valid domains.
