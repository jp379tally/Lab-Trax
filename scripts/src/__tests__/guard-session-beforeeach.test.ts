import { describe, expect, it } from "vitest";
import { isApprovedSessionGuardException } from "../guard-session-beforeeach";

const approvedFile =
  "artifacts/api-server/src/routes/organizations-invite-delivery.test.ts";
const approvedLine =
  "    const { access } = await makeSession(ownerId); // session-guard:allow";

describe("session guard exception", () => {
  it("accepts only the exact organization setup session in beforeAll", () => {
    expect(
      isApprovedSessionGuardException(approvedFile, approvedLine, "beforeAll"),
    ).toBe(true);
  });

  it("rejects other files, statements, and lifecycle blocks", () => {
    expect(
      isApprovedSessionGuardException(
        "artifacts/api-server/src/routes/other.test.ts",
        approvedLine,
        "beforeAll",
      ),
    ).toBe(false);
    expect(
      isApprovedSessionGuardException(
        approvedFile,
        "const { access } = await makeSession(memberId); // session-guard:allow",
        "beforeAll",
      ),
    ).toBe(false);
    expect(
      isApprovedSessionGuardException(approvedFile, approvedLine, "beforeEach"),
    ).toBe(false);
  });
});
