---
name: Orval generated query/mutation hook usage
description: Gotchas when consuming @workspace/api-client-react generated hooks (useListInvoices, useUpdateInvoice, useGenerateInvoiceForCase) from artifacts.
---

# Consuming generated OpenAPI hooks from an artifact

**The generated list hooks return the raw envelope, not an array.** e.g.
`useListInvoices()` returns `{ data: InvoiceListResult }` where
`InvoiceListResult = { ok?: boolean; data?: Item[] }`. Extract the array
yourself (`result?.data ?? []`) — unlike the hand-written `useInvoices`
mobile-hook, which already unwrapped to an array.

**`query.select` triggers a hard typecheck error in this react-query
version:** passing `{ query: { select } }` makes TS demand the full
`UseQueryOptions` including a `queryKey`, and `select`'s return type does not
flow into `TData` by inference. Don't fight it — skip `select`, take the raw
result, and map in a `useMemo`. Cleaner than casting options or threading an
explicit `<TData>` generic.

**Mutation variable shapes** (from `getXMutationOptions`):
- `useUpdateInvoice().mutateAsync({ invoiceId, data })`
- `useGenerateInvoiceForCase().mutateAsync({ caseId, data })` — body is
  `{ layoutPresetId?: string|null }`; pass `{}` when unused.
- Mobile sends a richer PATCH body than the spec models; `Record<string,
  unknown>` is assignable to the all-optional `UpdateInvoiceInput`, so a plain
  cast works, no schema-type import needed.

**Stale lib declarations bite first.** If an artifact reports "no exported
member named 'useListInvoices'" but the symbol exists in
`lib/api-client-react/src/generated/api.ts`, the lib's emitted `.d.ts` is
stale — run `pnpm run typecheck:libs` (rebuilds composite libs) before the
artifact typecheck.

**Test mock parity:** every generated hook an artifact imports must be added
to the `@workspace/api-client-react` mock in `artifacts/labtrax/vitest.setup.ts`.
The real `AppProvider` is rendered for real in
`case-status-normalization-boundaries.test.tsx`, so any hook called at provider
top-level (e.g. invoice mutations moved into app-context) must exist in that
mock or the test crashes.

**`useDates:true` splits date types across the two generated packages.** For a
`date-time` field, **api-zod** emits a `Date | null` type (its body schema uses
`zod.coerce.date().nullish()`) while **api-client-react** keeps `string | null`.
Artifacts consume the api-client-react type, so send ISO strings and never
import the api-zod type for a date field — mixing them is a typecheck trap, not
a runtime bug.
**Why:** the two generators are configured independently; only api-zod coerces.

**Required query params don't reject `undefined` in the generated zod.** Orval
emits required query params as `zod.coerce.string()` (no `.optional()`), but
`z.coerce.string().parse(undefined)` → `"undefined"`, so a contract test that
expects `QueryParams.parse({})` to throw will FAIL. Test the bounded numeric
fields (`limit` min/max) for rejection instead — those keep real constraints.
Required *body* fields (non-coerced `zod.string()`) do reject missing values
normally.
