/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LabAutoPayAuthorization, ProviderAutoPayAuthorization } from "../AutoPayAuthorization";

const apiFetch = vi.fn();
const apiFetchArrayBuffer = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiFetchArrayBuffer: (...args: unknown[]) => apiFetchArrayBuffer(...args),
  getProviderOrganizationId: () => "provider-1",
}));

function setup() {
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/provider/lab-autopay-authorization/history") ||
        path.startsWith("/provider/autopay-authorization/requests?")) return Promise.resolve([]);
    return Promise.resolve({ ok: true });
  });
  return render(<LabAutoPayAuthorization labOrganizationId="lab-1" providerOrganizationId="provider-1" />);
}

describe("LabAutoPayAuthorization delivery controls", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects blank and invalid email without making a request", async () => {
    setup();
    const send = await screen.findByRole("button", { name: /prepare \/ send/i });
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid recipient email/i);
    expect(apiFetch.mock.calls.some(([path]) => path === "/provider/autopay-authorization/requests")).toBe(false);
    fireEvent.change(screen.getByPlaceholderText("provider@example.com"), { target: { value: "not-an-email" } });
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid recipient email/i);
    expect(apiFetch.mock.calls.some(([path]) => path === "/provider/autopay-authorization/requests")).toBe(false);
  });

  it("shows a rejected request error without success or handoff copy", async () => {
    setup();
    fireEvent.change(await screen.findByPlaceholderText("provider@example.com"), { target: { value: "provider@example.com" } });
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/provider/lab-autopay-authorization/history") || path.startsWith("/provider/autopay-authorization/requests?")) return Promise.resolve([]);
      if (path === "/provider/autopay-authorization/requests") return Promise.reject(new Error("Mail service unavailable"));
      return Promise.resolve({ ok: true });
    });
    fireEvent.click(screen.getByRole("button", { name: /prepare \/ send/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mail service unavailable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /handoff/i })).not.toBeInTheDocument();
  });

  it("uses in-person delivery and renders the exact authenticated handoff URL", async () => {
    setup();
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/provider/lab-autopay-authorization/history") || path.startsWith("/provider/autopay-authorization/requests?")) return Promise.resolve([]);
      if (path === "/provider/autopay-authorization/requests") return Promise.resolve({ id: "request-7", requestToken: "token-abc" });
      return Promise.resolve({ ok: true });
    });
    fireEvent.click(await screen.findByRole("button", { name: /present to provider/i }));
    const link = await screen.findByRole("link", { name: /open provider signing handoff/i });
    expect(link).toHaveAttribute("href", "/desktop/?providerAutopayRequest=request-7&providerAutopayToken=token-abc");
    const [, options] = apiFetch.mock.calls.find(([path]) => path === "/provider/autopay-authorization/requests")!;
    expect(JSON.parse(options.body)).toEqual(expect.objectContaining({ deliveryMode: "in_person", presentInPerson: true }));
    expect(JSON.parse(options.body)).not.toHaveProperty("recipientEmail");
  });

  it("does not expose a lab signature canvas or signature submit control", async () => {
    setup();
    await screen.findByRole("button", { name: /present to provider/i });
    expect(screen.queryByLabelText(/draw your signature/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit authorization/i })).not.toBeInTheDocument();
  });

  it("passes the selected provider header when downloading provider authorization PDFs", async () => {
    // The binary wrapper is intentionally exercised through the shared API
    // surface; provider selection must not depend on whichever practice is
    // currently selected elsewhere in the portal.
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/provider/autopay-authorization/prepare")) return Promise.resolve({ agreementVersion: "v1", agreementSha256: "hash", agreementText: "Agreement", labs: [], card: null, labChargeDay: { minimum: 1, maximum: 10 } });
      if (path.startsWith("/provider/autopay-authorization/history")) return Promise.resolve([{ id: "auth-1", status: "active", providerOrganizationId: "provider-9" }]);
      return Promise.resolve({ ok: true });
    });
    apiFetchArrayBuffer.mockResolvedValue({ buffer: new ArrayBuffer(0), headers: new Headers() });
    render(<ProviderAutoPayAuthorization providerOrganizationId="provider-9" />);
    fireEvent.click(await screen.findByRole("button", { name: /download pdf/i }));
    expect(apiFetchArrayBuffer).toHaveBeenCalledWith(
      "/provider/autopay-authorization/auth-1/download",
      { headers: { "x-provider-organization-id": "provider-9" } },
    );
  });

  it("keeps subscription-only emailed requests free of lab terms in final review", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.includes("/autopay-authorization/requests/request-subscription")) {
        return Promise.resolve({
          providerOrganizationId: "provider-1", agreementVersion: "v1",
          agreementSha256: "hash", agreementText: "Agreement",
          subscriptionFees: true, labBills: false, labOrganizationIds: [],
          labChargeDay: null, labs: [], card: null,
        });
      }
      if (path.startsWith("/provider/autopay-authorization/history")) return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,sig");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    render(<ProviderAutoPayAuthorization providerOrganizationId="provider-1" requestId="request-subscription" requestToken="token" />);
    await screen.findByText(/fixed terms/i);
    fireEvent.change(screen.getByLabelText(/typed legal name/i), { target: { value: "Jane Doe" } });
    fireEvent.pointerDown(screen.getByLabelText(/draw your signature/i), { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(screen.getByLabelText(/draw your signature/i));
    fireEvent.click(screen.getByRole("checkbox", { name: /read and agree/i }));
    fireEvent.click(screen.getByRole("button", { name: /review agreement/i }));
    expect(await screen.findByText(/agreement review/i)).toBeInTheDocument();
    expect(screen.getAllByText(/subscription fees/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/covered labs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/lab bills charge on day/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payments are due by the 10th/i)).not.toBeInTheDocument();
  });
});