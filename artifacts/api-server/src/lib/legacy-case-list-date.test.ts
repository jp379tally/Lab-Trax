import { afterEach, describe, expect, it } from "vitest";
import {
  buildArrayLegacyRow,
  buildWorklistLegacyRow,
  buildWorklistUnreadableLegacyRow,
  legacyUtcCalendarDate,
} from "./legacy-case-list";

const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

function row(updatedAt: Date | string) {
  return {
    id: "legacy-date",
    ownerId: "owner",
    organizationId: "lab",
    updatedAt,
    projectionVersion: null,
    projectedSummary: null,
  };
}

describe("legacy case received-date normalization", () => {
  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "treats timezone-less updated_at wall-clock fields as UTC in %s",
    (timezone) => {
      process.env.TZ = timezone;
      const databaseDate = new Date(2026, 5, 29, 0, 30, 0);
      expect(legacyUtcCalendarDate(databaseDate)).toBe("2026-06-29");
      expect(legacyUtcCalendarDate("2026-06-29 00:30:00")).toBe(
        "2026-06-29",
      );
    },
  );

  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "keeps projected, unprojected, and unreadable rows on the stored day in %s",
    (timezone) => {
      process.env.TZ = timezone;
      const legacyRow = row("2026-06-29 00:30:00");
      const parsed = {
        caseNumber: "26-LEGACY",
        patientName: "Date Boundary",
        status: "INTAKE",
      };

      expect(
        buildWorklistLegacyRow(legacyRow, parsed, undefined).receivedAt,
      ).toBe("2026-06-29");
      expect(buildWorklistUnreadableLegacyRow(legacyRow).receivedAt).toBe(
        "2026-06-29",
      );
      expect(
        buildArrayLegacyRow(legacyRow, parsed, {
          paginationActive: true,
        }).receivedAt,
      ).toBe("2026-06-29");
    },
  );
});