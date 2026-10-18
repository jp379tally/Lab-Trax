/**
 * Regression coverage for self-contained inline lab logos.
 *
 * The SMTP and DNS layers are mocked so this exercises the real guarded
 * sendMail wrapper and invite template without dispatching mail.
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

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async () => [{ exchange: "mx.gmail.com", priority: 10 }],
    resolve: async () => ["192.0.2.1"],
  },
}));

describe("inline lab-logo email attachments", () => {
  let mail: typeof import("./mail.js");

  beforeEach(async () => {
    vi.stubEnv("VITEST", "");
    sendMailImpl.mockReset();
    sendMailImpl.mockResolvedValue({ accepted: ["recipient@gmail.com"] });
    mail = await import("./mail.js");
    mail.__clearMxCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the invite logo as a CID and sends matching inline bytes", async () => {
    const logo = Buffer.from("invite-logo-bytes");

    const result = await mail.sendInviteEmail({
      to: "recipient@gmail.com",
      organizationName: "Crystal Labs",
      roleToAssign: "user",
      token: "invite-token",
      labLogo: { content: logo, contentType: "image/jpeg" },
    });

    expect(result).toEqual({ sent: true });
    expect(sendMailImpl).toHaveBeenCalledOnce();
    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.html).toContain('src="cid:lab-logo@labtrax"');
    expect(message.html).not.toContain("/api/organizations/");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        filename: "lab-logo",
        contentType: "image/jpeg",
        cid: "lab-logo@labtrax",
        contentDisposition: "inline",
      }),
    ]);
    expect(message.attachments[0].content.equals(logo)).toBe(true);
  });

  it("omits the invite logo when the placement or asset is unavailable", async () => {
    const result = await mail.sendInviteEmail({
      to: "recipient@gmail.com",
      organizationName: "Crystal Labs",
      roleToAssign: "user",
      token: "invite-token",
      labLogo: null,
    });

    expect(result).toEqual({ sent: true });
    const message = sendMailImpl.mock.calls[0]![0];
    expect(message.html).not.toContain("cid:lab-logo@labtrax");
    expect(message.attachments).toBeUndefined();
  });

  it("keeps the test guard ahead of DNS and transport even with attachments", async () => {
    vi.stubEnv("VITEST", "1");

    const result = await mail.sendMail({
      to: "recipient@gmail.com",
      subject: "Guard test",
      html: '<img src="cid:lab-logo@labtrax" />',
      attachments: [
        {
          filename: "lab-logo",
          content: Buffer.from("logo"),
          contentType: "image/png",
          cid: "lab-logo@labtrax",
        },
      ],
    });

    expect(result).toEqual({ sent: false, reason: "disabled_in_test" });
    expect(sendMailImpl).not.toHaveBeenCalled();
  });

  it("passes CC, reply-to, and inline MIME attachments through the guarded wrapper", async () => {
    const attachment = {
      filename: "lab-logo",
      content: Buffer.from("logo"),
      contentType: "image/png",
      cid: "lab-logo@labtrax",
    };

    await mail.sendMail({
      to: "recipient@gmail.com",
      cc: ["billing@gmail.com"],
      replyTo: "replies@gmail.com",
      subject: "Forwarding test",
      html: '<img src="cid:lab-logo@labtrax" />',
      attachments: [attachment],
    });

    expect(sendMailImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@gmail.com",
        cc: ["billing@gmail.com"],
        replyTo: "replies@gmail.com",
        attachments: [attachment],
      }),
    );
  });
});