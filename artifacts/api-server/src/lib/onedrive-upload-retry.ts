import { setTimeout as pause } from "node:timers/promises";

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/** Replay the same session operation/range, never its signed URL in an error. */
export async function retryOneDriveUploadResponse<T extends {
  status: number; headers?: { get(name: string): string | null }; text(): Promise<string>;
}>(
  request: () => Promise<T>,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown> =
    (ms, abort) => pause(ms, undefined, { signal: abort }),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await request();
    if (!TRANSIENT.has(response.status) || attempt === 3) return response;
    const retryAfter = response.headers?.get("retry-after");
    let serverDelay = 0;
    if (retryAfter) {
      serverDelay = /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      if (!Number.isFinite(serverDelay)) serverDelay = 0;
    }
    // Do not disregard an excessive server delay by retrying early.
    if (serverDelay > 120_000) return response;
    await response.text().catch(() => ""); // release the response before replay
    await wait(Math.max(250 * 2 ** attempt, serverDelay), signal);
  }
}
