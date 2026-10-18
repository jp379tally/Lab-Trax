/** @vitest-environment jsdom */
/**
 * jsdom cannot lay out CSS grids. Verify the auto-fit layout contract and
 * rendered card contents at the supported narrow desktop window widths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const ADMIN_USER = {
  id: "u-admin",
  username: "admin",
  role: "admin",
} as unknown as SessionUser;

const summary = {
  openBalance: 123456789.12,
  openCount: 2,
  overdueBalance: 98765432.10,
  overdueCount: 1,
  paidThisMonth: 87654321.99,
  paidCount: 3,
  sumTotal: 0,
  sumBalance: 0,
};

describe.each([640, 800])("invoice summary cards at %ipx", (width) => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify(
        url.includes("/api/invoices")
          ? { rows: [], total: 0, limit: 10, offset: 0, hasMore: false, nextCursor: null, summary }
          : [],
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

  it("keeps labels, counts and long monetary totals inside flexible cards", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    fireEvent(window, new Event("resize"));
    const Wrapper = makeAuthWrapper("/invoices", { user: ADMIN_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    const grid = screen.getByTestId("invoice-summary-cards");
    expect(grid.className).toContain("grid-cols-2");
    for (let ancestor: HTMLElement | null = grid; ancestor; ancestor = ancestor.parentElement) {
      expect(ancestor.className).not.toMatch(/\boverflow-hidden\b/);
    }

    const cards = Array.from(grid.children) as HTMLElement[];
    expect(cards).toHaveLength(4);
    for (const [card, label, count, amount] of [
      [cards[0], "Open Balance", "2 invoices", "$123,456,789.12"],
      [cards[1], "Overdue", "1 invoice", "$98,765,432.10"],
      [cards[2], "Paid This Month", "3 invoices", "$87,654,321.99"],
    ] as const) {
      expect(card).toHaveClass("min-w-0");
      expect(within(card).getByText(label)).toBeVisible();
      const total = await within(card).findByText(amount);
      expect(total).toBeVisible();
      expect(total).toHaveClass("[overflow-wrap:anywhere]");
      expect(within(card).getByText(count)).toBeVisible();
    }
  });
});