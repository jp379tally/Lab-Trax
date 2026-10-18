/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { SelectedCasePrintActions } from "../SelectedCasePrintActions";
import { prepareSelectedInvoices, prepareSelectedLabSlips } from "@/lib/selected-case-documents";
import { printBatchInWindow, reserveBatchPrintWindow } from "@/lib/batch-print-window";

vi.mock("@/lib/selected-case-documents", () => ({ prepareSelectedInvoices: vi.fn(), prepareSelectedLabSlips: vi.fn() }));
vi.mock("@/lib/batch-print-window", () => ({ printBatchInWindow: vi.fn(), reserveBatchPrintWindow: vi.fn() }));
vi.mock("@/lib/export", () => ({ buildInvoicesPdf: vi.fn(() => new Blob(["pdf"])) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reserveBatchPrintWindow).mockReturnValue({ close } as unknown as Window);
  vi.mocked(prepareSelectedInvoices).mockResolvedValue({ options: [{} as never], missing: [] });
  vi.mocked(prepareSelectedLabSlips).mockResolvedValue([{ title: "Slip", body: "One" }]);
  vi.mocked(printBatchInWindow).mockResolvedValue();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("selected case print actions", () => {
  it("captures selection, blocks concurrent jobs, and preserves the caller's selection during preparation", async () => {
    const selection = new Set(["a", "b"]);
    let release!: (value: { options: never[]; missing: string[] }) => void;
    vi.mocked(prepareSelectedInvoices).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const view = render(<SelectedCasePrintActions selectedIds={selection} isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Print Invoices" }));
    fireEvent.click(screen.getByRole("button", { name: "Print Lab Slips" }));
    expect(screen.getByRole("status")).toHaveTextContent("Preparing");
    expect(screen.getByRole("button", { name: "Print Lab Slips" })).toBeDisabled();
    selection.add("c");
    view.rerender(<SelectedCasePrintActions selectedIds={selection} isAdmin />);
    release({ options: [{} as never], missing: [] });
    await waitFor(() => expect(printBatchInWindow).toHaveBeenCalledTimes(1));
    expect(prepareSelectedInvoices).toHaveBeenCalledWith(["a", "b"], expect.any(Function));
    expect(prepareSelectedLabSlips).not.toHaveBeenCalled();
    expect([...selection]).toEqual(["a", "b", "c"]);
  });

  it.each([true, false])("reports missing count and numbers before printing remaining (confirm=%s)", async (confirm) => {
    vi.mocked(prepareSelectedInvoices).mockResolvedValue({ options: [{} as never], missing: ["26-2", "26-3"] });
    vi.mocked(window.confirm).mockReturnValue(confirm);
    render(<SelectedCasePrintActions selectedIds={new Set(["1", "2", "3"])} isAdmin={false} />);
    fireEvent.click(screen.getByText("Print Invoices"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/2 selected cases.*26-2, 26-3/)));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(printBatchInWindow).toHaveBeenCalledTimes(confirm ? 1 : 0);
    if (!confirm) expect(close).toHaveBeenCalled();
  });

  it("does not open an empty print job when all invoices are missing", async () => {
    vi.mocked(prepareSelectedInvoices).mockResolvedValue({ options: [], missing: ["26-1"] });
    render(<SelectedCasePrintActions selectedIds={new Set(["1"])} isAdmin />);
    fireEvent.click(screen.getByText("Print Invoices"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("No invoices exist")));
    expect(printBatchInWindow).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("prints one selected lab slip and leaves selection alone", async () => {
    const selection = new Set(["one"]);
    render(<SelectedCasePrintActions selectedIds={selection} isAdmin={false} />);
    fireEvent.click(screen.getByText("Print Lab Slips"));
    await waitFor(() => expect(printBatchInWindow).toHaveBeenCalledTimes(1));
    expect(prepareSelectedLabSlips).toHaveBeenCalledWith(["one"], false, expect.any(Function));
    expect([...selection]).toEqual(["one"]);
  });

  it.each(["load", "popup"])("shows actionable feedback on %s failure and prints nothing", async (failure) => {
    if (failure === "load") vi.mocked(prepareSelectedLabSlips).mockRejectedValue(new Error("Denied access. Check permissions and retry."));
    else vi.mocked(reserveBatchPrintWindow).mockImplementation(() => { throw new Error("Print window blocked. Allow pop-ups and retry."); });
    render(<SelectedCasePrintActions selectedIds={new Set(["one"])} isAdmin />);
    fireEvent.click(screen.getByText("Print Lab Slips"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/retry/)));
    expect(printBatchInWindow).not.toHaveBeenCalled();
    expect(screen.getByText("Print Lab Slips")).not.toBeDisabled();
  });
});
