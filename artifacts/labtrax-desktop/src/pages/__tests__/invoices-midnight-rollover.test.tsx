/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
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

const USER = { id: "user-1", username: "billing", role: "billing" } as unknown as SessionUser;

const rolloverCases = [
  {
    preset: "today",
    start: new Date(2026, 1, 28, 23, 59),
    before: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    after: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
  },
  {
    preset: "yesterday",
    start: new Date(2026, 11, 31, 23, 59),
    before: ["2026-12-30T00:00:00.000Z", "2026-12-31T00:00:00.000Z"],
    after: ["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  },
] as const;

const dstRolloverCases = [
  {
    transition: "spring-forward",
    preset: "today",
    year: 2026,
    month: 2,
    day: 8,
    before: ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
    after: ["2026-03-09T00:00:00.000Z", "2026-03-10T00:00:00.000Z"],
  },
  {
    transition: "spring-forward",
    preset: "yesterday",
    year: 2026,
    month: 2,
    day: 8,
    before: ["2026-03-07T00:00:00.000Z", "2026-03-08T00:00:00.000Z"],
    after: ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
  },
  {
    transition: "fall-back",
    preset: "today",
    year: 2026,
    month: 10,
    day: 1,
    before: ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
    after: ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"],
  },
  {
    transition: "fall-back",
    preset: "yesterday",
    year: 2026,
    month: 10,
    day: 1,
    before: ["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    after: ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
  },
] as const;

const timezoneResumeCases = [
  {
    preset: "today",
    before: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    after: ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
  },
  {
    preset: "yesterday",
    before: ["2026-02-27T00:00:00.000Z", "2026-02-28T00:00:00.000Z"],
    after: ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
  },
] as const;

function invoice(index: number, issuedAt: string): Invoice {
  return {
    id: `invoice-${index}`,
    invoiceNumber: `INV-${String(index).padStart(3, "0")}`,
    status: "open",
    total: 1,
    balanceDue: 1,
    issuedAt,
    labOrganizationId: "lab-1",
    providerOrganizationId: "practice-1",
    caseId: null,
    createdAt: issuedAt,
    items: [],
  } as unknown as Invoice;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});


describe("desktop invoice date filter midnight rollover", () => {
  it.each(rolloverCases)(
    "keeps $preset selected and restarts paging across month/year rollover",
    async ({ preset, start, before, after }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(start);
      window.history.replaceState({}, "", "/invoices");

        const requests: URL[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          if (url.pathname.endsWith("/api/invoices")) {
            requests.push(url);
            const issuedAt = url.searchParams.get("issuedFrom") ?? before[0];
            const all = Array.from({ length: 60 }, (_, index) => invoice(index, issuedAt));
            const startIndex = Number(url.searchParams.get("offset") ?? 0);
            const rows = all.slice(startIndex, startIndex + Number(url.searchParams.get("limit")));
            return new Response(JSON.stringify({
              rows,
              total: all.length,
              limit: Number(url.searchParams.get("limit")),
              offset: startIndex,
              hasMore: startIndex + rows.length < all.length,
              nextCursor: rows.at(-1)?.id ?? null,
              summary: {
                openBalance: 12,
                openCount: 12,
                overdueBalance: 0,
                overdueCount: 0,
                sumTotal: 12,
                sumBalance: 12,
                paidThisMonth: 0,
                paidCount: 0,
              },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (url.pathname.endsWith("/cases/doctor-names") || url.pathname.endsWith("/organizations")) {
            return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }));

        const Wrapper = makeAuthWrapper("/invoices", { user: USER, status: "authed" });
        render(<Wrapper><InvoicesPage /></Wrapper>);
        await screen.findByText("INV-000");

        fireEvent.change(screen.getByTitle("Invoice date"), { target: { value: preset } });
        await waitFor(() => {
          expect(requests.at(-1)?.searchParams.get("issuedFrom")).toBe(before[0]);
          expect(requests.at(-1)?.searchParams.get("issuedTo")).toBe(before[1]);
        });

        fireEvent.click(await screen.findByTestId("invoices-page-2"));
        await waitFor(() => {
          expect(requests.at(-1)?.searchParams.get("offset")).toBe("25");
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        await waitFor(() => {
          const latest = requests.at(-1);
          expect(latest?.searchParams.get("issuedFrom")).toBe(after[0]);
          expect(latest?.searchParams.get("issuedTo")).toBe(after[1]);
          expect(latest?.searchParams.get("offset")).toBe("0");
        });
        await screen.findByText("INV-000");
        expect((screen.getByTitle("Invoice date") as HTMLSelectElement).value).toBe(preset);
        expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 1-25 of 60");
    },
  );

  it.each(dstRolloverCases)(
    "refreshes $preset at local midnight on the $transition date",
    async ({ preset, year, month, day, before, after }) => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.setSystemTime(new Date(year, month, day, 23, 59));
        window.history.replaceState({}, "", "/invoices");

        const requests: URL[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          if (url.pathname.endsWith("/api/invoices")) {
            requests.push(url);
            const issuedAt = url.searchParams.get("issuedFrom") ?? before[0];
            const all = Array.from({ length: 60 }, (_, index) => invoice(index, issuedAt));
            const startIndex = Number(url.searchParams.get("offset") ?? 0);
            const rows = all.slice(startIndex, startIndex + Number(url.searchParams.get("limit")));
            return new Response(JSON.stringify({
              rows,
              total: all.length,
              limit: Number(url.searchParams.get("limit")),
              offset: startIndex,
              hasMore: startIndex + rows.length < all.length,
              nextCursor: rows.at(-1)?.id ?? null,
              summary: {
                openBalance: 12,
                openCount: 12,
                overdueBalance: 0,
                overdueCount: 0,
                sumTotal: 12,
                sumBalance: 12,
                paidThisMonth: 0,
                paidCount: 0,
              },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (url.pathname.endsWith("/cases/doctor-names") || url.pathname.endsWith("/organizations")) {
            return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }));

        const Wrapper = makeAuthWrapper("/invoices", { user: USER, status: "authed" });
        render(<Wrapper><InvoicesPage /></Wrapper>);
        await screen.findByText("INV-000");

        fireEvent.change(screen.getByTitle("Invoice date"), { target: { value: preset } });
        await waitFor(() => {
          expect(requests.at(-1)?.searchParams.get("issuedFrom")).toBe(before[0]);
          expect(requests.at(-1)?.searchParams.get("issuedTo")).toBe(before[1]);
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        await waitFor(() => {
          const latest = requests.at(-1);
          expect(latest?.searchParams.get("issuedFrom")).toBe(after[0]);
          expect(latest?.searchParams.get("issuedTo")).toBe(after[1]);
        });
        expect((screen.getByTitle("Invoice date") as HTMLSelectElement).value).toBe(preset);
      } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    },
  );

  it.each(timezoneResumeCases)(
    "refreshes $preset and restarts paging when the browser tab becomes visible in a new timezone",
    async ({ preset, before, after }) => {
      const originalTimeZone = process.env.TZ;
      const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
      try {
        process.env.TZ = "America/Los_Angeles";
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-03-01T05:00:00.000Z"));
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        window.history.replaceState({}, "", "/invoices");

        const requests: URL[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          if (url.pathname.endsWith("/api/invoices")) {
            requests.push(url);
            const issuedAt = url.searchParams.get("issuedFrom") ?? before[0];
            const all = Array.from({ length: 60 }, (_, index) => invoice(index, issuedAt));
            const startIndex = Number(url.searchParams.get("offset") ?? 0);
            const rows = all.slice(startIndex, startIndex + Number(url.searchParams.get("limit")));
            return new Response(JSON.stringify({
              rows,
              total: all.length,
              limit: Number(url.searchParams.get("limit")),
              offset: startIndex,
              hasMore: startIndex + rows.length < all.length,
              nextCursor: rows.at(-1)?.id ?? null,
              summary: {
                openBalance: 12,
                openCount: 12,
                overdueBalance: 0,
                overdueCount: 0,
                sumTotal: 12,
                sumBalance: 12,
                paidThisMonth: 0,
                paidCount: 0,
              },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (url.pathname.endsWith("/cases/doctor-names") || url.pathname.endsWith("/organizations")) {
            return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }));

        const Wrapper = makeAuthWrapper("/invoices", { user: USER, status: "authed" });
        render(<Wrapper><InvoicesPage /></Wrapper>);
        await screen.findByText("INV-000");

        fireEvent.change(screen.getByTitle("Invoice date"), { target: { value: preset } });
        await waitFor(() => {
          expect(requests.at(-1)?.searchParams.get("issuedFrom")).toBe(before[0]);
          expect(requests.at(-1)?.searchParams.get("issuedTo")).toBe(before[1]);
        });

        fireEvent.click(await screen.findByTestId("invoices-page-2"));
        await waitFor(() => {
          expect(requests.at(-1)?.searchParams.get("offset")).toBe("25");
        });

        process.env.TZ = "Pacific/Kiritimati";
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        await waitFor(() => {
          const latest = requests.at(-1);
          expect(latest?.searchParams.get("issuedFrom")).toBe(after[0]);
          expect(latest?.searchParams.get("issuedTo")).toBe(after[1]);
          expect(latest?.searchParams.get("offset")).toBe("0");
        });
        expect((screen.getByTitle("Invoice date") as HTMLSelectElement).value).toBe(preset);
        await waitFor(() => {
          expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 1-25 of 60");
        });
      } finally {
        if (originalTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimeZone;
        if (originalVisibility) {
          Object.defineProperty(document, "visibilityState", originalVisibility);
        } else {
          delete (document as unknown as { visibilityState?: string }).visibilityState;
        }
      }
    },
  );
});
