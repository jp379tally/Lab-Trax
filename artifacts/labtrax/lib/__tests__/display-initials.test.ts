import { describe, it, expect } from "vitest";
import { deriveDisplayInitials } from "../display-initials";

describe("deriveDisplayInitials", () => {
  it("uses first + last name initials when both are present", () => {
    expect(
      deriveDisplayInitials({ firstName: "Jane", lastName: "Doe" })
    ).toBe("JD");
  });

  it("trims whitespace before picking the initial letters", () => {
    expect(
      deriveDisplayInitials({ firstName: "  alice  ", lastName: " smith" })
    ).toBe("AS");
  });

  it("falls back to the label when only one name is provided", () => {
    expect(
      deriveDisplayInitials({ firstName: "Jane", label: "jane.doe" })
    ).toBe("JD");
  });

  it("splits a username on non-alphanumeric boundaries", () => {
    expect(deriveDisplayInitials({ label: "jane.doe" })).toBe("JD");
    expect(deriveDisplayInitials({ label: "jane-doe" })).toBe("JD");
    expect(deriveDisplayInitials({ label: "jane_doe" })).toBe("JD");
  });

  it("splits a username on camelCase boundaries", () => {
    expect(deriveDisplayInitials({ label: "janeDoe" })).toBe("JD");
  });

  it("uses the first two letters when the label is a single token", () => {
    expect(deriveDisplayInitials({ label: "alex" })).toBe("AL");
  });

  it("strips non-alphanumeric characters from a single token", () => {
    expect(deriveDisplayInitials({ label: "@x!y" })).toBe("XY");
  });

  it("returns the single uppercased character when only one alphanumeric remains", () => {
    expect(deriveDisplayInitials({ label: "z!" })).toBe("Z");
  });

  it("returns ?? when nothing usable is provided", () => {
    expect(deriveDisplayInitials()).toBe("??");
    expect(deriveDisplayInitials({})).toBe("??");
    expect(deriveDisplayInitials({ label: "" })).toBe("??");
    expect(deriveDisplayInitials({ label: "   " })).toBe("??");
    expect(deriveDisplayInitials({ label: "!!!" })).toBe("??");
  });

  it("ignores the label when both first and last name are present", () => {
    expect(
      deriveDisplayInitials({
        firstName: "Bob",
        lastName: "Carr",
        label: "ignored.label",
      })
    ).toBe("BC");
  });
});
