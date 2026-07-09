/** @vitest-environment jsdom */
// Per-row "Download PDF" / "Resend email" actions on the Statements tab of the
// customer slide-in window. Download must hit the server-persisted PDF
// endpoint; Resend must POST to the statement email endpoint WITHOUT a `to`
// field so the server falls back to the practice's billing email.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StatementsTab } from "@/components/customer-detail-tabs";
import type { Organization } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// jspdf / react-pdf are pulled in at import time via `@/lib/export` and
// `@/pages/invoices`; neither is jsdom-friendly and the row actions never
// exercise client-side PDF generation.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const practice = {
  id: "prov-1",
  name: "Dr. Smith Practice",
  type: "provider",
  billingEmail: "billing@smith.example",
} as unknown as Organization;

const statements = [
  {
    id: "st-1",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.000Z",
    invoiceCount: 3,
    totalBilled: "450.00",
    totalPaid: "100.00",
    balanceDue: "350.00",
    pdfFileName: "statement-Dr_Smith_Practice-st-1.pdf",
    pdfStorageKey: "statement-Dr_Smith_Practice-st-1.pdf",
    createdAt: "2026-07-01T12:00:00.000Z",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let emailFailure: { status: number; message: string } | null = null;

beforeEach(() => {
  emailFailure = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/practice-statements/st-1/email")) {
      if (emailFailure) {
        return new Response(
          JSON.stringify({ ok: false, message: emailFailure.message }),
          { status: emailFailure.status, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, data: { id: "send-1", status: "sent" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/practice-statements/st-1/pdf")) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.includes("/invoices/practice-statements")) {
      return new Response(JSON.stringify({ ok: true, data: statements }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    void init;
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTab() {
  const Wrapper = makeAuthWrapper("/accounts");
  render(
    <Wrapper>
      <StatementsTab selected={practice} labOrgId="lab-1" />
    </Wrapper>,
  );
}

async function waitForRow() {
  await waitFor(() =>
    expect(screen.getByTestId("button-resend-statement-st-1")).toBeInTheDocument(),
  );
}

describe("StatementsTab per-row actions", () => {
  it("renders Download PDF and Resend actions for each statement row", async () => {
    renderTab();
    await waitForRow();
    expect(screen.getByTestId("button-download-statement-st-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-resend-statement-st-1")).toBeInTheDocument();
  });

  it("Resend posts to the statement email endpoint without a `to` override and shows success", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("statement-row-notice-st-1").textContent).toContain(
      "billing@smith.example",
    );

    const emailCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/practice-statements/st-1/email"),
    );
    expect(emailCall).toBeTruthy();
    const [, init] = emailCall!;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    // No `to` — the server resolves the practice's billing email itself.
    expect(body.to).toBeUndefined();
    expect(body.subject).toContain("Dr. Smith Practice");
    expect(body.message).toContain("statement");
  });

  it("Resend surfaces a server error inline on the row", async () => {
    emailFailure = {
      status: 400,
      message: "This practice has no billing email on file. Add one first or enter a recipient.",
    };
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("statement-row-notice-st-1").textContent).toContain(
      "no billing email",
    );
  });

  it("Download PDF fetches the server-persisted statement PDF", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL,
      revokeObjectURL,
    }));

    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-download-statement-st-1"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const pdfCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/practice-statements/st-1/pdf"),
    );
    expect(pdfCall).toBeTruthy();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalled());
  });
});
