import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react-native";
import type { ProviderSignupTier } from "@workspace/api-client-react";
import ProviderPlanChoices from "@/components/ProviderPlanChoices";
function Harness() {
  const [selected, setSelected] = useState<ProviderSignupTier | null>(null);
  const [reuse, setReuse] = useState(false);
  return <ProviderPlanChoices selected={selected} onSelect={setSelected} reuseCard={reuse} onReuseChange={setReuse} />;
}
describe("native and mobile web signup plan parity", () => {
  it("offers fixed USD prices, explicit Free, and separately unchecked reuse consent", async () => {
    const ui = await render(<Harness />);
    for (const tier of ["free", "basic", "standard", "premium"]) expect(ui.getByTestId(`provider-plan-${tier}`)).toBeTruthy();
    expect(ui.getByText("$0 — permanent")).toBeTruthy();
    expect(ui.getByText("$99/month USD")).toBeTruthy();
    expect(ui.getByText("$149/month USD")).toBeTruthy();
    expect(ui.getByText("$199/month USD")).toBeTruthy();
    expect(ui.queryByTestId("provider-card-reuse")).toBeNull();
    await fireEvent.press(ui.getByTestId("provider-plan-premium"));
    expect(ui.getByTestId("provider-plan-premium").props.accessibilityState.checked).toBe(true);
    expect(ui.getByTestId("provider-card-reuse").props.accessibilityState.checked).toBe(false);
    await fireEvent.press(ui.getByTestId("provider-card-reuse"));
    expect(ui.getByTestId("provider-card-reuse").props.accessibilityState.checked).toBe(true);
    await fireEvent.press(ui.getByTestId("provider-plan-free"));
    expect(ui.queryByTestId("provider-card-reuse")).toBeNull();
  });
});
