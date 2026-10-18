import { describe, expect, it } from "vitest";
import { offsiteFirstTickDelayMs } from "./offsite-backup-timing.js";

const MINUTE = 60_000;
const LAST_VERIFIED = "2026-10-12T18:17:00.000Z";

describe("independent off-site timer after a restart", () => {
  it("keeps the existing deadline instead of waiting fifteen minutes from boot", () => {
    const restartedAt = Date.parse("2026-10-12T18:25:00.000Z");
    expect(offsiteFirstTickDelayMs(restartedAt, LAST_VERIFIED, 15)).toBe(7 * MINUTE);
  });

  it("cannot postpone a future deadline through repeated restarts", () => {
    const expectedDue = Date.parse("2026-10-12T18:32:00.000Z");
    for (const restartedAt of ["18:18", "18:25", "18:31"]) {
      const now = Date.parse(`2026-10-12T${restartedAt}:00.000Z`);
      expect(now + offsiteFirstTickDelayMs(now, LAST_VERIFIED, 15)).toBe(expectedDue);
    }
  });

  it.each([null, "invalid", "2026-10-12T18:00:00.000Z"])(
    "leaves missing or overdue evidence (%s) to the existing startup catch-up",
    (lastVerifiedAt) => {
      expect(offsiteFirstTickDelayMs(
        Date.parse("2026-10-12T18:25:00.000Z"), lastVerifiedAt, 15,
      )).toBe(15 * MINUTE);
    },
  );

  it("does not stretch the interval when a recorded time is in the future", () => {
    expect(offsiteFirstTickDelayMs(
      Date.parse("2026-10-12T18:25:00.000Z"),
      "2026-10-12T18:28:00.000Z",
      15,
    )).toBe(15 * MINUTE);
  });

  it("refuses an invalid configured interval", () => {
    expect(() => offsiteFirstTickDelayMs(Date.now(), null, 0)).toThrow(RangeError);
  });
});
