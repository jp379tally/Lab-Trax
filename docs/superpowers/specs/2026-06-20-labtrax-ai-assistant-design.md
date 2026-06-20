# LabTrax AI Assistant — Design Spec

- **Date:** 2026-06-20
- **Status:** Draft — awaiting user approval
- **Source brief:** User-provided "LabTrax AI Assistant Vision & Product Specification" (PRD)
- **This spec covers:** **Phase 1 only** (Knowledge + Memory Foundation). Later phases are summarized for context but are out of scope here.

---

## 1. Vision (from the PRD)

A deeply integrated, proactive AI that acts as a knowledgeable virtual employee for every dental lab on LabTrax: it understands LabTrax, the dental-lab domain, and HIPAA; learns each lab's nomenclature and habits; proactively reminds, suggests, and flags risks; and answers questions over the lab's real data.

### Phased roadmap (PRD's MVP recommendation — adopted)

| Phase | Theme | In this spec? |
|-------|-------|---------------|
| **1** | Knowledge base (LabTrax + dental + HIPAA) and AI **memory foundation** | **Yes** |
| 2 | Smart suggestions, missing-info detection, workflow recommendations, notification + pop-up-bubble integration | No (next) |
| 3 | Behavioral learning, personalization engine, predictive analytics | No |
| 4 | Full proactive assistant, voice, advanced operational intelligence | No |

Each phase gets its own spec → plan → build cycle. This document is Phase 1.

---

## 2. Phase 1 Goals & Non-Goals

### Goals
1. Make the **existing** AI Chat and AI Agent genuinely expert about (a) LabTrax features/workflows, (b) the dental-lab domain, (c) HIPAA compliance.
2. Establish a **memory foundation**: durable, per-lab storage for the lab's glossary/nomenclature and preferences, injected into every AI answer.
3. Provide a minimal way to manage that memory (view/add/remove glossary terms) so it is usable on day one.
4. Ship **additively** — no behavior change to any existing protected workflow.

### Non-Goals (deferred to later phases)
- Proactive pop-up "assistant bubbles" and suggestion surfacing (Phase 2).
- **Automatic** learning of nomenclature/behavior from audit logs (Phase 3). Phase 1 stores memory; it does not auto-populate it.
- Voice, predictive analytics, operational-manager features (Phase 4).
- Any change to the AI Reader's Rx-extraction prompts (handled separately — see §11).

---

## 3. Key Architectural Decision: how the AI "knows" things

Three options considered:

- **A — Curated knowledge packs injected into the system prompt (RECOMMENDED).** Author structured, version-controlled knowledge documents; a lightweight selector picks the sections relevant to the user's message (within a token budget) and prepends them to the existing chat/agent system prompt.
  - *Pros:* accurate and fully controllable, instantly editable in code review, no new infrastructure or dependencies, cheap and fast, contains zero PHI (it is general reference), easy to keep HIPAA/feature facts current. Designed so it can graduate to option B later.
  - *Cons:* context-budget bound — must select relevant sections rather than dumping everything. Acceptable for a curated, modest corpus.
- **B — Vector RAG (embeddings + vector store).** Chunk + embed knowledge, retrieve top-k per query.
  - *Pros:* scales to a very large corpus. *Cons:* new infra (vector store), an embedding/ingestion pipeline, more moving parts and cost. Overkill for Phase 1's curated corpus.
- **C — Fine-tuning a model.** Rejected: slow to iterate, opaque, no per-lab control, and hard to keep HIPAA/feature facts current.

**Decision: A, structured so it can graduate to B** when the corpus outgrows the prompt budget. The selector is the seam: today keyword/topic match; later it can become embedding retrieval without changing callers.

---

## 4. Components (all additive)

1. **`@workspace/ai-knowledge` (new shared lib, `lib/ai-knowledge/`)** — the curated knowledge packs and the selector.
   - `labtrax/` — platform how-to/FAQ: cases, prescriptions, invoicing, scheduling, customers, production/status tracking, notifications, reporting, billing, mobile workflows, permissions, task management, audit logs, AI Reader, AI Chat.
   - `dental/` — crown & bridge, dentures, partials, implants, surgical guides, All-on-X, digital/milling/printing workflows, zirconia, Emax, PMMA, PFM, shade systems, occlusion, CAD/CAM, scanner integrations, lab-communication best practices.
   - `hipaa/` — PHI definition, core HIPAA rules, secure data handling, privacy, permissions, retention, practical compliance guidance.
   - `selectKnowledge(query, { maxChars })` — returns the most relevant sections within a budget. Pure, unit-testable, no I/O.
   - Composite lib: add `composite`/`declarationMap`/`emitDeclarationOnly`, register in root `tsconfig.json` references.

2. **AI memory table (new, `lib/db` schema)** — durable per-lab assistant memory.
   - Columns: `id`, `lab_organization_id` (scope), `kind` (`'glossary' | 'preference' | 'fact'`), `key`, `value`, `source` (`'manual' | 'learned'` — Phase 1 writes only `'manual'`), `created_by_user_id`, `created_at`, `updated_at`, plus `deleted_at` + `deleted_by_user_id` (soft-delete pattern).
   - Unique index on `(lab_organization_id, kind, key)` to prevent duplicates; lookups filtered with `notDeleted(...)`.
   - Applied via `pnpm --filter @workspace/db run push` (dev). No existing table is modified.

3. **Memory API (new routes, `artifacts/api-server`)** — `GET/POST/PATCH/DELETE` for assistant memory, scoped to a lab.
   - Read: any member of the lab. Write/delete: lab **admin** (glossary is a lab-wide setting).
   - Validated with Zod; contract added to the OpenAPI spec; hooks regenerated via codegen.

4. **Prompt augmentation in existing AI (`ai-chat.ts`, `ai-agent.ts`)** — the only edits to existing code. The system-prompt builder gains two prepended blocks: (a) `selectKnowledge(userMessage)` output, and (b) the lab's glossary/preferences from memory. Behind the existing AI-availability checks. No change to request/response contracts.

5. **Minimal desktop glossary UI** — Settings → **AI Assistant** panel (admin-only) to view/add/remove glossary terms and preferences. Mobile management deferred. Small, isolated component.

---

## 5. Data Flow

```
User asks AI (chat or agent)
  → server builds system prompt
      ├─ selectKnowledge(message)  → relevant LabTrax / dental / HIPAA sections (budgeted)
      └─ memory lookup (lab)       → lab glossary + preferences
  → prepend both blocks to the existing system prompt
  → OpenAI call (unchanged client/config)
  → answer reflects expert knowledge + the lab's own terms

Glossary editing:
  Admin → Settings → AI Assistant → add term
    → POST /api/ai/memory → stored (manual)
    → used in all subsequent prompts
```

---

## 6. HIPAA, Security & Permissions

- **Knowledge packs are general reference** (no patient data) — safe to send to the model.
- **Memory stores lab nomenclature/preferences, not PHI.** Phase 1 never auto-captures case/patient content into memory. The admin UI is for terminology and preferences.
- **No new outbound PHI:** existing chat/agent already send lab/case context to OpenAI; Phase 1 adds static knowledge + the glossary, not new patient data.
- **Tenant scoping:** every memory row is scoped to `lab_organization_id`; reads require lab membership, writes require lab admin. Cross-lab leakage is structurally impossible.

---

## 7. Regression Safety (explicit user requirement: "no regression of any other functions or features")

- **Additive design:** new lib, new table, new routes, new optional desktop panel. The *only* edits to existing code are prompt-text augmentation in `ai-chat.ts` / `ai-agent.ts`, which do not change any request/response contract.
- **No existing table modified** → no migration risk to protected data; new table added via dev push.
- **No mobile change** in Phase 1 → no EAS/TestFlight cycle required; the 22 protected mobile workflows are untouched.
- **Full protected suite must pass before done** (per `REGRESSION_GUARDRAILS.md`): mobile tests, API tests, legacy-path fence, scripts tests, full typecheck, plus desktop tests. Long-running gates run via the validation runner (not the 120s bash cap).
- **Architect review** of the final diff before completion.

---

## 8. Testing Plan

- **Unit (`ai-knowledge`):** `selectKnowledge` returns relevant sections for representative queries (LabTrax how-to, dental material, HIPAA) and respects the `maxChars` budget.
- **API:** memory CRUD — member can read; non-member gets 403; admin can write; non-admin write is rejected; uniqueness enforced; soft-delete hides rows.
- **Prompt integration:** chat/agent prompt builder includes the knowledge + glossary blocks without breaking existing AI Chat/Agent tests.
- **Regression:** full protected suite (see §7).

---

## 9. API Surface (Phase 1)

- `GET    /api/ai/memory?labOrganizationId=…&kind=…` — list memory for a lab (member).
- `POST   /api/ai/memory` — create a glossary term / preference (admin).
- `PATCH  /api/ai/memory/:id` — update value (admin).
- `DELETE /api/ai/memory/:id` — soft-delete (admin).

(Exact paths finalized in the implementation plan; all under the existing auth + lab-scoping middleware.)

---

## 10. Isolation / Boundaries

- **`ai-knowledge`** — pure content + selection; depends on nothing; consumed by the API only. Swapping selection strategy (keyword → embeddings) does not touch callers.
- **Memory module** — storage + scoped CRUD; one clear job; consumed by the prompt builder and the UI.
- **Prompt builder edits** — confined to the two existing AI route files; small, reviewable.

---

## 11. Coordination With In-Flight Work

- Tasks about **AI Reader material rules** (zirconia/Emax/PFM alloy reminders) operate on the **Rx-extraction** prompts, which are a *different* surface from the conversational assistant. The Phase-1 dental knowledge pack **complements** them and must not duplicate or alter the reader's extraction logic. If those tasks land first, reuse their canonical material wording in the dental pack for consistency.

---

## 12. Open Questions

1. **Glossary management surface:** desktop Settings panel only for Phase 1 (mobile later) — confirm acceptable.
2. **Write permission:** glossary edits restricted to lab admins (vs. any member) — confirm acceptable.
3. **Memory protection level:** soft-delete included; do we also add the table to `PROTECTED_TABLES`? (Leaning yes for safety; minor extra wiring.)
