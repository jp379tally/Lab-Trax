/**
 * Unit tests for sendMail()'s SMTP failure classification.
 *
 * Hardening: an authentication rejection (Gmail 535 / nodemailer EAUTH) used
 * to collapse into the same generic outcome as any other transport failure —
 * and the raw provider message was returned as the `reason`. Now the catch
 * path classifies the error via classifySmtpError():
 *   - auth category  → { sent: false, reason: "auth_failed" }
 *   - anything else  → { sent: false, reason: "send_failed" }
 * and the raw provider text (which can echo credentials) never appears in
 * the returned reason.
 *
 * sendMail short-circuits under the test runner (VITEST guard), so these
 * tests stub VITEST to an empty string and mock the transport + DNS layers —
 * no real network traffic is possible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailImpl = vi.fn();

vi.mock("./mailer", () => ({
  getMailerConfig: () => ({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "lab@example-lab.com",
    pass: "abcdefghijklmnop",
    from: "lab@example-lab.com",
  }),
  createTransport: () => ({ sendMail: sendMailImpl }),
}));

// DNS preflight: report the recipient domain as deliverable so the send
// proceeds to the (mocked) transport.
vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
    resolve: async () => ["192.0.2.1"],
  },
}));

describe("sendMail SMTP failure classification", () => {
  let mail: typeof import("./mail");

  beforeEach(async () => {
    vi.stubEnv("VITEST", "");
    sendMailImpl.mockReset();
    mail = await import("./mail");
    mail.__clearMxCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const opts = {
    to: "someone@labtrax-test.com",
    subject: "Test",
    html: "<p>hi</p>",
  };

  it("maps a Gmail 535 EAUTH rejection to auth_failed without leaking raw text", async () => {
    const err = Object.assign(
      new Error(
        "Invalid login: 535-5.7.8 Username and Password not accepted. BadCredentials"
      ),
      { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }
    );
    sendMailImpl.mockRejectedValue(err);

    const result = await mail.sendMail(opts);
    expect(result).toEqual({ sent: false, reason: "auth_failed" });
    expect(JSON.stringify(result)).not.toContain("BadCredentials");
    expect(JSON.stringify(result)).not.toContain("535");
  });

  it("maps a 535 response code without an EAUTH code to auth_failed", async () => {
    sendMailImpl.mockRejectedValue(
      Object.assign(new Error("535 BadCredentials"), { responseCode: 535 })
    );
    const result = await mail.sendMail(opts);
    expect(result).toEqual({ sent: false, reason: "auth_failed" });
  });

  it("maps a non-auth transport failure to the generic send_failed", async () => {
    sendMailImpl.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { code: "ECONNECTION" })
    );
    const result = await mail.sendMail(opts);
    expect(result).toEqual({ sent: false, reason: "send_failed" });
    expect(JSON.stringify(result)).not.toContain("socket hang up");
  });

  it("maps an unknown thrown error to send_failed, never the raw message", async () => {
    sendMailImpl.mockRejectedValue(
      new Error("451 provider-internal-detail with-secrets")
    );
    const result = await mail.sendMail(opts);
    expect(result).toEqual({ sent: false, reason: "send_failed" });
    expect(JSON.stringify(result)).not.toContain("provider-internal-detail");
  });

  it("still succeeds normally when the transport accepts the message", async () => {
    sendMailImpl.mockResolvedValue({ accepted: [opts.to] });
    const result = await mail.sendMail(opts);
    expect(result).toEqual({ sent: true });
  });
});
