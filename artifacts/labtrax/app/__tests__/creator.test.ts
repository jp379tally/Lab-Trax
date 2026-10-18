import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryClient } from "@/lib/query-client";
import {
  CREATOR_SETUP_MESSAGE, formatMinor, minorToMajor, CreatorApiError, creatorAccessKey, creatorErrorMessage, creatorJson,
} from "@/lib/creator";
import { resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
const screen = read("../settings/creator.tsx");
const gate = read("../../components/creator/CreatorGate.tsx");
const ownerLayout = read("../settings/owner/_layout.tsx");
const accountSource = read("../(tabs)/account.tsx");
const adminSource = read("../settings/platform-admin.tsx");

afterEach(() => { resetMockFetchHandler(); vi.restoreAllMocks(); });

describe("creator mobile client", () => {
  it("keys capability by user so auth switches never share it", () => {
    expect(creatorAccessKey("a")).not.toEqual(creatorAccessKey("b"));
    expect(creatorAccessKey(null)).toEqual(["creator", "access", "anon"]);
  });

  it("an expired-unlock 403 re-reads capability immediately", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    setMockFetchHandler(async () => Response.json({ error: "locked" }, { status: 403 }));
    await expect(creatorJson("GET", "/creator/revenue?x=1")).rejects.toMatchObject({ status: 403 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["creator", "access"] });
  });

  it("rate limits surface a clear retry time and do not retry", async () => {
    let n = 0;
    setMockFetchHandler(async () => { n += 1; return Response.json({ error: "x" }, { status: 429, headers: { "Retry-After": "90" } }); });
    const err = await creatorJson("POST", "/creator/unlock", { pin: "1234567" }).catch((e) => e);
    expect(err).toBeInstanceOf(CreatorApiError);
    expect(creatorErrorMessage(err)).toContain("2 min");
    expect(n).toBe(1);
  });

  it("rotates the PIN with current/new/confirm", async () => {
    let body = "";
    setMockFetchHandler(async (url, init) => { body = String(init?.body); expect(url).toBe("/api/creator/pin"); return Response.json({ ok: true }); });
    await creatorJson("POST", "/creator/pin", { currentPin: "1234567", newPin: "7654321", confirmPin: "7654321" });
    expect(JSON.parse(body)).toEqual({ currentPin: "1234567", newPin: "7654321", confirmPin: "7654321" });
  });

  it("gate: auto-completes without Unlock button, shows secure setup message when unprovisioned", () => {
    expect(gate).toContain("CREATOR_PIN_LENGTH");
    expect(gate).toContain("sent.current === digits");
    expect(gate).not.toMatch(/onSubmitEditing|Unlock<\/Text>/);
    expect(gate).toContain("CREATOR_SETUP_MESSAGE");
    expect(CREATOR_SETUP_MESSAGE).toContain("CREATOR_INITIAL_PIN");
  });

  it("dashboard hosts attachments via the private authenticated cache, PIN rotation, and owner tools", () => {
    expect(screen).toContain("openAttachment");
    expect(screen).not.toContain("Linking");
    expect(screen).toContain("/creator/pin");
    for (const r of ["lab-profile", "team", "revenue-reports", "danger-zone", "/settings/subscriptions"]) expect(screen).toContain(r);
    expect(screen).toContain("/creator/revenue/reconcile");
  });

  it("legacy owner and subscription screens share the gate; platform admin row stays", () => {
    expect(ownerLayout).toContain("CreatorGate");
    expect(read("../settings/platform-subscriptions.tsx")).toContain("CreatorGate");
    expect(accountSource).toContain("isCreator");
    expect(accountSource).toContain('title="Platform Admin"');
    expect(adminSource).not.toContain("platform-subscriptions");
  });

  it("formats minor units per currency", () => {
    expect(minorToMajor(1234, "JPY")).toBe(1234);
    expect(minorToMajor(1234, "KWD")).toBe(1.234);
    expect(formatMinor(1234, "USD")).toBe("$12.34");
  });

  it("revenue and inbox: timezone/currency labels, presets, honest empty copy, paging, visible errors", () => {
    for (const t of ["creator-revenue-tz", "creator-preset-${k}", "creator-group-${g}", "This year", "collected fees less refunds",
      "No verified receipts in this range", "may be incomplete", "creator-feedback-prev", "creator-feedback-next", "setPage(0)",
      "creator-review-error", "creator-lock-error", "creator-reconcile-error"]) expect(screen).toContain(t);
    expect(screen).toContain("offset=${page * FB_PAGE}");
    expect(screen).toContain("isPending");
  });

  it("PIN input is masked, no autofill, and the gate re-locks at the expiry deadline", () => {
    expect(gate).toContain("secureTextEntry");
    expect(gate).toContain('autoComplete="off"');
    expect(gate).toContain("setTimeout(fire");
    expect(gate).toContain("expiredFor");
  });

  it("subscription console shows the full summary with breakdowns", () => {
    const sub = read("../settings/platform-subscriptions.tsx");
    for (const t of ["subscription-summary", "totalAccounts", "paidSubscribers", "subscription-${k}", "byStatus", "byProvider"]) expect(sub).toContain(t);
  });
});
