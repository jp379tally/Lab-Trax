import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  declineToReadOnly,
  entitlementDecisionKey,
  hasDeclinedReadOnly,
} from "@/lib/entitlement-decision";

vi.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

describe("entitlement decision acknowledgement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes durable decline to user and entitlement subject", async () => {
    expect(entitlementDecisionKey("user/1", "lab-subscription")).toContain(
      "user%2F1/lab-subscription",
    );
    vi.mocked(AsyncStorage.getItem).mockResolvedValue("declined");
    expect(await hasDeclinedReadOnly("user-1", "subject-a")).toBe(true);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(
      entitlementDecisionKey("user-1", "subject-a"),
    );
  });

  it("persists decline without affecting another subject", async () => {
    await declineToReadOnly("user-1", "subject-a");
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      entitlementDecisionKey("user-1", "subject-a"),
      "declined",
    );
    expect(entitlementDecisionKey("user-1", "subject-a")).not.toBe(
      entitlementDecisionKey("user-2", "subject-a"),
    );
  });
});