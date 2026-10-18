// Signing the auto-pay authorization from Account → Provider Billing.
//
// The provider portal's My Account signs the same card, and that is covered in
// provider-account.test.tsx. This file holds the other entry point — the one
// that had the flow first — so moving the agreement into a shared component
// cannot quietly stop the lab app's billing screen from signing.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetMockAppState, resetMockFetchHandler, setMockFetchHandler } from "../../vitest.setup";

// The global setup stubs useQuery so screens render without a cache; this
// screen is exercised against real queries, because signing has to re-read.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

// The pad draws with react-native-svg and captures strokes through
// PanResponder, neither of which the test renderer provides. What the card
// reads is the handle, so the stub answers with a signature.
vi.mock("@/components/settings/SignaturePad", async () => {
  const react = await import("react");
  return {
    SignaturePad: react.forwardRef(
      (_props: unknown, ref: React.Ref<{ toDataUrl: () => string | null; clear: () => void }>) => {
        react.useImperativeHandle(ref, () => ({
          toDataUrl: () => "data:image/png;base64,SIGNATURE",
          clear: () => undefined,
        }));
        return null;
      },
    ),
  };
});

import ProviderBillingScreen from "@/app/settings/provider-billing";

const PRACTICE_ID = "prac-north";
const LAB_ID = "lab-bright";

let sent: Array<{ url: string; method: string; body: string | null }>;
let authorization: Record<string, unknown> | null;

function posts(fragment: string) {
  return sent.filter((entry) => entry.url.includes(fragment) && entry.method === "POST");
}

function installHandler(): void {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/api/provider/payment-method")) {
      const card = {
        providerOrganizationId: PRACTICE_ID,
        brand: "VISA",
        last4: "4242",
        expMonth: 4,
        expYear: 2027,
      };
      return json({ data: { card, cards: [card], hasCard: true } });
    }
    if (url.includes("/api/provider/billing-preferences")) {
      return json({
        data: {
          capabilities: { autoPayScheduling: true },
          subscription: { enabled: false, chargeDay: 10 },
          labs: [
            {
              providerOrganizationId: PRACTICE_ID,
              labOrganizationId: LAB_ID,
              labName: "Bright Dental Lab",
              providerName: "North Dental",
              enabled: false,
              chargeDay: null,
            },
          ],
        },
      });
    }
    if (url.includes("/balance")) {
      return json({ data: { currentBalance: 0 } });
    }
    if (url.includes("/api/provider/autopay-authorization/prepare")) {
      return json({
        data: {
          agreementVersion: "2026-02",
          agreementSha256: "sha-2026-02",
          agreementText: "LabTrax may charge the card on file for the amounts authorized below.",
          card: { brand: "VISA", last4: "4242" },
          labs: [{ labOrganizationId: LAB_ID, labName: "Bright Dental Lab" }],
        },
      });
    }
    if (url.includes("/api/provider/autopay-authorization/current")) {
      if (!authorization) return json({ error: "Not found" }, 404);
      return json({ data: authorization });
    }
    if (url.includes("/api/provider/autopay-authorization")) {
      const signed = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
      authorization = {
        ...signed,
        id: "auth-signed",
        status: "active",
        card: { brand: "VISA", last4: "4242" },
      };
      return json({ data: authorization }, 201);
    }
    return json({ ok: true, data: [] });
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    fireEvent.press(element);
  });
  await flush();
}

async function type(element: Parameters<typeof fireEvent.changeText>[0], text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(element, text);
  });
}

async function renderBillingScreen() {
  const view = await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProviderBillingScreen />
    </QueryClientProvider>,
  );
  // The agreement text only arrives once the prepared agreement is read, so
  // wait for it rather than guessing at tick counts.
  await waitFor(() =>
    expect(
      view.getByText("LabTrax may charge the card on file for the amounts authorized below."),
    ).toBeTruthy(),
  );
  await flush();
  return view;
}

beforeEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
  sent = [];
  authorization = null;
  installHandler();
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("provider billing screen — signing the auto-pay authorization", () => {
  it("signs subscription fees and lab bills for the selected lab", async () => {
    const view = await renderBillingScreen();

    await press(view.getByTestId("provider-authorization-subscription-fees"));
    await press(view.getByTestId("provider-authorization-lab-bills"));
    await type(view.getByTestId("provider-authorization-charge-day"), "5");
    await type(view.getByTestId("provider-authorization-legal-name"), "Ada Nguyen");
    await press(view.getByTestId("provider-authorization-consent"));
    await press(view.getByTestId("submit-provider-authorization"));

    const signed = posts("/api/provider/autopay-authorization");
    expect(signed).toHaveLength(1);
    expect(JSON.parse(signed[0].body as string)).toEqual({
      providerOrganizationId: PRACTICE_ID,
      agreementVersion: "2026-02",
      agreementSha256: "sha-2026-02",
      subscriptionFees: true,
      labBills: true,
      labOrganizationIds: [LAB_ID],
      labChargeDay: 5,
      typedLegalName: "Ada Nguyen",
      consent: true,
      signatureData: "data:image/png;base64,SIGNATURE",
    });

    // The card re-reads its own authorization, so the screen says one is in
    // place, and the form is clear rather than ready to sign a duplicate.
    await waitFor(() => expect(view.getByTestId("provider-authorization-active")).toBeTruthy());
    expect(view.getByTestId("provider-authorization-legal-name").props.value).toBe("");
    // A second tap cannot double-sign: the cleared form has nothing to submit.
    await press(view.getByTestId("submit-provider-authorization"));
    expect(posts("/api/provider/autopay-authorization")).toHaveLength(1);
  });

  it("will not sign without a legal name, consent, and something to authorize", async () => {
    const view = await renderBillingScreen();

    await press(view.getByTestId("submit-provider-authorization"));
    expect(posts("/api/provider/autopay-authorization")).toHaveLength(0);

    // Consent and a name are not enough on their own: nothing is authorized.
    await type(view.getByTestId("provider-authorization-legal-name"), "Ada Nguyen");
    await press(view.getByTestId("provider-authorization-consent"));
    await press(view.getByTestId("submit-provider-authorization"));
    expect(posts("/api/provider/autopay-authorization")).toHaveLength(0);

    await press(view.getByTestId("provider-authorization-subscription-fees"));
    await press(view.getByTestId("submit-provider-authorization"));
    expect(posts("/api/provider/autopay-authorization")).toHaveLength(1);
  });
});
