---
name: Invoice email SMTP failure classification
description: Safe-error-handling contract for the direct nodemailer send sites in the invoices routes
---

The invoices routes send some mail directly through a nodemailer transporter (not `lib/mail.ts`, which has no attachment support). All such send sites share one classifier, `lib/smtp-error.ts::classifySmtpError()`, which maps a caught error to a category (auth/connection/recipient/unknown) plus a safe user-facing message.

**Rule:** never log or return the raw provider error message/response from an SMTP failure — log only `{smtpCategory, smtpResponseCode, smtpCode}`.
**Why:** the raw 5xx reply and error message can contain the SMTP username/password/token; a prior catch-all also made auth vs connection vs recipient indistinguishable.
**How to apply:** classify *only around the `sendMail` call itself*, not around surrounding authz/DB work — otherwise an authz/DB failure gets mislabeled as an SMTP problem. Error body is `{ok:false,message}`; the desktop `apiFetch` surfaces `message` into `ApiError`, so no client change is needed to show the reason.
