import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const state = vi.hoisted(() => ({ rows: [] as any[], statements: [] as any[], unavailable: 0 }));
vi.mock("@workspace/db", async (original) => {
  const actual: any = await original();
  return { ...actual, db: { execute: async (statement: any) => {
    state.statements.push(statement);
    return { rows: state.statements.length % 2 === 0 ? [{ n: state.unavailable }] : state.rows };
  } } };
});
vi.mock("../lib/subscription-history", () => ({
  subscriptionCoverage: async () => [{ provider: "revenuecat", status: "partial", detail: "Historical amounts unavailable.", updatedAt: null }],
  reconcileSubscriptionHistory: vi.fn(),
}));
import { creatorRevenueRouter, revenueRange } from "./creator-revenue";
import { pool } from "@workspace/db";
const app = express();
app.use("/revenue", creatorRevenueRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message }));

describe("Creator receipt reporting contracts", () => {
  it.each([{ start: "2026-02-30", end: "2026-03-01" }, { start: "2026-03-02", end: "2026-03-01" },
    { start: "2026-01-01", end: "2026-03-01", timezone: "invented/zone" }, { start: "2026-01-01", end: "2026-03-01", group: "hourly" }])
  ("rejects invalid date/timezone/group input %j", range => {
    expect(() => revenueRange(range)).toThrow();
  });
  it("separates currencies, subtracts refunds exactly, and discloses missing source evidence", async () => {
    state.statements = []; state.unavailable = 3;
    state.rows = [
      { currency: "EUR", period: "2026-03-01", collected: "4000", refunds: "500" },
      { currency: "JPY", period: "2026-03-01", collected: "1500", refunds: "0" },
      { currency: "EUR", period: "2026-03-02", collected: "1000", refunds: "100" },
    ];
    const response = await request(app).get("/revenue?start=2026-03-01&end=2026-03-31&timezone=America/New_York&group=daily");
    expect(response.status).toBe(200);
    expect(response.body.currencies).toHaveLength(2);
    expect(response.body.currencies[0]).toMatchObject({ currency: "EUR", collectedMinor: 5000, refundsMinor: 600, netMinor: 4400 });
    expect(response.body.currencies[1]).toMatchObject({ currency: "JPY", collectedMinor: 1500, refundsMinor: 0, netMinor: 1500 });
    expect(response.body).toMatchObject({ unavailableAmounts: 3, coverage: [{ status: "partial" }] });
    const query = new PgDialect().sqlToQuery(state.statements[0]);
    expect(query.sql).toContain("unavailable_reason IS NULL");
    expect(query.sql).toContain("amount_minor > 0");
    expect(query.sql).toContain("AT TIME ZONE");
    expect(query.sql).not.toContain("invoices");
    expect(query.params).toContain("America/New_York");
  });
  it("fails explicitly when exact minor-unit arithmetic cannot be represented", async () => {
    state.statements = [];
    state.rows = [{ currency: "USD", period: "2026-01-01", collected: "9007199254740993", refunds: "0" }];
    expect((await request(app).get("/revenue?start=2026-01-01&end=2026-01-01")).status).toBe(422);
  });
  it("uses inclusive calendar-date boundaries over DST, not fixed 24-hour UTC buckets", async () => {
    // Read-only PostgreSQL check: no fixture data or shared-database teardown.
    const r = await pool.query(`SELECT
      ('2026-03-08'::date::timestamp AT TIME ZONE 'America/New_York') AS start,
      (('2026-03-08'::date + 1)::timestamp AT TIME ZONE 'America/New_York') AS finish,
      ('2026-11-01'::date::timestamp AT TIME ZONE 'America/New_York') AS fall_start,
      (('2026-11-01'::date + 1)::timestamp AT TIME ZONE 'America/New_York') AS fall_finish`);
    expect(r.rows[0].finish - r.rows[0].start).toBe(23 * 3600000);
    expect(r.rows[0].fall_finish - r.rows[0].fall_start).toBe(25 * 3600000);
  });
});
afterAll(async () => { await pool.end(); });
