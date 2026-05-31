---
name: LabTrax mobile design-system adoption
description: How metric rows and menu lists adopt the shared StatTile/Card components on the dashboard.
---

# LabTrax dashboard design-system conventions

The shared UI primitives live in `artifacts/labtrax/components/ui/`: `StatTile`,
`Card`, `MenuItem`. They read theme tokens via `useTheme` from `@/lib/theme-context`.

## Conventions established across the dashboard refresh

- **Metric / "key number" rows use `StatTile`**, laid out in a flex row
  (`flexDirection: "row", gap: 10`) so tiles fill equally. Carry semantic
  meaning through the `accent` prop (tints the icon + active border); the value
  text is always `colors.text`, so a colored *number* (e.g. red overdue total)
  cannot be reproduced — use an `accent`-tinted icon instead.

- **Hub / action menu lists use `Card` with inline children**, NOT the
  `MenuItem` component. A row is a `Card` (padding `md`, row layout) wrapping the
  existing `adm.menuIcon` / `adm.menuInfo` / `adm.menuTitle` /
  `adm.menuSub` markup and a trailing `Feather chevron-right` (or a custom
  trailing icon, e.g. the trash icon on the delete-case list).
  `<Card padding="md" onPress={…} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>`
  wrapping the existing `adm.menu*` markup and a trailing chevron (or a custom trailing icon,
  e.g. the trash icon on the delete-case list).

**Why:** the first menus converted on the admin hub chose `Card`+inline, so every
later menu (financial hub, payment "coming soon", delete-case, master hub) must
match that to stay visually identical. Reaching for `MenuItem` instead would make
those lists look subtly different and break the consistency the refresh is for.

**How to apply:** when refreshing any remaining hand-rolled metric card or menu
row on the mobile dashboard, follow these two patterns rather than inventing a
new surface. Refactors here are visual-only — preserve every `onPress` /
`onLongPress` handler. The provider "YOUR CASES" hero keeps its gradient; its
Active/Completed metrics live in a `StatTile` row *below* the gradient (StatTile
is a solid surface card and does not belong inside the translucent gradient).
