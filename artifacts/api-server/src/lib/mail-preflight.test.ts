/**
 * Unit tests for the mail DNS preflight (resolveDomainDeliverability) and
 * reserved-domain guard.
 *
 * Key regression: a DNS *lookup error* (timeout, SERVFAIL, EAI_AGAIN,
 * sandboxed runtime) must NOT be treated as "domain undeliverable" — SMTP is
 * the authority in that case. Only a definitive "no such records" answer may
 * skip the send, and inconclusive results must never be cached as negatives.
 *
 * sendMail itself stays disabled under VITEST (bounce-flood guard) — that
 * behaviour is asserted here too, so these tests exercise the exported
 * preflight helpers directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: vi.fn(),
    resolve: vi.fn(),
  },
}));

import { promises as dns } from "node:dns";
import {
  __clearMxCacheForTests,
  isReservedEmailDomain,
  resolveDomainDeliverability,
  sendMail,
} from "./mail.js";

const resolveMx = vi.mocked(dns.resolveMx);
const resolveA = vi.mocked(dns.resolve);

function dnsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearMxCacheForTests();
});

describe("isReservedEmailDomain", () => {
  it("flags reserved/test domains", () => {
    expect(isReservedEmailDomain("someone@test.local")).toBe(true);
    expect(isReservedEmailDomain("someone@example.com")).toBe(true);
    expect(isReservedEmailDomain("someone@foo.invalid")).toBe(true);
  });

  it("allows normal domains", () => {
    expect(isReservedEmailDomain("someone@gmail.com")).toBe(false);
    expect(isReservedEmailDomain("someone@dental-lab.co")).toBe(false);
  });

  it("treats malformed addresses as reserved", () => {
    expect(isReservedEmailDomain("not-an-email")).toBe(true);
  });
});

describe("resolveDomainDeliverability", () => {
  it("returns deliverable when MX records exist", async () => {
    resolveMx.mockResolvedValueOnce([{ exchange: "mx.a.com", priority: 10 }]);
    await expect(
      resolveDomainDeliverability("user@has-mx.com")
    ).resolves.toBe("deliverable");
  });

  it("falls back to A records when the MX lookup throws", async () => {
    resolveMx.mockRejectedValueOnce(dnsError("ENODATA"));
    resolveA.mockResolvedValueOnce(["203.0.113.1"]);
    await expect(
      resolveDomainDeliverability("user@a-only.com")
    ).resolves.toBe("deliverable");
  });

  it("returns undeliverable only when BOTH lookups definitively find nothing", async () => {
    resolveMx.mockRejectedValueOnce(dnsError("ENOTFOUND"));
    resolveA.mockRejectedValueOnce(dnsError("ENOTFOUND"));
    await expect(
      resolveDomainDeliverability("user@no-such-domain.com")
    ).resolves.toBe("undeliverable");
  });

  it("returns unknown when the lookup itself errors (timeout/SERVFAIL)", async () => {
    resolveMx.mockRejectedValueOnce(dnsError("ETIMEOUT"));
    resolveA.mockRejectedValueOnce(dnsError("ETIMEOUT"));
    await expect(
      resolveDomainDeliverability("user@dns-flaky.com")
    ).resolves.toBe("unknown");
  });

  it("returns unknown when only one lookup is definitive and the other errored", async () => {
    resolveMx.mockRejectedValueOnce(dnsError("ENOTFOUND"));
    resolveA.mockRejectedValueOnce(dnsError("EAI_AGAIN"));
    await expect(
      resolveDomainDeliverability("user@half-answered.com")
    ).resolves.toBe("unknown");
  });

  it("does NOT cache an unknown result — a later successful lookup wins", async () => {
    resolveMx.mockRejectedValueOnce(dnsError("ETIMEOUT"));
    resolveA.mockRejectedValueOnce(dnsError("ETIMEOUT"));
    await expect(
      resolveDomainDeliverability("user@recovers.com")
    ).resolves.toBe("unknown");

    // DNS recovers — the next call must re-query and see the MX records.
    resolveMx.mockResolvedValueOnce([{ exchange: "mx.r.com", priority: 5 }]);
    await expect(
      resolveDomainDeliverability("user@recovers.com")
    ).resolves.toBe("deliverable");
    expect(resolveMx).toHaveBeenCalledTimes(2);
  });

  it("caches definitive results (no repeat lookup within TTL)", async () => {
    resolveMx.mockResolvedValueOnce([{ exchange: "mx.c.com", priority: 10 }]);
    await resolveDomainDeliverability("user@cached.com");
    await resolveDomainDeliverability("other@cached.com");
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed address as undeliverable without a lookup", async () => {
    await expect(resolveDomainDeliverability("nope")).resolves.toBe(
      "undeliverable"
    );
    expect(resolveMx).not.toHaveBeenCalled();
  });
});

describe("sendMail VITEST guard", () => {
  it("stays disabled under vitest (bounce-flood guard intact)", async () => {
    const result = await sendMail({
      to: "someone@real-domain.com",
      subject: "test",
      text: "test",
      html: "<p>test</p>",
    });
    expect(result).toEqual({ sent: false, reason: "disabled_in_test" });
    // Guard short-circuits before any DNS preflight.
    expect(resolveMx).not.toHaveBeenCalled();
  });
});
