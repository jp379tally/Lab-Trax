/**
 * Regression guard: desktop sidebar NAV + SECONDARY ordering.
 *
 * Protected workflow: "Desktop sidebar navigation order"
 *
 * The sidebar is the primary navigation surface for every desktop user.
 * Any accidental reorder, removal, or "two-factor"/"2FA" label insertion
 * that doesn't match the approved design would immediately confuse users
 * without failing any other automated check. This file pins the approved
 * array shapes so a refactor can't silently reorder items.
 *
 * Keep this test permanently per REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAV, SECONDARY } from "@/components/AppLayout";

// Flatten a nav tree into label strings for easy ordering assertions.
function flatLabels(items: Array<{ label: string; children?: Array<{ label: string; children?: unknown[] }> }>): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(item.label);
    if ("children" in item && Array.isArray(item.children)) {
      out.push(...flatLabels(item.children as Parameters<typeof flatLabels>[0]));
    }
  }
  return out;
}

describe("NAV primary sidebar items", () => {
  it("contains Dashboard first, then Cases, then Messages", () => {
    const labels = NAV.map((n) => n.label);
    expect(labels).toEqual(["Dashboard", "Cases", "Messages"]);
  });

  it("has no item labelled with two-factor / 2FA language", () => {
    const labels = flatLabels(NAV as Parameters<typeof flatLabels>[0]);
    for (const label of labels) {
      expect(label).not.toMatch(/two.?factor|2fa/i);
    }
  });
});

describe("SECONDARY sidebar items", () => {
  it("top-level order is exactly: Subscription, Admin Settings, Creator, Download Desktop App", () => {
    const topLabels = SECONDARY.map((n) => n.label);
    expect(topLabels).toEqual([
      "Subscription",
      "Admin Settings",
      "Creator",
      "Download Desktop App",
    ]);
  });

  it("Admin Settings group contains Customer Center, Financial, Pricing, Lists, Reports as children", () => {
    const adminGroup = SECONDARY.find(
      (n) => "children" in n && n.label === "Admin Settings",
    ) as { label: string; children: Array<{ label: string }> } | undefined;
    expect(adminGroup).toBeDefined();
    const childLabels = (adminGroup?.children ?? []).map((c) => c.label);
    expect(childLabels).toContain("Customer Center");
    expect(childLabels).toContain("Financial");
    expect(childLabels).toContain("Pricing");
    expect(childLabels).toContain("Lists");
    expect(childLabels).toContain("Reports");
  });

  it("has no separate Stats entry — Stats is a tab inside Reports", () => {
    const labels = flatLabels(SECONDARY as Parameters<typeof flatLabels>[0]);
    expect(labels).not.toContain("Stats");
  });

  it("Financial sub-group contains only Invoices, Statements, Bank Register in that order", () => {
    const adminGroup = SECONDARY.find(
      (n) => "children" in n && n.label === "Admin Settings",
    ) as { label: string; children: Array<{ label: string; children?: Array<{ label: string }> }> } | undefined;
    const financialGroup = adminGroup?.children.find(
      (c) => "children" in c && c.label === "Financial",
    ) as { label: string; children: Array<{ label: string }> } | undefined;
    const finLabels = (financialGroup?.children ?? []).map((c) => c.label);
    expect(finLabels).toEqual(["Invoices", "Statements", "Bank Register"]);
    expect(flatLabels(SECONDARY as Parameters<typeof flatLabels>[0])).not.toContain("Recovery Billing");
  });

  it("does not register the retired direct route", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(appSource).not.toContain('path="/recovery-billing"');
  });

  it("has no item labelled with two-factor / 2FA language", () => {
    const labels = flatLabels(SECONDARY as Parameters<typeof flatLabels>[0]);
    for (const label of labels) {
      expect(label).not.toMatch(/two.?factor|2fa/i);
    }
  });

  it("Maintenance lives inside the Admin Settings group and stays adminOnly", () => {
    expect(SECONDARY.some((n) => n.label === "Maintenance")).toBe(false);
    const adminGroup = SECONDARY.find(
      (n) => "children" in n && n.label === "Admin Settings",
    ) as { label: string; children: Array<{ label: string; adminOnly?: boolean }> } | undefined;
    const maintenance = adminGroup?.children.find((c) => c.label === "Maintenance");
    expect(maintenance).toBeDefined();
    expect(maintenance?.adminOnly).toBe(true);
  });
});
