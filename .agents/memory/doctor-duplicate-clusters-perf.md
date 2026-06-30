---
name: Doctor duplicate-clusters badge performance
description: Why /api/doctors/duplicate-clusters is expensive and how the precompute + cache mitigations are shaped (without changing detection).
---

# /api/doctors/duplicate-clusters performance

The nav duplicate-doctor badge polls this endpoint every 60s from BOTH desktop
and mobile. The handler runs a per-lab O(n²) bigram-Jaccard scan over every
distinct (doctor, practice) group. The detection algorithm + threshold are
fixed — do not change scores.

**Measured (single-thread JS clustering only, no DB):** n=500 ~640ms,
n=1000 ~2.4s, n=2000 ~8.9s. At ~2k doctor groups the scan blocks the Node
event loop for ~9s, which is the real risk for high-volume labs.

**Mitigation 1 (always on): precompute per node.** The original `similarity()`
re-ran `normalizeForCompare` + bigram-set construction for BOTH names on every
one of the n² pairs. Precomputing each node's normalized string + bigram set
once, then doing only set-intersection in the loop, is ~9× faster (n=2000
~970ms) and byte-for-byte identical output. Shared helpers: `bigrams()` +
`bigramJaccard()`; `similarity()` now delegates to them so single-call callers
are unchanged.

**Mitigation 2: short-TTL per-user response cache.** Keyed by userId (which
labs the caller administers), default TTL 30s (`DOCTOR_DUP_CLUSTER_CACHE_TTL_MS`),
fully cleared by `invalidateDuplicateClusterCache()` on every merge/undo in the
same route file. Collapses the near-simultaneous desktop+mobile polls into one
compute.

**Why the cache config is read at call time, not module load:** the cache is
disabled under VITEST (same pattern as rate-limit) so the integration suite —
which mutates `cases` rows directly and re-polls with the same token — stays
deterministic. A single dedicated test opts back in via
`DOCTOR_DUP_CLUSTER_CACHE_FORCE=1` + a tiny TTL; reading config per-call lets
that env toggle take effect without reimporting the module.

**How to apply:** if you touch the clustering, keep `similarity` and the
precomputed loop producing identical scores; if you add another mutation path
that changes doctor names/cases, call `invalidateDuplicateClusterCache()` too,
or the badge can serve a stale count for up to the TTL.
