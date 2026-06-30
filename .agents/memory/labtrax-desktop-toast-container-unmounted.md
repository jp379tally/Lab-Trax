---
name: LabTrax Desktop toast container was unmounted
description: The desktop app had no toast container rendered, so toast() calls were silent no-ops; how the two toast systems are split.
---

# LabTrax Desktop toast container(s)

The desktop app (`artifacts/labtrax-desktop`) has TWO parallel toast systems and
historically rendered **neither container**, so every `toast()` call was a silent
no-op:

- **shadcn system**: `toast` from `@/hooks/use-toast`, container
  `<Toaster/>` in `@/components/ui/toaster`. Used by settings, finance/register,
  PrescriptionPreview, UnassignedDocumentsCard, and (now) practices pricing.
- **Sonner system**: `toast` from the `sonner` package directly, wrapper container
  in `@/components/ui/sonner`. Used by cases.tsx and lists.tsx.

The shadcn `<Toaster/>` is now mounted once at the app root in `App.tsx` (inside
`QueryClientProvider`), so shadcn-based toasts display. The **Sonner** container is
still NOT mounted anywhere — `sonner`-based toasts in cases.tsx / lists.tsx remain
silent until a Sonner `<Toaster/>` is added.

**Why:** for a toast to appear, its matching container must be in the tree. The two
systems are independent — mounting one does not surface the other's toasts.

**How to apply:** when adding a toast on desktop, prefer the shadcn `toast` from
`@/hooks/use-toast` (its container is mounted). If you must use Sonner, you also
need to mount the Sonner container. Don't assume a `toast()` call is visible just
because the import resolves.

**Tooling note:** `grep`/`rg` content output is unreliable in this workspace (it
mangles identifiers, e.g. shows `Toaster` as `n`); verify source content with the
`read` tool or Node `fs` via code execution, not grep matches.
