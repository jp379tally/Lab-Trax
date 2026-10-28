import { describe, expect, it, vi } from "vitest";
import { retryOneDriveUploadResponse } from "./onedrive-upload-retry";

describe("OneDrive upload HTTP retries", () => {
  it.each([429, 500, 502, 503, 504])("retries transient HTTP %s with the same operation", async status => {
    const request = vi.fn().mockResolvedValueOnce(new Response("", { status }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    const wait = vi.fn().mockResolvedValue(undefined);
    expect((await retryOneDriveUploadResponse(request, undefined, wait)).status).toBe(201);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250, undefined);
  });
  it.each([400, 401, 403])("does not retry permanent HTTP %s", async status => {
    const request = vi.fn().mockResolvedValue(new Response("", { status }));
    expect((await retryOneDriveUploadResponse(request)).status).toBe(status);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("respects Retry-After and bounds persistent failures", async () => {
    const request = vi.fn().mockImplementation(async () => new Response("", {
      status: 502, headers: { "Retry-After": "3" },
    }));
    const wait = vi.fn().mockResolvedValue(undefined);
    expect((await retryOneDriveUploadResponse(request, undefined, wait)).status).toBe(502);
    expect(request).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[3000, undefined], [3000, undefined], [3000, undefined]]);
  });
  it("honours cancellation before replay", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
    await expect(retryOneDriveUploadResponse(request, controller.signal, async () => {
      controller.abort();
    })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
