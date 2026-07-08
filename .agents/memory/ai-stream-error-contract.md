---
name: AI stream error contract
description: Shared mobile+desktop error mapping for Maynard AI streaming chat lives in api-client-react
---

The user-facing error contract for AI assistant streaming (401/403/404/429/500/503, network failure, interrupted stream, malformed SSE) is defined ONCE in `lib/api-client-react/src/ai-stream-errors.ts` and consumed by both the mobile ai-assistant screen and the desktop AiChatPanel.

**Why:** the original bug was each client hand-rolling error handling, collapsing everything (esp. auth 401s) into one generic "having trouble connecting" message; keeping the mapping in the shared lib with contract tests prevents divergence.

**How to apply:**
- Any new client surface that streams AI chat must use `extractAiStreamHttpError` / `aiStreamHttpErrorMessage` and the exported message constants — never re-implement the strings.
- The mobile `vitest.setup.ts` mock of `@workspace/api-client-react` re-exports the REAL module via `vi.importActual("../../lib/api-client-react/src/ai-stream-errors")` so component tests exercise production strings; keep that spread when editing the mock.
- Stream dispatchers must treat: missing response body or no terminal SSE event → "interrupted" message; read-loop throw → stream-read-failed; fetch reject → network constant. Diagnostic logs (mobile logDebugEvent "ai_stream_error", desktop console.warn "[AI stream]", server req.log) must include phase/status but never prompts or secrets.
