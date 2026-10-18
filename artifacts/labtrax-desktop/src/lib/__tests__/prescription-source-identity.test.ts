import { describe, expect, it } from "vitest";
import { prescriptionSourceIdentity } from "../prescription-source-identity";

describe("prescription draft identity", () => {
  it("retains the identity of the same bytes when file metadata or MIME changes", async () => {
    expect(await prescriptionSourceIdentity("data:image/png;base64,Y3Jvd24="))
      .toBe(await prescriptionSourceIdentity("data:image/jpeg;base64,Y3Jvd24="));
  });
  it("does not carry corrections to different prescriptions", async () => {
    expect(await prescriptionSourceIdentity("data:image/png;base64,Y3Jvd24="))
      .not.toBe(await prescriptionSourceIdentity("data:image/png;base64,cG9udGlj"));
  });
  it("fails explicitly for an unreadable source", async () => {
    await expect(prescriptionSourceIdentity("invalid")).rejects.toThrow("prescription source");
  });
});
