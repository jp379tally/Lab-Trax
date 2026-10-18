import { afterEach, describe, expect, it } from "vitest";
import { formatCalendarDate } from "../format";

const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

describe("formatCalendarDate", () => {
  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "does not shift a received day in %s",
    (timezone) => {
      process.env.TZ = timezone;
      expect(formatCalendarDate("2026-12-31")).toBe("12/31/2026");
    },
  );

  it("does not display an impossible received date", () => {
    expect(formatCalendarDate("2026-02-31")).toBe("—");
  });
});