// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderSupportAssistant } from "../ProviderSupportAssistant";
import { apiFetch } from "@/lib/api";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);
describe("provider support assistant", () => {
  it("uses the selected practice and renders AI text without executing HTML", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: '<img src=x onerror="alert(1)"> Case 123 is received.' });
    const view = render(<ProviderSupportAssistant providerOrganizationId="practice-a" />);
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "case 123?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask LabTrax" }));
    await waitFor(() => expect(screen.getByText(/Case 123 is received/)).toBeDefined());
    expect(view.container.querySelector("img")).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith("/support-assistant/account", expect.objectContaining({
      method: "POST", body: JSON.stringify({ message: "case 123?" }),
      headers: { "x-provider-organization-id": "practice-a" },
    }));
  });
  it("shows access-denied errors without inventing a case answer", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("Practice not assigned."));
    render(<ProviderSupportAssistant providerOrganizationId="practice-b" />);
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "case 123?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask LabTrax" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Practice not assigned."));
  });
  it("aborts an in-flight question when the selected-practice panel is removed", async () => {
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<ProviderSupportAssistant providerOrganizationId="practice-a" />);
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "case 123?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask LabTrax" }));
    const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
    view.unmount(); expect(signal?.aborted).toBe(true);
  });
});
