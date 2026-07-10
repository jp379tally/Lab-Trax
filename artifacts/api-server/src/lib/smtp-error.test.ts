import { describe, expect, it } from "vitest";
import { classifySmtpError } from "./smtp-error";

describe("classifySmtpError", () => {
  it("maps EAUTH / 535 to the auth category", () => {
    const byCode = classifySmtpError({ code: "EAUTH", responseCode: 535 });
    expect(byCode.category).toBe("auth");
    expect(byCode.responseCode).toBe(535);
    expect(byCode.message).toMatch(/rejected the login/i);

    const byResponseOnly = classifySmtpError({ responseCode: 535 });
    expect(byResponseOnly.category).toBe("auth");
  });

  it("maps connection/TLS error codes to the connection category", () => {
    for (const code of [
      "ECONNECTION",
      "ESOCKET",
      "ETIMEDOUT",
      "ECONNREFUSED",
    ]) {
      const c = classifySmtpError({ code });
      expect(c.category, code).toBe("connection");
      expect(c.message).toMatch(/connect to the email server/i);
    }
  });

  it("maps EENVELOPE / generic 5xx to the recipient category", () => {
    const byEnvelope = classifySmtpError({ code: "EENVELOPE", responseCode: 550 });
    expect(byEnvelope.category).toBe("recipient");
    expect(byEnvelope.responseCode).toBe(550);
    expect(byEnvelope.message).toMatch(/rejected the recipient/i);

    const by5xx = classifySmtpError({ responseCode: 550 });
    expect(by5xx.category).toBe("recipient");
  });

  it("falls back to unknown for unrecognized errors", () => {
    const c = classifySmtpError(new Error("something odd"));
    expect(c.category).toBe("unknown");
    expect(c.responseCode).toBeNull();
    expect(c.code).toBeNull();
    expect(c.message).toMatch(/failed to send the email/i);
  });

  it("never echoes the raw provider message", () => {
    const c = classifySmtpError({
      code: "EAUTH",
      responseCode: 535,
      message: "535 5.7.8 Username: super-secret-user Password: hunter2",
      response: "535 leaked-credentials",
    });
    expect(c.message).not.toMatch(/hunter2/);
    expect(c.message).not.toMatch(/super-secret-user/);
    expect(c.message).not.toMatch(/leaked-credentials/);
  });

  it("tolerates null/undefined and non-object inputs", () => {
    expect(classifySmtpError(null).category).toBe("unknown");
    expect(classifySmtpError(undefined).category).toBe("unknown");
    expect(classifySmtpError("boom").category).toBe("unknown");
  });
});
