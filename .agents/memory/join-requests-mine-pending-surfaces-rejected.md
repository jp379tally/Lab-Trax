---
name: mine/pending surfaces recently-rejected join requests
description: Why a test asserting a rejected join request "disappears from mine/pending" is wrong, and how DB-gated tests get merged born-broken.
---

GET /api/organizations/join-requests/mine/pending intentionally returns NOT
just pending rows but also recently-resolved ones (status approved OR rejected
whose reviewedAt is within RECENT_REJECTED_WINDOW_MS, currently 14 days).

**Why:** the requester's waiting/dashboard card must react to an admin decision —
an approval lets the client drop into the lab dashboard, and a decline shows an
explicit "your request was declined" message instead of silently resetting to
search. The desktop dashboard JoinLabCard "declined" state depends on this.

**How to apply:** any test asserting that after an admin reject the request is
absent from mine/pending is wrong — right after reject, reviewedAt = now is
always inside the window, so it MUST surface with status "rejected". Assert it
surfaces (status "rejected"), not that it's gone. lab-team (admin's list) is the
one that correctly drops it — lab-team only shows status "pending".

**Born-broken trap:** join-lab-flow.test.ts is `describe.skip` unless
DATABASE_URL is set. CI skipped it, so a contradictory assertion was merged and
only ever fails in the workspace (DATABASE_URL present). DB-gated suites can ship
broken — when an isolated single-file run fails deterministically on code you
didn't touch, check git blame timestamps: endpoint behavior change vs the test
that contradicts it.
