---
name: Background commands die on tool-call return
description: Long-running shell commands (nohup &, detached) get SIGKILLed when the bash tool call returns; run them through a persistent workflow instead.
---

# Long-running commands must run via a workflow, not backgrounded bash

Backgrounding a long command in the bash tool (`nohup … &`, `cmd &`) does NOT
survive the tool call returning — the process is SIGKILLed when control comes
back, so its output log freezes mid-run and it never completes.

**Symptom:** a piped foreground run (`pnpm … test | tail`) exits with code -1 and
no output (killed for taking too long / output buffering), and a `nohup … &`
retry leaves a log file that stops growing at the exact moment the next tool
call returns, with `ps` showing no node/vitest process.

**Why:** the sandbox reaps child processes of a bash tool call once that call
finishes; backgrounding doesn't detach them from that lifecycle.

**How to apply:** run anything that takes more than a tool-call's worth of time
through a managed **workflow** (which persists across tool returns), then poll
results with `refresh_all_logs` / by reading the workflow log file. In this repo
the api-server vitest suite (~2 min, 540+ tests) must be run via the
`api-server-tests` workflow — not `nohup pnpm --filter @workspace/api-server run
test &`. The labtrax suite is fast (~7 s, 128 tests) and is fine to run inline.
Same lesson as EAS builds (see eas-build-run-as-workflow.md).
