---
name: Desktop duplicate-doctor merge — notification launch path
description: How the Customer Center "possible duplicate doctors" cluster reaches the Merge dialog, and why some casing regressions are unreachable through the full page.
---

# Duplicate-doctor merge: notification launch path & identity

The reported bug ("Review" opens the Merge dialog with SOURCES(0) and both rows
showing "Target ✓", Merge disabled) is the OLD lowercased/normalized-identity
behavior. Current desktop code already uses **exact-cased identity**
(`doctorName.trim()` + `providerOrganizationId`) in the merge dialog's
auto-source exclusion, self-merge guard, and row target-render check. So that
symptom on a live client = a **stale deployed build** (web needs republish,
Electron needs a new signed desktop build), not a code bug.

## Two identity dimensions
Doctor identity is **name + providerOrganizationId** (practice), never name
alone. Two doctors are distinct if EITHER the exact-cased name OR the practice
differs.

## Cluster formation vs. dialog identity — they use different comparisons
- The page's duplicate-cluster `rows` map is keyed by
  `doctorName.toLowerCase() | practiceId`, so **same-practice + casing-only**
  variants COLLAPSE into one row and can NEVER form a notification cluster
  through the full page. Clusters only form from prefix/punctuation differences
  (`normalizeForCompare` strips "Dr." + punctuation → similarity 1) or from the
  same name across DIFFERENT practices.
- The Merge dialog's source-exclusion uses the RAW exact-cased name (not
  `normalizeForCompare`), which is why "Dr. Kanesha Cole" vs "Kanesha Cole"
  stays as target + 1 source.

## Test-coverage consequence (don't chase an unreachable test)
- Pure same-practice casing-only identity is only testable at the **dialog
  level** (`merge-dialog-same-practice-init.test.tsx` feeds hand-built
  initialSources) — it is structurally unreachable via the full DoctorsPage.
- The **notification launch path** test (`merge-dialog-notification-path.test.tsx`)
  covers: (1) prefix-variant cluster → Review → target/source split (this DOES
  fail if source-exclusion regresses to normalized comparison), and (2)
  same-name/different-practice distinct identity. A same-name/different-practice
  pair does NOT catch a lowercase-name regression (practice already
  distinguishes them), so don't rely on it for that.

**How to apply:** When asked to "make the notification path catch pure casing
regressions," don't — the rows-map lowercasing makes it unreachable; point to
the dialog-level capitalization test instead.

## Two launch surfaces — wire cluster affordances in BOTH
The shared MergeDialog is opened from TWO duplicate-cluster banners: the
Doctors page AND the Customer Center (accounts page). Cluster-specific
affordances (e.g. the "Do not merge" dismiss button, gated on
`!singleReassign && onDoNotMerge`) only appear if the launching surface passes
the cluster's `clusterKey` and an `onDoNotMerge` callback. The Customer Center
banner originally omitted both, so the button silently never showed there —
"missing button" reports naming the Customer Center are a wiring gap on that
surface, not a dialog bug. Any new cluster-level feature must be threaded
through both launch paths (each has its own regression test file).
