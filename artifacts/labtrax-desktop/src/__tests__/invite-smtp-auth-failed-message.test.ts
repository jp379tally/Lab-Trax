/**
 * Regression guard: SMTP auth failures (`auth_failed`) surface an actionable
 * message in the desktop invite UIs instead of the generic "failed to send".
 *
 * When the mail provider rejects the SMTP login (bad/rotated app password),
 * the server records the stable reason `auth_failed` on the invite row and in
 * `emailDelivery`. Both invite surfaces — team settings and practices — must
 * map that reason to a message that tells the admin the credentials need
 * updating, so the next credential problem is self-diagnosing.
 */
import { describe, expect, it } from "vitest";
import {
  inviteDeliveryProblem,
  SMTP_AUTH_FAILED_MESSAGE,
} from "@/pages/settings";
import {
  practiceInviteDeliveryProblem,
  SMTP_AUTH_FAILED_MESSAGE as PRACTICES_SMTP_AUTH_FAILED_MESSAGE,
} from "@/pages/practices";

describe("SMTP auth-failed invite messaging", () => {
  it("uses the same actionable message on both invite surfaces", () => {
    expect(SMTP_AUTH_FAILED_MESSAGE).toBe(PRACTICES_SMTP_AUTH_FAILED_MESSAGE);
    expect(SMTP_AUTH_FAILED_MESSAGE).toMatch(/rejected the login/i);
    expect(SMTP_AUTH_FAILED_MESSAGE).toMatch(/SMTP credentials/i);
  });

  it("team settings: maps auth_failed to the credentials message", () => {
    expect(
      inviteDeliveryProblem({
        lastEmailStatus: "failed",
        lastEmailError: "auth_failed",
      })
    ).toBe(SMTP_AUTH_FAILED_MESSAGE);
  });

  it("team settings: keeps the generic message for other failures", () => {
    expect(
      inviteDeliveryProblem({
        lastEmailStatus: "failed",
        lastEmailError: "send_failed",
      })
    ).toBe("Invite email failed to send");
    expect(
      inviteDeliveryProblem({
        lastEmailStatus: "failed",
        lastEmailError: "recipient_opted_out",
      })
    ).toBe("Recipient opted out of invite emails");
    expect(
      inviteDeliveryProblem({ lastEmailStatus: "sent", lastEmailError: null })
    ).toBeNull();
  });

  it("practices: maps auth_failed to the credentials message", () => {
    expect(
      practiceInviteDeliveryProblem({
        lastEmailStatus: "failed",
        lastEmailError: "auth_failed",
      })
    ).toBe(SMTP_AUTH_FAILED_MESSAGE);
  });

  it("practices: keeps the generic message for other failures", () => {
    expect(
      practiceInviteDeliveryProblem({
        lastEmailStatus: "failed",
        lastEmailError: "send_failed",
      })
    ).toBe("Invite email failed to send");
    expect(
      practiceInviteDeliveryProblem({
        lastEmailStatus: "skipped",
        lastEmailError: null,
      })
    ).toBe("Email skipped — recipient opted out");
  });
});
