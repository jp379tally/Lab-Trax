/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { PROVIDER_CARD_REUSE_WORDING, type ProviderSignupTier } from "@workspace/api-client-react";
import ProviderPlanChoices from "../ProviderPlanChoices";
function Harness() {
  const [selected, setSelected] = useState<ProviderSignupTier | null>(null);
  const [reuse, setReuse] = useState(false);
  return <ProviderPlanChoices selected={selected} onSelect={setSelected} reuseCard={reuse} onReuseChange={setReuse} />;
}
describe("fixed provider plans", () => {
  it("renders all four choices without any catalog request and preserves explicit consent", () => {
    const network = vi.spyOn(globalThis, "fetch");
    render(<Harness />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    for (const name of ["Free", "Basic", "Standard", "Premium"]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByTestId("provider-plan-standard"));
    expect(screen.getByTestId("provider-plan-standard")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: PROVIDER_CARD_REUSE_WORDING })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText(/Stripe retains the subscription card/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("provider-plan-free"));
    expect(screen.getByTestId("provider-plan-free")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
});
