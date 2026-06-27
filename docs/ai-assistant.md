# AI Assistant (Knowledge + Memory)

Phase 1 foundation that grounds the LabTrax AI in curated knowledge plus per-lab memory. Strictly additive — no existing AI request/response contract changed.

- **Curated knowledge** — `@workspace/ai-knowledge` (`lib/ai-knowledge`) ships read-only packs (`labtrax/`, `dental/`, `hipaa/`) and a pure `selectKnowledge(query, { maxChars })` that returns the most relevant snippets within a char budget. No DB, no network.
- **Per-lab memory** — soft-deletable `ai_memory` table (`lib/db`): `(lab_organization_id, kind, key)` unique, `kind ∈ {glossary, preference, fact}`. Registered in `PROTECTED_TABLES`/`PROTECTED_DRIZZLE_EXPORTS` (soft-delete only). Adding any new protected table requires adding it to the `tables` record in every fully-mocked `@workspace/db` test (otherwise those suites throw "No <table> export").
- **CRUD API** — `/api/ai-memory`: GET (any active member) / POST, PATCH, DELETE (lab admin only; DELETE is soft-delete). Zod-validated, lab-scoped, mirrors `vocabulary.ts`. OpenAPI under tag `ai`; hooks generated into `@workspace/api-client-react`.
- **Prompt augmentation** — `lib/ai-knowledge-augment.ts` (`buildKnowledgeBlock`, `buildLabMemoryBlock`) is wired into `ai-chat.ts` and `ai-agent.ts` only, behind the existing AI-availability checks. Both helpers return `""` when nothing matches so the prompt is unchanged.
- **Desktop UI** — Settings → "AI Assistant" (admin-only) manages glossary/preference/fact entries per lab.
