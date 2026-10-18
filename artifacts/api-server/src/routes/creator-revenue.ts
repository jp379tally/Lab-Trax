import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { asyncHandler } from "../middlewares/async-handler";
import { HttpError } from "../lib/http";
import { subscriptionCoverage, reconcileSubscriptionHistory } from "../lib/subscription-history";

export const creatorRevenueRouter = Router();
export function revenueRange(query: Record<string, unknown>) {
  const { start, end } = query;
  const timezone = typeof query.timezone === "string" ? query.timezone : "UTC";
  const group = typeof query.group === "string" ? query.group : "daily";
  const validDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!validDate(start) || !validDate(end) || start > end) throw new HttpError(400, "Enter valid inclusive start and end calendar dates.");
  if (Date.parse(end) - Date.parse(start) > 3660 * 86400000) throw new HttpError(400, "A revenue range may cover at most ten years.");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new HttpError(400, "Invalid IANA timezone."); }
  if (!["daily", "monthly", "yearly"].includes(group)) throw new HttpError(400, "Invalid revenue grouping.");
  return { start, end, timezone, group, unit: group === "monthly" ? "month" : group === "yearly" ? "year" : "day" };
}
const safeMoney = (n: unknown) => {
  const result = Number(n);
  if (!Number.isSafeInteger(result)) throw new HttpError(422, "Revenue total exceeds the supported exact-money range.");
  return result;
};
creatorRevenueRouter.get("/", asyncHandler(async (req, res) => {
  const range = revenueRange(req.query);
  const result = await db.execute(sql`
    SELECT currency, to_char(date_trunc(${range.unit}, occurred_at AT TIME ZONE ${range.timezone}), 'YYYY-MM-DD') AS period,
      COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'receipt'), 0)::text AS collected,
      COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'refund'), 0)::text AS refunds
    FROM subscription_receipts
    WHERE unavailable_reason IS NULL AND amount_minor > 0 AND currency IS NOT NULL
      AND occurred_at >= (${range.start}::date::timestamp AT TIME ZONE ${range.timezone})
      AND occurred_at < ((${range.end}::date + 1)::timestamp AT TIME ZONE ${range.timezone})
    GROUP BY currency, period ORDER BY currency, period`);
  const currencies = new Map<string, { currency: string; collectedMinor: number; refundsMinor: number; netMinor: number; buckets: any[] }>();
  for (const row of result.rows as any[]) {
    const collected = safeMoney(row.collected), refunds = safeMoney(row.refunds);
    const entry = currencies.get(row.currency) ?? { currency: row.currency, collectedMinor: 0, refundsMinor: 0, netMinor: 0, buckets: [] as any[] };
    entry.collectedMinor = safeMoney(entry.collectedMinor + collected);
    entry.refundsMinor = safeMoney(entry.refundsMinor + refunds);
    entry.netMinor = safeMoney(entry.collectedMinor - entry.refundsMinor);
    entry.buckets.push({ period: row.period, collectedMinor: collected, refundsMinor: refunds, netMinor: safeMoney(collected - refunds) });
    currencies.set(row.currency, entry);
  }
  const missing = await db.execute(sql`SELECT count(*)::int AS n FROM subscription_receipts WHERE unavailable_reason IS NOT NULL AND (occurred_at IS NULL OR (occurred_at >= (${range.start}::date::timestamp AT TIME ZONE ${range.timezone}) AND occurred_at < ((${range.end}::date + 1)::timestamp AT TIME ZONE ${range.timezone})))`);
  res.json({ ...range, unit: undefined, currencies: [...currencies.values()], coverage: await subscriptionCoverage(), unavailableAmounts: missing.rows[0]?.n ?? 0 });
}));
creatorRevenueRouter.post("/reconcile", asyncHandler(async (_req, res) => res.json(await reconcileSubscriptionHistory())));
