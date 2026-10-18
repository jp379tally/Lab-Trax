/** @vitest-environment jsdom */
/**
 * Responsive regression for the unified invoice toolbar.
 *
 * jsdom does not calculate flex line boxes, so this test protects the layout
 * contract (a wrapping toolbar with no clipping ancestor) and then exercises
 * every control at the narrow desktop widths used by browser and packaged
 * desktop windows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

const ADMIN_USER = {
  id: "u-admin",
  username: "admin",
  role: "admin",
} as unknown as SessionUser;

const INVOICE = {
  id: "inv-responsive",
  invoiceNumber: "INV-RESPONSIVE",
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "practice-1",
  status: "open",
  total: 100,
  balanceDue: 100,
  items: [],
  displayMetadata: {
    patientName: "Narrow Window",
    billTo: "Dr. Responsive",
  },
} as unknown as Invoice;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/invoices")) {
        return new Response(JSON.stringify([INVOICE]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/cases/doctor-names")) {
        return new Response(JSON.stringify(["Dr. Responsive"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function renderAtWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  fireEvent(window, new Event("resize"));

  const Wrapper = makeAuthWrapper("/invoices", {
    user: ADMIN_USER,
    status: "authed",
  });
  const view = render(
    <Wrapper>
      <InvoicesPage />
    </Wrapper>,
  );
  await screen.findByText("INV-RESPONSIVE");
  return view;
}

describe.each([640, 800])("Invoices responsive controls at %ipx", (width) => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
    installFetch();
  });

  it("keeps every wrapped control reachable and interactive", async () => {
    const { unmount } = await renderAtWidth(width);
    const controls = screen.getByTestId("invoice-controls");
    const toolbar = screen.getByPlaceholderText(/search invoice/i).parentElement?.parentElement;

    expect(toolbar).toBeTruthy();
    expect(toolbar?.className).toMatch(/\bflex-wrap\b/);
    for (let element: HTMLElement | null = toolbar ?? null; element; element = element.parentElement) {
      expect(element.className).not.toMatch(/\boverflow-hidden\b/);
    }

    const search = screen.getByPlaceholderText(/search invoice/i);
    fireEvent.change(search, { target: { value: "RESPONSIVE" } });
    expect(search).toHaveValue("RESPONSIVE");

    const status = screen.getByTestId("invoices-status-filter");
    expect(controls.contains(status)).toBe(true);
    fireEvent.click(status);
    expect(status).toHaveAttribute("aria-expanded", "true");
    const statusMenu = screen.getByRole("menu", { name: /status filter options/i });
    expect(controls.contains(statusMenu)).toBe(true);
    expect(statusMenu.className).toMatch(/\bz-50\b/);
    expect(screen.getByRole("menuitemcheckbox", { name: /^Open$/ })).toBeVisible();

    const invoiceDate = screen.getByTitle("Invoice date");
    fireEvent.change(invoiceDate, { target: { value: "this_month" } });
    expect(invoiceDate).toHaveValue("this_month");

    const aging = screen.getByTitle("Overdue bucket");
    fireEvent.change(aging, { target: { value: "31_60" } });
    expect(aging).toHaveValue("31_60");

    const doctor = screen.getByTitle("Filter by doctor");
    fireEvent.change(doctor, { target: { value: "Dr. Responsive" } });
    expect(doctor).toHaveValue("Dr. Responsive");

    const aiOnly = screen.getByRole("checkbox", { name: /ai-imported only/i });
    fireEvent.click(aiOnly);
    expect(aiOnly).toBeChecked();

    const statements = screen.getByRole("button", { name: /multi-practice statement/i });
    expect(controls.contains(statements)).toBe(true);
    fireEvent.click(statements);
    expect(await screen.findByText(/build practice statement/i)).toBeVisible();

    unmount();
  });
});