# API server conventions

## Opt-in limit/offset paging

List endpoints that support the limit/offset migration retain their legacy
response by default. A request with neither `limit` nor `offset` returns the
existing unpaged `data` value (normally an array; statement-charges retains
its existing object shape).

Paging is opt-in: supplying either query parameter changes `data` to an object
with this shape:

```json
{
  "rows": [],
  "total": 0,
  "limit": 100,
  "offset": 0,
  "hasMore": false
}
```

`limit` is an optional integer from 1 through 100. If only `offset` is
provided, `limit` defaults to 100. `offset` is an optional integer greater
than or equal to 0 and defaults to 0 when only `limit` is provided. `total`
is the number of rows in the complete filtered result, not the number returned
in the page; `hasMore` is true when another page follows.

This convention applies to the invoices list, the non-worklist cases list,
statement-charges, statement account-summaries, finance transactions,
undeposited funds, reconciliation history, per-account generated statements,
and per-account practice-statements. The `summary=1` undeposited-funds variant
remains a summary object and is not converted to a row page. Statement-charges
pages also carry `openingBalance` and `endingBalance`; those balances bracket
the rows returned in that page and are present alongside the page metadata.

Clients should treat the unpaged and paged forms as a deliberate compatibility
union and opt in only when they need bounded result sets. Generated API
clients are not changed as part of this documentation/specification
convention.