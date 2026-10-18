import { describe, expect, it, vi } from "vitest";
import { runPrescriptionAnalysis, validatePrescriptionPageCount } from "../prescription-analysis";
describe("prescription operation boundaries", () => {
  it("passes cancellation into preparation so cooperative workers stop and a later retry can run", async () => {
    const prepare = vi.fn((signal: AbortSignal) => new Promise<string[]>((resolve) => {
      signal.addEventListener("abort", () => resolve([]), { once: true });
    }));
    await expect(runPrescriptionAnalysis(prepare, vi.fn(), vi.fn(), 10)).rejects.toThrow(/too long/);
    expect(prepare.mock.calls[0][0].aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await expect(runPrescriptionAnalysis(async () => ["page"], async () => "ok", vi.fn())).resolves.toBe("ok");
  });
  it("rejects oversized documents explicitly instead of dropping pages", async () => {
    expect(() => validatePrescriptionPageCount(11)).toThrow(/at most 10/);
    const send = vi.fn();
    await expect(runPrescriptionAnalysis(async () => Array(11).fill("page"), send, vi.fn())).rejects.toThrow(/at most 10/);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains every page, reports stages and does not retry or modify originals", async () => {
    const images = ["one", "two", "three", "four"];
    const send = vi.fn().mockResolvedValue({ patientName: "fixture" });
    const report = vi.fn();
    await runPrescriptionAnalysis(async () => images, send, report);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(images);
    expect(report.mock.calls.map(([stage]) => stage)).toEqual(["preparation", "request"]);
    expect(images).toEqual(["one", "two", "three", "four"]);
  });
  it("bounds hung preparation, fences retry until it settles and never sends late", async () => {
    let release!: (value: string[]) => void;
    const prepare = new Promise<string[]>((r) => { release = r; });
    const send = vi.fn();
    await expect(runPrescriptionAnalysis(() => prepare, send, vi.fn(), 10)).rejects.toThrow(/too long/);
    await expect(runPrescriptionAnalysis(async () => [], send, vi.fn())).rejects.toThrow(/still stopping/);
    release(["page"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalled();
  });
  it("bounds hung network work and passes cancellation without duplicate sends", async () => {
    let release!: (value: number) => void;
    const send = vi.fn(() => new Promise<number>((r) => { release = r; }));
    await expect(runPrescriptionAnalysis(async () => ["page"], send, vi.fn(), 10)).rejects.toThrow(/too long/);
    expect(send.mock.calls[0][1].aborted).toBe(true);
    await expect(runPrescriptionAnalysis(async () => [], send, vi.fn())).rejects.toThrow(/still stopping/);
    release(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
