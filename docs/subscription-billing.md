# Subscription Billing

LabTrax uses a free-trial + recurring subscription model. Every new org/user gets a 14-day trial automatically on signup.

| Status | Access | Notes |
|--------|--------|-------|
| `trialing` | Full | 14-day trial starts at signup |
| `active` | Full | Paying subscriber |
| `past_due` | Full | Last payment failed; grace before locking |
| `grace` | Read-only | Trial expired without payment |
| `locked` | Locked | Grace period elapsed |
| `canceled` | Locked | Manually canceled |
| `legacy_free` | Full | Predates billing; grandfathered |

- **Desktop/web** — Stripe hosted checkout; webhooks at `POST /api/billing/webhook/stripe`
- **iOS/Android** — RevenueCat; webhooks at `POST /api/billing/webhook/revenuecat`

Key files: `lib/entitlement.ts`, `lib/billing-jobs.ts`, `lib/stripeClient.ts`, `routes/billing.ts`

Setup: connect Stripe integration → run `seed-stripe-products` → set `STRIPE_PRICE_ID` → configure webhook → set `STRIPE_WEBHOOK_SECRET`.

See [`environment-variables.md`](environment-variables.md) (Billing section) for the full list of Stripe/RevenueCat env vars.
