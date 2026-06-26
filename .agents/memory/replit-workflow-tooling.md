---
name: Replit workflow & validation tooling coupling
description: How configureWorkflow/removeWorkflow/setValidationCommand map onto .replit, and the traps when editing the parallel run-button aggregate.
---

Direct edits to `.replit` (and `replit.nix`) are hard-blocked — they must go through dedicated tooling. Workflows live in `.replit` but are owned by the workflow callbacks.

Key facts learned the hard way:

- The Run button's parallel aggregate (`[[workflows.workflow]] name="Project" mode="parallel"` with `task="workflow.run"` sub-tasks) is NOT editable task-by-task through the tooling.
  - `configureWorkflow` only creates/updates a **single-command** workflow (no `mode`/`tasks` param; `command` is required). When a "Project" run aggregate exists, calling `configureWorkflow` **appends the new workflow as another task to Project** — it does not replace it.
  - The literal name `"Project"` is **prohibited** by `configureWorkflow` (river `PROHIBITED_ACTION`), so you cannot rebuild the aggregate.
  - `removeWorkflow(name)` deletes the whole workflow **definition** AND removes its task entry from the Project aggregate. There is no tool to detach a task from Project while keeping the workflow def.

- `setValidationCommand` / `clearValidationCommand` operate on the SAME `.replit` workflows that carry `metadata.isValidation = true`. `getValidationCommands()` returns exactly those workflow names. So:
  - `clearValidationCommand({name})` **deletes that workflow from `.replit`** (def + its Project task) — not just a private validation registry entry.
  - `setValidationCommand({name, command})` **upserts** by name. Calling it with a name that already exists as a workflow overwrites it; calling it then clearing it will DELETE the original. Recreate with `setValidationCommand` (it re-adds the def, the `isValidation` flag, and Project membership).

**Why:** During task #2437 I needed to remove only the EAS/Desktop build tasks from the Project run button while keeping the 5 validation tasks. Because the tooling can't detach a single task, the only path was `removeWorkflow` on the two build workflows (which also deletes their defs — the scripts in `scripts/*.sh` remain for manual `bash` runs). Separately, registering temp validation commands named `typecheck`/`api-test` and then clearing them silently deleted the real Project validation workflows; restoring them required `setValidationCommand` again.

**How to apply:** To make a parallel Run button safe, `removeWorkflow` the unwanted member workflows (accept that the def is gone; underlying scripts persist). Never `setValidationCommand`/`clearValidationCommand` with a name that collides with an existing `.replit` workflow unless you intend to mutate/delete that workflow. To run long checks ad hoc without touching the registry, prefer unique throwaway names or run via a dedicated workflow.
