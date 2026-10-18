import { describe, expect, it } from "vitest";
import {
  isInAppNotificationEnabled,
  mergeInAppNotificationPreferences,
  parseNotificationPreferenceValue,
  selectInAppNotificationRecipientIds,
} from "./in-app-notifications";

describe("in-app notification preference defaults", () => {
  it("defaults every category to enabled when no saved setting exists", () => {
    const prefs = mergeInAppNotificationPreferences({});

    expect(prefs).toEqual({
      inAppNewCase: true,
      inAppTeammateMessage: true,
      inAppDoctorPracticeMessage: true,
      inAppExceptionCase: true,
      inAppRushCase: true,
    });
  });

  it("fails open when a stored setting is malformed or has a malformed category", () => {
    expect(parseNotificationPreferenceValue("{broken")).toEqual({});
    expect(
      isInAppNotificationEnabled(
        { inAppDoctorPracticeMessage: "false" },
        "doctor_practice_message",
      ),
    ).toBe(true);
  });

  it("suppresses only the category a user explicitly disables", () => {
    const prefs = mergeInAppNotificationPreferences({
      inAppRushCase: false,
      inAppNewCase: true,
    });

    expect(isInAppNotificationEnabled(prefs, "rush_case")).toBe(false);
    expect(isInAppNotificationEnabled(prefs, "new_case")).toBe(true);
  });
});

describe("in-app notification recipient selection", () => {
  it("applies explicit false to the matching user and category", () => {
    expect(
      selectInAppNotificationRecipientIds(
        [{ userId: "opted-out" }, { userId: "opted-in" }],
        [
          {
            key: "notif_prefs:opted-out",
            value: JSON.stringify({ inAppNewCase: false, inAppRushCase: true }),
          },
          {
            key: "notif_prefs:opted-in",
            value: JSON.stringify({ inAppNewCase: true, inAppRushCase: false }),
          },
        ],
        "new_case",
      ),
    ).toEqual(["opted-in"]);
  });

  it("keeps enabled-by-default recipients and de-duplicates membership rows", () => {
    expect(
      selectInAppNotificationRecipientIds(
        [
          { userId: "default-user" },
          { userId: "default-user" },
          { userId: "rush-opt-out" },
        ],
        [
          {
            key: "notif_prefs:rush-opt-out",
            value: JSON.stringify({ inAppRushCase: false }),
          },
        ],
        "rush_case",
      ),
    ).toEqual(["default-user"]);
  });
});