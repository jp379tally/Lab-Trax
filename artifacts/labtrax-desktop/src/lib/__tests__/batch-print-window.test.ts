/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchLabSlipHtml, printBatchInWindow, reserveBatchPrintWindow } from "../batch-print-window";

function printWindow() {
  const doc = document.implementation.createHTMLDocument("Print");
  const events = new EventTarget();
  const win = {
    document: doc, closed: false, focus: vi.fn(), print: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    close: vi.fn(() => { win.closed = true; }),
  };
  return { win: win as unknown as Window, events, print: win.print, close: win.close };
}
afterEach(() => vi.restoreAllMocks());

describe("batch print window lifecycle and boundaries", () => {
  it("reports popup restrictions before any document preparation", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(() => reserveBatchPrintWindow()).toThrow(/Allow pop-ups/);
  });
  it("uses document boundaries instead of trailing separator pages", () => {
    const html = batchLabSlipHtml([{ title: "a", body: "A" }, { title: "b", body: "B" }]);
    expect(html.match(/<section /g)).toHaveLength(2);
    expect(html).toContain(".lt-batch-document + .lt-batch-document { break-before: page; }");
    expect(html).not.toContain("break-after: page");
    expect(html).not.toContain('overflow: hidden');
    expect(() => batchLabSlipHtml([])).toThrow();
  });
  it("prints only once and keeps the job active until afterprint cancellation/close", async () => {
    const { win, events, print, close } = printWindow();
    let done = false;
    const job = printBatchInWindow(win, [{ title: "a", body: "A" }, { title: "b", body: "B" }]).then(() => { done = true; });
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(done).toBe(false);
    expect(win.document.querySelectorAll(".lt-batch-document")).toHaveLength(2);
    events.dispatchEvent(new Event("afterprint"));
    await job;
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("moves an overflowing custom block onto flowing continuation pages without changing its font", async () => {
    const { win, events, print } = printWindow();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) {
      return this.classList.contains("lt-adv-box") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    const job = printBatchInWindow(win, [{
      title: "custom", body: '<div class="lt-adv-page"><div class="lt-adv-box" style="font-size:17px;font-family:Georgia;height:40px;position:absolute"><div class="lt-el-cap">Notes</div><div>LONG NOTE COMPLETE</div></div></div>',
    }]);
    await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(win.document.querySelector(".lt-adv-page")?.textContent).toContain("see following pages");
    const continuation = win.document.querySelector<HTMLElement>(".lt-batch-continuation .lt-adv-box")!;
    expect(continuation.textContent).toContain("LONG NOTE COMPLETE");
    expect(continuation.style.fontSize).toBe("17px");
    expect(continuation.style.fontFamily).toBe("Georgia");
    expect(continuation.style.height).toBe("auto");
    events.dispatchEvent(new Event("afterprint"));
    await job;
  });
  it("fails visibly and closes temporary windows if print throws", async () => {
    const { win, print, close } = printWindow();
    print.mockImplementation(() => { throw new Error("Printer unavailable. Retry."); });
    await expect(printBatchInWindow(win, [{ title: "a", body: "A" }])).rejects.toThrow("Printer unavailable");
    expect(close).toHaveBeenCalledOnce();
  });
  it("cleans a PDF frame and its object URL after cancellation without duplicate revocations", async () => {
    const { win, close } = printWindow();
    const create = vi.fn(() => "blob:pdf-test");
    const revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    });
    try {
      const job = printBatchInWindow(win, new Blob(["pdf"]));
      const frame = win.document.querySelector("iframe")!;
      const frameWindow = { addEventListener: vi.fn(), focus: vi.fn(), print: vi.fn() };
      Object.defineProperty(frame, "contentWindow", { value: frameWindow });
      frame.dispatchEvent(new Event("load"));
      await vi.waitFor(() => expect(frameWindow.print).toHaveBeenCalledOnce());
      frameWindow.addEventListener.mock.calls[0][1]();
      await job;
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:pdf-test");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
