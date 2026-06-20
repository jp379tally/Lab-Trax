---
name: AI memory auto-learn (propose, don't write)
description: Why auto-learned AI memory is proposed for admin approval instead of written directly, and the constraints on the learning hook.
---

# AI memory auto-learning

Auto-capture from AI chats writes candidate glossary/preference/fact entries to a
separate candidates table (status pending → approved/rejected). It NEVER writes
the live `ai_memory` table directly. A lab admin approves first; approved entries
land in `ai_memory` with `source:"learned"`. Only approved memory feeds prompts —
candidates never do.

**Why the candidates table is NOT protected/soft-delete:** its status transitions
ARE its audit trail, so it stays out of `PROTECTED_TABLES`. This also avoids the
protected-table mock fanout in fully-mocked `@workspace/db` tests.

**Learning hook constraints:**
- Fire-and-forget: must never throw, never block, never alter the AI reply.
  Phase-1 rule is that no existing AI request/response contract changes.
- Runs AFTER the reply is produced, on every reply-return path, lab users only.
- Extraction stays conservative and bounded; dedup skips existing active memory
  and existing pending/rejected candidates (case-insensitive per kind+key).

**Concurrency:** approve/reject must update conditionally on `status='pending'`
(and approve must be transactional with the memory write) so two admins can't
double-review the same candidate.

**Known non-blocking gaps (acceptable):** dedup is app-level only — no DB unique
index, so concurrent chats can create duplicate pending candidates; the candidate
list endpoint coerces an invalid `status` query to `pending` rather than 400.
