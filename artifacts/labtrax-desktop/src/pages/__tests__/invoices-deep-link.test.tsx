/** @vitest-environment jsdom */
/**
 * Deep-link regression: /invoices?invoiceId=<id> must open that invoice's
 * editor directly. This mirrors the ?caseId= deep link on the cases list
 * page (useSearch()-driven, guarded by a "last processed id" ref).
 *
 * The target invoice may not be present in the currently-loaded (filtered)
 * list, so the effect must fall back to fetching it directly — and if that
 * fetch also fails (invoice deleted/inaccessible), the user must stay on the
 * normal invoices list rather than being left on a blank page.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
import { useLocation, useSearch } from "wouter";
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

const BILLING_USER = {
  id: "u-bill",
  username: "billing",
  role: "billing",
} as unknown as SessionUser;

const LOADED_INVOICE: Invoice = {
  id: "inv-loaded",
  invoiceNumber: "INV-LOADED",
  status: "open",
  total: 100,
  balanceDue: 100,
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  items: [],
  displayMetadata: { patientName: "Loaded Patient" },
} as unknown as Invoice;

const NOT_LOADED_INVOICE: Invoice = {
  id: "inv-not-loaded",
  invoiceNumber: "INV-NOT-LOADED",
  status: "open",
  total: 50,
  balanceDue: 50,
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  items: [],
  displayMetadata: { patientName: "Fallback Patient" },
} as unknown as Invoice;

function CurrentLocation() {
  const [location] = useLocation();
  const search = useSearch();
  return <output data-testid="current-location">{location}{search ? `?${search}` : ""}</output>;
}

function installFetch(opts: {
  list: Invoice[];
  detailById?: Record<string, Invoice | "404">;
  onUrl?: (url: string) => void;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      opts.onUrl?.(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
        return json(opts.list);
      }
      const singleMatch = url.match(/\/api\/invoices\/([^/?]+)/);
      if (singleMatch) {
        const detail = opts.detailById?.[singleMatch[1]];
        if (!detail || detail === "404") return json({ message: "Not found" }, 404);
        return json(detail);
      }
      if (url.includes("/invoice-template/presets")) return json({ presets: [] });
      if (url.includes("/cases/doctor-names")) return json([]);
      if (url.includes("/organizations")) return json([]);
      return json({});
    }),
  );
}

describe("Invoices ?invoiceId= deep link", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
  });

  it("opens the editor directly for an invoice already in the loaded list", async () => {
    installFetch({
      list: [LOADED_INVOICE],
      detailById: { "inv-loaded": LOADED_INVOICE },
    });
    const Wrapper = makeAuthWrapper("/invoices?invoiceId=inv-loaded", {
      user: BILLING_USER,
      status: "authed",
    });
    render(
      <Wrapper>
        <InvoicesPage />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByDisplayValue("INV-LOADED")).toBeInTheDocument());
  });

  it("falls back to fetching the invoice directly when it is not in the currently loaded list", async () => {
    const requestedUrls: string[] = [];
    installFetch({
      list: [LOADED_INVOICE],
      detailById: { "inv-not-loaded": NOT_LOADED_INVOICE },
      onUrl: (u) => requestedUrls.push(u),
    });
    const Wrapper = makeAuthWrapper("/invoices?invoiceId=inv-not-loaded", {
      user: BILLING_USER,
      status: "authed",
    });
    render(
      <Wrapper>
        <InvoicesPage />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByDisplayValue("INV-NOT-LOADED")).toBeInTheDocument());
    expect(requestedUrls.some((u) => u.includes("/api/invoices/inv-not-loaded"))).toBe(true);
  });

  it("does not leave a blank page when the deep-linked invoice cannot be found", async () => {
    installFetch({
      list: [LOADED_INVOICE],
      detailById: { "inv-missing": "404" },
    });
    const Wrapper = makeAuthWrapper("/invoices?invoiceId=inv-missing", {
      user: BILLING_USER,
      status: "authed",
    });
    render(
      <Wrapper>
        <InvoicesPage />
      </Wrapper>,
    );

    // The normal list renders; the missing invoice never opens an editor.
    await waitFor(() => expect(screen.getByText("INV-LOADED")).toBeInTheDocument());
    expect(screen.queryByLabelText("Close without saving")).not.toBeInTheDocument();
  });

  it("opens the read-only preview from Sales and returns to its saved report URL", async () => {
    installFetch({
      list: [LOADED_INVOICE],
      detailById: { "inv-loaded": LOADED_INVOICE },
    });
    const returnTo = "/reports?tab=sales&preset=custom&from=2025-01-01T00%3A00%3A00.000Z&to=2025-01-31T23%3A59%3A59.999Z&org=lab-1";
    const Wrapper = makeAuthWrapper(
      `/invoices?previewId=inv-loaded&returnTo=${encodeURIComponent(returnTo)}`,
      { user: BILLING_USER, status: "authed" },
    );
    render(
      <Wrapper>
        <InvoicesPage />
        <CurrentLocation />
      </Wrapper>,
    );

    await screen.findByTestId("invoice-preview");
    expect(screen.queryByDisplayValue("INV-LOADED")).toBeNull();
    fireEvent.click(screen.getByTestId("invoice-preview-close"));

    await waitFor(() => {
      const current = new URL(screen.getByTestId("current-location").textContent!, "http://localhost");
      expect(current.pathname).toBe("/reports");
      expect(current.searchParams.get("tab")).toBe("sales");
      expect(current.searchParams.get("preset")).toBe("custom");
      expect(current.searchParams.get("from")).toBe("2025-01-01T00:00:00.000Z");
      expect(current.searchParams.get("to")).toBe("2025-01-31T23:59:59.999Z");
      expect(current.searchParams.get("org")).toBe("lab-1");
      expect(screen.queryByTestId("invoice-preview")).toBeNull();
    });
  });
});
