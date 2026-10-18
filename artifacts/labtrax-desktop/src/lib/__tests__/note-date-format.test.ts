import { describe, it, expect } from "vitest";
import { formatDatedNote, formatNoteDay } from "@/lib/format";

// Note timestamps are genuine instants (createdAt), so the day the lab slip
// shows is the day the viewer was on when the note was entered — read from
// local date parts. Fixtures below are built with the local-time Date
// constructor and serialized via toISOString() so the assertions hold in any
// host timezone.
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
  minute = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}

describe("formatNoteDay", () => {
  it("renders a note's local day as zero-padded MM/DD", () => {
    expect(formatNoteDay(localIso(2026, 8, 15))).toBe("09/15");
  });

  it("pads single-digit months and days", () => {
    expect(formatNoteDay(localIso(2026, 0, 5))).toBe("01/05");
    expect(formatNoteDay(localIso(2026, 11, 9))).toBe("12/09");
  });

  it("never shows a year, even for a note from a previous year", () => {
    expect(formatNoteDay(localIso(2024, 2, 3))).toBe("03/03");
  });

  it("keeps the day stable across the whole local day", () => {
    expect(formatNoteDay(localIso(2026, 8, 15, 0, 0))).toBe("09/15");
    expect(formatNoteDay(localIso(2026, 8, 15, 23, 59))).toBe("09/15");
  });

  it("reports no date for a missing or unreadable timestamp", () => {
    expect(formatNoteDay(null)).toBeNull();
    expect(formatNoteDay(undefined)).toBeNull();
    expect(formatNoteDay("")).toBeNull();
    expect(formatNoteDay("not-a-date")).toBeNull();
  });
});

describe("formatDatedNote", () => {
  it("puts the day immediately to the left of the note text", () => {
    expect(
      formatDatedNote(
        "Confirmed with Dr. Byrne that we are going to TIW.",
        localIso(2026, 8, 15),
      ),
    ).toBe("09/15 Confirmed with Dr. Byrne that we are going to TIW.");
  });

  it("falls back to the text alone — no placeholder — without a usable date", () => {
    expect(formatDatedNote("Seat adjusted", null)).toBe("Seat adjusted");
    expect(formatDatedNote("Seat adjusted", "")).toBe("Seat adjusted");
    expect(formatDatedNote("Seat adjusted", "garbage")).toBe("Seat adjusted");
  });
});
