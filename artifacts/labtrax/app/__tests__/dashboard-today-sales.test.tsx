import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen from "../(tabs)/dashboard";
import { TODAY_SALES_ROUTE } from "@/lib/sales-range";

afterEach(async () => {
  await cleanup();
  resetMockAppState();
  vi.mocked(router.push).mockClear();
});

describe("dashboard Today sales navigation", () => {
  it.each(["admin", "owner"])("opens Reports with Today selected for a lab %s", async (role) => {
    setMockAppState({
      meMemberships: [{
        organizationId: "lab", role, status: "active",
        organization: { id: "lab", type: "lab", name: "Sales lab" },
      }],
    });
    const view = await render(<DashboardScreen />);
    await fireEvent.press(view.getByLabelText("Today's sales — tap to open finance report"));
    expect(router.push).toHaveBeenCalledWith(TODAY_SALES_ROUTE);
    expect(TODAY_SALES_ROUTE).toBe("/manage/reports?preset=today");
  });
});
