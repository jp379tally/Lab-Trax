/**
 * Unit tests for SMTP credential normalization (lib/mailer.ts).
 *
 * Hardening: a Google app password pasted with its display spaces
 * ("xxxx xxxx xxxx xxxx") used to be stored and sent verbatim, guaranteeing a
 * 535 BadCredentials rejection. The mailer config now strips ALL whitespace
 * from the password — and ONLY the password. Host, username, and from-address
 * are trimmed of surrounding whitespace but their internal whitespace is
 * preserved (it could be meaningful, e.g. a display-name from).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMailerConfig,
  normalizeSmtpPassword,
  normalizeSmtpValue,
} from "./mailer";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubSmtpEnv(overrides: Record<string, string> = {}) {
  vi.stubEnv("SMTP_HOST", overrides.SMTP_HOST ?? "smtp.gmail.com");
  vi.stubEnv("SMTP_USER", overrides.SMTP_USER ?? "lab@example-lab.com");
  vi.stubEnv("SMTP_PASS", overrides.SMTP_PASS ?? "secretpass");
  vi.stubEnv("SMTP_PORT", overrides.SMTP_PORT ?? "587");
  if (overrides.SMTP_FROM !== undefined) {
    vi.stubEnv("SMTP_FROM", overrides.SMTP_FROM);
  } else {
    vi.stubEnv("SMTP_FROM", "");
  }
}

describe("normalizeSmtpPassword", () => {
  it("strips a Google app password's display spaces", () => {
    expect(normalizeSmtpPassword("abcd efgh ijkl mnop")).toBe(
      "abcdefghijklmnop"
    );
  });

  it("strips all whitespace kinds (tabs, newlines, surrounding)", () => {
    expect(normalizeSmtpPassword("  ab\tcd\nef gh  ")).toBe("abcdefgh");
  });

  it("leaves a clean password untouched", () => {
    expect(normalizeSmtpPassword("abcdefghijklmnop")).toBe("abcdefghijklmnop");
  });
});

describe("normalizeSmtpValue", () => {
  it("trims surrounding whitespace only", () => {
    expect(normalizeSmtpValue("  smtp.gmail.com  ")).toBe("smtp.gmail.com");
  });

  it("preserves internal whitespace", () => {
    expect(normalizeSmtpValue("  My Lab <lab@example.com>  ")).toBe(
      "My Lab <lab@example.com>"
    );
  });
});

describe("getMailerConfig normalization", () => {
  it("authenticates a Google app password saved with spaces", () => {
    stubSmtpEnv({ SMTP_PASS: "abcd efgh ijkl mnop" });
    const cfg = getMailerConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.pass).toBe("abcdefghijklmnop");
  });

  it("trims host/user/from but never strips their internal whitespace", () => {
    stubSmtpEnv({
      SMTP_HOST: "  smtp.gmail.com  ",
      SMTP_USER: "  lab@example-lab.com  ",
      SMTP_FROM: "  My Lab <lab@example-lab.com>  ",
    });
    const cfg = getMailerConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.host).toBe("smtp.gmail.com");
    expect(cfg!.user).toBe("lab@example-lab.com");
    expect(cfg!.from).toBe("My Lab <lab@example-lab.com>");
  });

  it("treats a whitespace-only password as not configured", () => {
    stubSmtpEnv({ SMTP_PASS: "   " });
    expect(getMailerConfig()).toBeNull();
  });

  it("falls back from to the (trimmed) user when SMTP_FROM is unset", () => {
    stubSmtpEnv({ SMTP_USER: " lab@example-lab.com " });
    const cfg = getMailerConfig();
    expect(cfg!.from).toBe("lab@example-lab.com");
  });

  it("parses a trimmed port and derives secure for 465", () => {
    stubSmtpEnv({ SMTP_PORT: "465" });
    const cfg = getMailerConfig();
    expect(cfg!.port).toBe(465);
    expect(cfg!.secure).toBe(true);
  });
});
