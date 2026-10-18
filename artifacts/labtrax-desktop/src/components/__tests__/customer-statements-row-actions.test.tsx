/** @vitest-environment jsdom */
// Per-row "Download PDF" / "Resend email" actions on the Statements tab of the
// customer slide-in window. Download must hit the server-persisted PDF
// endpoint. Resend opens an inline recipient form prefilled with the
// practice's billing email: sending it unchanged POSTs WITHOUT a `to` field
// (server resolves billingEmail); editing it to another valid address POSTs
// WITH `to`; invalid/empty addresses are rejected client-side.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StatementsTab } from "@/components/customer-detail-tabs";
import type { Organization, PracticeStatement } from "@/lib/types";
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

const baseStatement = {
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
  lastEmailedAt: null as string | null,
  lastEmailedTo: null as string | null,
};

let statements: PracticeStatement[];

let fetchMock: ReturnType<typeof vi.fn>;
let emailFailure: { status: number; message: string } | null = null;
let pdfFailure: { status: number; message: string } | null = null;

beforeEach(() => {
  emailFailure = null;
  pdfFailure = null;
  statements = [{ ...baseStatement }];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/practice-statements/st-1/email")) {
      if (emailFailure) {
        return new Response(
          JSON.stringify({ ok: false, message: emailFailure.message }),
          { status: emailFailure.status, headers: { "Content-Type": "application/json" } },
        );
      }
      // Simulate the server recording the send: subsequent list fetches
      // include the last-emailed timestamp + recipient.
      statements = statements.map((s) =>
        s.id === "st-1"
          ? {
              ...s,
              lastEmailedAt: "2026-07-09T15:30:00.000Z",
              lastEmailedTo: "billing@smith.example",
            }
          : s,
      );
      return new Response(
        JSON.stringify({ ok: true, data: { id: "send-1", status: "sent" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/practice-statements/st-1/pdf")) {
      if (pdfFailure) {
        return new Response(
          JSON.stringify({ ok: false, message: pdfFailure.message }),
          { status: pdfFailure.status, headers: { "Content-Type": "application/json" } },
        );
      }
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

function getEmailCall() {
  return fetchMock.mock.calls.find(([u]) =>
    String(u).includes("/practice-statements/st-1/email"),
  );
}

describe("StatementsTab per-row actions", () => {
  it("renders Download PDF and Resend actions for each statement row", async () => {
    renderTab();
    await waitForRow();
    expect(screen.getByTestId("button-download-statement-st-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-resend-statement-st-1")).toBeInTheDocument();
  });

  it("Resend opens a recipient form prefilled with the practice's billing email", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));

    const input = screen.getByTestId("input-resend-recipient-st-1") as HTMLInputElement;
    expect(input.value).toBe("billing@smith.example");
    // Nothing is sent until the user confirms.
    expect(getEmailCall()).toBeUndefined();
  });

  it("sending with the prefilled billing email posts WITHOUT a `to` override and shows success", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("statement-row-notice-st-1").textContent).toContain(
      "billing@smith.example",
    );

    const emailCall = getEmailCall();
    expect(emailCall).toBeTruthy();
    const [, init] = emailCall!;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(emailCall![1]?.body));
    // No `to` — the server resolves the practice's billing email itself.
    expect(body.to).toBeUndefined();
    // No index preserves the existing full-bundle resend behavior.
    expect(body.attachmentIndex).toBeUndefined();
    expect(body.subject).toContain("Dr. Smith Practice");
    expect(body.message).toContain("statement");

    // The form closes on success.
    expect(screen.queryByTestId("input-resend-recipient-st-1")).not.toBeInTheDocument();
  });

  it("sending to an edited address posts WITH the `to` override", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.change(screen.getByTestId("input-resend-recipient-st-1"), {
      target: { value: "accountant@office.example" },
    });
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("statement-row-notice-st-1").textContent).toContain(
      "accountant@office.example",
    );

    const emailCall = getEmailCall();
    expect(emailCall).toBeTruthy();
    const body = JSON.parse(String(emailCall![1]?.body));
    expect(body.to).toBe("accountant@office.example");
  });

  it("rejects an invalid custom address client-side without posting", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.change(screen.getByTestId("input-resend-recipient-st-1"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    expect(screen.getByTestId("resend-recipient-error-st-1").textContent).toContain(
      "valid email",
    );
    expect(getEmailCall()).toBeUndefined();
  });

  it("rejects an empty address client-side without posting", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.change(screen.getByTestId("input-resend-recipient-st-1"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    expect(screen.getByTestId("resend-recipient-error-st-1").textContent).toContain(
      "Enter a recipient",
    );
    expect(getEmailCall()).toBeUndefined();
  });

  it("Cancel closes the recipient form without posting", async () => {
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    expect(screen.getByTestId("input-resend-recipient-st-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-resend-cancel-st-1"));
    expect(screen.queryByTestId("input-resend-recipient-st-1")).not.toBeInTheDocument();
    expect(getEmailCall()).toBeUndefined();
  });

  it("shows no last-emailed indicator for rows never emailed", async () => {
    renderTab();
    await waitForRow();
    expect(screen.queryByTestId("statement-last-emailed-st-1")).not.toBeInTheDocument();
  });

  it("shows 'Emailed <date> to <address>' when the statement was already sent", async () => {
    statements = [
      {
        ...baseStatement,
        lastEmailedAt: "2026-07-05T10:00:00.000Z",
        lastEmailedTo: "billing@smith.example",
      },
    ];
    renderTab();
    await waitForRow();
    const indicator = screen.getByTestId("statement-last-emailed-st-1");
    expect(indicator.textContent).toContain("Emailed");
    expect(indicator.textContent).toContain("07/05/2026");
    expect(indicator.textContent).toContain("to billing@smith.example");
  });

  it("Resend refetches the list so the last-emailed indicator appears", async () => {
    renderTab();
    await waitForRow();
    expect(screen.queryByTestId("statement-last-emailed-st-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-last-emailed-st-1")).toBeInTheDocument(),
    );
    const indicator = screen.getByTestId("statement-last-emailed-st-1");
    expect(indicator.textContent).toContain("Emailed");
    expect(indicator.textContent).toContain("to billing@smith.example");
  });

  it("Resend surfaces a server error inline on the row and keeps the form open", async () => {
    emailFailure = {
      status: 400,
      message: "This practice has no billing email on file. Add one first or enter a recipient.",
    };
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-resend-statement-st-1"));
    fireEvent.click(screen.getByTestId("button-resend-send-st-1"));

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("statement-row-notice-st-1").textContent).toContain(
      "no billing email",
    );
    // The form stays open so the user can correct the recipient and retry.
    expect(screen.getByTestId("input-resend-recipient-st-1")).toBeInTheDocument();
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

  it("shows every bundled doctor PDF with open and download actions", async () => {
    statements = [
      {
        ...baseStatement,
        bundleAttachments: [
          {
            index: 0,
            doctorName: "Dr. Ada North",
            label: "Ada North",
            fileName: "statement-Ada_North.pdf",
          },
          {
            index: 1,
            doctorName: "Dr. Lin West",
            label: "Lin West",
            fileName: "statement-Lin_West.pdf",
          },
        ],
      },
    ] as typeof statements;
    renderTab();
    await waitForRow();

    expect(screen.getByText("Dr. Ada North")).toBeInTheDocument();
    expect(screen.getByText("Dr. Lin West")).toBeInTheDocument();
    expect(
      screen.getByTestId("button-open-statement-st-1-attachment-0"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("button-download-statement-st-1-attachment-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("button-resend-statement-st-1-attachment-0"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("button-resend-statement-st-1-attachment-1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("button-download-statement-st-1"),
    ).not.toBeInTheDocument();
  });

  it("resends only the selected original doctor PDF", async () => {
    statements = [
      {
        ...baseStatement,
        bundleAttachments: [
          {
            index: 0,
            doctorName: "Dr. Ada North",
            label: "Ada North",
            fileName: "statement-Ada_North.pdf",
          },
          {
            index: 1,
            doctorName: "Dr. Lin West",
            label: "Lin West",
            fileName: "statement-Lin_West.pdf",
          },
        ],
      },
    ] as typeof statements;
    renderTab();

    fireEvent.click(
      await screen.findByTestId(
        "button-resend-statement-st-1-attachment-1",
      ),
    );
    expect(
      screen.getByTestId("input-resend-recipient-st-1-attachment-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Resending Dr. Lin West")).toBeInTheDocument();

    fireEvent.click(
      screen.getByTestId("button-resend-send-st-1-attachment-1"),
    );

    await waitFor(() =>
      expect(screen.getByTestId("statement-row-notice-st-1")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("statement-row-notice-st-1").textContent,
    ).toContain("Dr. Lin West");

    const emailCall = getEmailCall();
    expect(emailCall).toBeTruthy();
    const body = JSON.parse(String(emailCall![1]?.body));
    expect(body.attachmentIndex).toBe(1);
  });

  it("downloads the selected original bundle attachment", async () => {
    const createObjectURL = vi.fn(() => "blob:bundle-mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL,
        revokeObjectURL,
      }),
    );
    statements = [
      {
        ...baseStatement,
        bundleAttachments: [
          {
            index: 0,
            doctorName: "Dr. Ada North",
            label: "Ada North",
            fileName: "statement-Ada_North.pdf",
          },
          {
            index: 1,
            doctorName: "Dr. Lin West",
            label: "Lin West",
            fileName: "statement-Lin_West.pdf",
          },
        ],
      },
    ] as typeof statements;
    renderTab();

    fireEvent.click(
      await screen.findByTestId(
        "button-download-statement-st-1-attachment-1",
      ),
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/practice-statements/st-1/pdf?attachmentIndex=1",
        ),
      ),
    ).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:bundle-mock");
  });

  it("opens the selected original bundle attachment in a new tab", async () => {
    const pdfWindow = {
      opener: window,
      location: { href: "" },
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const openWindow = vi
      .spyOn(window, "open")
      .mockReturnValue(pdfWindow as unknown as Window);
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn(() => "blob:bundle-open"),
        revokeObjectURL: vi.fn(),
      }),
    );
    statements = [
      {
        ...baseStatement,
        bundleAttachments: [
          {
            index: 0,
            doctorName: "Dr. Ada North",
            label: "Ada North",
            fileName: "statement-Ada_North.pdf",
          },
          {
            index: 1,
            doctorName: "Dr. Lin West",
            label: "Lin West",
            fileName: "statement-Lin_West.pdf",
          },
        ],
      },
    ] as typeof statements;
    renderTab();

    fireEvent.click(
      await screen.findByTestId("button-open-statement-st-1-attachment-1"),
    );

    await waitFor(() =>
      expect(pdfWindow.location.href).toBe("blob:bundle-open"),
    );
    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(pdfWindow.opener).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/practice-statements/st-1/pdf?attachmentIndex=1",
        ),
      ),
    ).toBe(true);
  });

  it.each(["open", "download"] as const)(
    "identifies the doctor and filename when a bundle attachment cannot be %s",
    async (action) => {
      const fileName = "statement-Lin_West.pdf";
      const errorMessage = `Statement PDF for Dr. Lin West (${fileName}) is missing.`;
      pdfFailure = { status: 404, message: errorMessage };
      statements = [
        {
          ...baseStatement,
          bundleAttachments: [
            {
              index: 0,
              doctorName: "Dr. Ada North",
              label: "Ada North",
              fileName: "statement-Ada_North.pdf",
            },
            {
              index: 1,
              doctorName: "Dr. Lin West",
              label: "Lin West",
              fileName,
            },
          ],
        },
      ] as typeof statements;

      const pdfWindow = {
        opener: window,
        location: { href: "" },
        addEventListener: vi.fn(),
        close: vi.fn(),
      };
      const openWindow = vi
        .spyOn(window, "open")
        .mockReturnValue(pdfWindow as unknown as Window);
      renderTab();

      fireEvent.click(
        await screen.findByTestId(
          `button-${action}-statement-st-1-attachment-1`,
        ),
      );

      expect(await screen.findByTestId("statement-row-notice-st-1"))
        .toHaveTextContent(errorMessage);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes(
            "/practice-statements/st-1/pdf?attachmentIndex=1",
          ),
        ),
      ).toBe(true);
      if (action === "open") {
        expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
        expect(pdfWindow.close).toHaveBeenCalled();
      }
    },
  );

  it("keeps legacy single-PDF rows on the original PDF endpoint", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL,
        revokeObjectURL: vi.fn(),
      }),
    );
    renderTab();
    await waitForRow();

    fireEvent.click(screen.getByTestId("button-download-statement-st-1"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(([url]) => {
        const requestUrl = String(url);
        return (
          requestUrl.includes("/practice-statements/st-1/pdf") &&
          !requestUrl.includes("attachmentIndex")
        );
      }),
    ).toBe(true);
  });

  it("renders the Statement # column as MM-YYYY derived from periodStart using UTC month", async () => {
    // 2026-06-01T00:00:00.000Z is June in UTC but May 31 in west-of-UTC locales;
    // the statement number must be "06-2026" regardless of local timezone.
    renderTab();
    await waitForRow();
    expect(screen.getByText("06-2026")).toBeInTheDocument();
  });

  it("uses the UTC month for Statement # so a west-of-UTC timezone does not shift to the prior month", async () => {
    // 2026-07-01T00:30:00.000Z is July in UTC but could resolve to June 30 in
    // UTC-1 and further west. Confirm the column shows "07-2026", not "06-2026".
    statements = [{ ...baseStatement, periodStart: "2026-07-01T00:30:00.000Z" }];
    renderTab();
    await waitForRow();
    expect(screen.getByText("07-2026")).toBeInTheDocument();
    expect(screen.queryByText("06-2026")).not.toBeInTheDocument();
  });

  it("shows em-dash in Paid On and Payment Method columns when no payment recorded", async () => {
    renderTab();
    await waitForRow();
    // The row has no paidAt / paymentMethod; there should be no payment label.
    expect(screen.queryByText("Check")).not.toBeInTheDocument();
    expect(screen.queryByText("Card")).not.toBeInTheDocument();
    expect(screen.queryByText("ACH")).not.toBeInTheDocument();
  });

  it("shows Paid On date and Payment Method label when a payment is recorded", async () => {
    statements = [
      {
        ...baseStatement,
        paidAt: "2026-07-10T09:00:00.000Z",
        paymentMethod: "check",
      } as typeof baseStatement & { paidAt: string; paymentMethod: string },
    ];
    renderTab();
    await waitForRow();
    expect(screen.getByText("07/10/2026")).toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
  });

  it("maps all known payment method codes to human-readable labels", async () => {
    for (const [code, label] of [
      ["card", "Card"],
      ["ach", "ACH"],
      ["cash", "Cash"],
      ["other", "Other"],
    ] as const) {
      statements = [
        {
          ...baseStatement,
          paidAt: "2026-07-10T09:00:00.000Z",
          paymentMethod: code,
        } as typeof baseStatement & { paidAt: string; paymentMethod: string },
      ];
      const Wrapper = makeAuthWrapper("/accounts");
      const { unmount } = render(
        <Wrapper>
          <StatementsTab selected={practice} labOrgId="lab-1" />
        </Wrapper>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("button-resend-statement-st-1")).toBeInTheDocument(),
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });
});
