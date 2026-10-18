import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PREFS_KEY,
  DEFAULT_DASHBOARD_PREFS,
  loadDashboardPrefs,
} from "../dashboard-preferences";

describe("dashboard preferences", () => {
  it("loads only recognized boolean preferences", async () => {
    const result = await loadDashboardPrefs(async (key) => {
      expect(key).toBe(DASHBOARD_PREFS_KEY);
      return JSON.stringify({
        dueTomorrowOpen: false,
        recentOpen: true,
        unknownOption: "ignored",
      });
    });

    expect(result).toEqual({
      dueTomorrowOpen: false,
      recentOpen: true,
    });
    expect(DEFAULT_DASHBOARD_PREFS.dueTomorrowOpen).toBe(true);
  });

  it("handles storage thenables whose chained result has no finally method", async () => {
    const raw = JSON.stringify({ dueTomorrowOpen: false });
    const storageThenable = {
      then(onFulfilled: (value: string | null) => void) {
        onFulfilled(raw);
        return {
          catch() {
            return { finally: undefined };
          },
        };
      },
    } as unknown as PromiseLike<string | null>;

    await expect(
      loadDashboardPrefs(() => storageThenable),
    ).resolves.toEqual({ dueTomorrowOpen: false });
  });

  it("falls back to defaults for rejected storage and malformed saved data", async () => {
    await expect(
      loadDashboardPrefs(() => Promise.reject(new Error("storage unavailable"))),
    ).resolves.toEqual({});
    await expect(
      loadDashboardPrefs(async () => "{not valid JSON"),
    ).resolves.toEqual({});
    await expect(
      loadDashboardPrefs(async () => JSON.stringify(["not", "prefs"])),
    ).resolves.toEqual({});
  });
});
