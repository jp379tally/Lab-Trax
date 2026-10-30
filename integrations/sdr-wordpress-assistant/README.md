# SDR and LabTrax support assistants

Implementation draft, 2026-10-27. Not deployed or enabled in production.

## What is included

- SDRDL.com: floating “Ask SDR” FAQ widget with SDR services, digital impression guidance, iTero ID 40938, contact details and LabTrax account access.
- LabTrax: “AI Support” tab in the web/desktop provider portal, using its current login and selected practice. Existing Maynard tools are preserved.
- A standalone account-support page at `/api/support-assistant/portal`, linked from the public widget. A visitor signs in through LabTrax and reopens account support. A provider with multiple practices must select one.
- Read-only lookups of case number, status, due date and expected delivery; invoice number, status, total and balance when billing access is permitted. Queries return at most 10 recent matching records and are explicitly labeled a sample. They do not compute whole-account totals.
- No writes, message sending, password access, clinical advice, payment collection, uploads or autonomous actions.

## Knowledge and permissions

FAQ is curated in `artifacts/api-server/src/lib/support-assistant.mjs`. It was checked against SDR's public home, services and contact pages on 2026-10-27. The owner-provided phone update takes precedence: main 850-201-4531; text-only 850-363-8750. The website still shows the text number without that distinction. Prices, turnaround, shipping exceptions and warranties are not asserted without an approved source. Update this reviewed FAQ as policies change.

Public requests have no database tools, even when the browser has a LabTrax session. Public widget requests omit credentials. The secure page is top-level inside LabTrax; no tokens or patient data are passed to WordPress or between frames.

Account lookups use existing verified login, active provider-practice selection and provider capabilities. Membership and entitlements are rechecked for each tool call. Practice selection cannot widen access. Case queries exclude deleted rows, and closed cases require portal entitlement. Invoice queries exclude deleted rows and require billing capability. Lab staff continue using Maynard; the new account assistant is for providers. Case access follows LabTrax's existing practice assignment model, not a new per-person assignment model.

Only projected fields are sent to the model: no patient names, RX text, notes, attachments, bank details or internal staff comments are retrieved. User questions themselves are sent to the AI provider. API requests use `store:false`. No new chat-history or AI-learning records are created. An audit event records the account-answer outcome and practice, without the question or answer. Review upstream account retention and patient-data processing settings before broad rollout; `store:false` alone is not a zero-retention guarantee.

## Deployment

1. Review and test this branch alongside the latest Replit source. No database migration or production-data mutation is needed. Do not overwrite ongoing Replit work with an older checkout.
2. In the API environment, use the existing `AI_INTEGRATIONS_OPENAI_API_KEY` and optional `AI_INTEGRATIONS_OPENAI_BASE_URL`. Never put a key in WordPress or browser code. Ensure that the configured provider supports the Responses API with function calling.
3. Set `SUPPORT_ASSISTANT_ENABLED=true`. Optional `SUPPORT_ASSISTANT_MODEL` defaults to the same `gpt-5-mini` family already used by Maynard. Disabling the flag hides the provider tab and disables the widget/assistant routes.
4. Deploy the reviewed API and desktop/web frontend together through the existing release gates. Run the focused tests, API type checking and normal release checks. Verify real Responses API support and credentials in staging.
5. Upload `sdr-lab-assistant.zip` via WordPress → Plugins → Add New → Upload Plugin and activate it. The plugin loads the public widget from `https://lab-trax.replit.app/api/support-assistant/widget.js`. It requires no WordPress API key or credentials.
6. If WordPress has a Content Security Policy, allow the LabTrax origin in its script-src and frame-src rules. The widget page permits framing only by `https://sdrdl.com`, `https://www.sdrdl.com` and its own origin. The private page cannot be framed.

For a non-WordPress page, place this before `</body>`:

```html
<script defer src="https://lab-trax.replit.app/api/support-assistant/widget.js"></script>
```

## Checks before launch

Use synthetic records in staging to verify anonymous FAQs, one-practice login, multi-practice switching, unassigned/inactive/unverified/revoked users, another practice's case number, deleted cases, closed-case entitlement, billing access denial, explicit invoice lookup, mobile viewport, keyboard navigation, session expiry and AI-provider outage. Confirm the widget itself never receives account data. Public and account answers must not claim changes or guaranteed delivery.

Focused tests live beside the new server modules and routes. These cover the model/tool boundary, auth and verified-account gating, selected-practice validation, SQL scoping, data projection, tool limits, error redaction and embedding headers. Mocked tests are not proof of a live sign-in or production data access. Live AI, WordPress activation and on-device verification remain deployment checks.

Draft validation: 26 focused server checks and 3 provider-interface checks passed locally using mocked AI/database access. JavaScript syntax and whitespace checks passed. A real browser could not be launched because the browser download was unavailable in this environment. Full workspace type checking, the complete regression suite, live AI calls and production login were not run. Base source: GitHub commit `1c2e9ebfd23d6c50147bc806c3430013e2edec44`; Replit synchronization has not been verified in this task.

## Rollback

Set `SUPPORT_ASSISTANT_ENABLED=false` and deactivate the WordPress plugin. Existing Maynard, cases, invoices and data remain in place. No schema rollback is required.
