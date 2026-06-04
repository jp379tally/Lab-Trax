---
name: AI Rx reader breakage = stale deploy on dropped model
description: Why the AI prescription reader recurringly "breaks", and how to confirm prod is running stale code
---

# AI Rx reader recurring breakage

The `/api/analyze-prescription` reader's recurring "works then breaks" is almost
always the **Replit AI proxy dropping a model** the deployed code leads with
(historically `gpt-4o`). The code-level fix is to lead with a current-gen vision
chain (e.g. `gpt-5.4 -> gpt-5 -> gpt-5-mini`) with strict `json_schema` output.

**Why:** the proxy periodically removes older models; when the lead model and all
fallbacks are gone the route throws and the reader errors for end users.

**How to apply / diagnose:**
- The fix being committed is NOT enough — production must be **republished**.
  Confirm prod is stale by grepping deployment logs for the success line
  `AI analyze-prescription: used <model>`. If prod only ever shows `gpt-4o` and
  never the new chain, the deploy is stale regardless of the workspace code.
- Verify model availability *live* against the real proxy before blaming the
  chain: a tiny `openai.chat.completions.create` per model. Note gpt-5.x are
  reasoning models — a low `max_completion_tokens` (e.g. 16) returns EMPTY
  content because reasoning eats the budget; use a generous budget (8192 is what
  the route uses) or the probe falsely looks broken.
- The AI client needs `AI_INTEGRATIONS_OPENAI_API_KEY` (+ optional
  `AI_INTEGRATIONS_OPENAI_BASE_URL`); missing key → 503 "AI integrations are not
  configured."
