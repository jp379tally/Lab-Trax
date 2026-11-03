import { describe, it } from "vitest";
import * as assert from "node:assert/strict";
import { createRetryableResource } from "../retryable-resource";

describe("retryable PDF initialization", () => {
  it("shares in-flight initialization and caches success", async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const get = createRetryableResource(() => { calls++; return new Promise<string>((resolve) => { release = resolve; }); });
    const first = get();
    const second = get();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    release("ready");
    assert.equal(await first, "ready");
    assert.equal(await get(), "ready");
    assert.equal(calls, 1);
  });
  it("recovers after a transient rejection instead of permanently caching failure", async () => {
    let calls = 0;
    const get = createRetryableResource(async () => {
      if (++calls === 1) throw new Error("synthetic worker unavailable");
      return "ready";
    });
    const first = get();
    assert.equal(get(), first);
    await assert.rejects(first, /worker unavailable/);
    const retry = get();
    assert.notEqual(retry, first);
    assert.equal(get(), retry);
    assert.equal(await retry, "ready");
    assert.equal(calls, 2);
  });
  it("also recovers when initialization throws synchronously", async () => {
    let calls = 0;
    const get = createRetryableResource(() => {
      if (++calls === 1) throw new Error("synthetic synchronous failure");
      return Promise.resolve("ready");
    });
    await assert.rejects(get(), /synchronous failure/);
    assert.equal(await get(), "ready");
    assert.equal(calls, 2);
  });
});
