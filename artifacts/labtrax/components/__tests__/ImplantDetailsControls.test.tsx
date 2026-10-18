import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ImplantDetailsControls, SavedImplantDetails } from "../ImplantDetailsControls";
import { resilientFetch } from "@/lib/query-client";
import { type ImplantDetails, IMPLANT_PLATFORM_PLACEHOLDER } from "@workspace/case-taxonomy";

vi.mock("@/lib/theme-context", () => ({ useTheme: () => ({ colors: { text: "#111", tint: "#00f", border: "#ccc" } }) }));
vi.mock("@/lib/query-client", () => ({ resilientFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const row = { id: "r1", toothNumber: "14", implantPlatformNotes: "RC", implantRetention: "Screw retained" };

describe("mobile implant controls", () => {
  it("uses the exact placeholder and requested accessible dropdown choices", async () => {
    function Draft() {
      const [value, onChange] = useState<ImplantDetails>({});
      return <ImplantDetailsControls value={value} onChange={onChange} />;
    }
    const view = await render(<Draft />);
    expect(view.getByTestId("implant-platform-notes").props.placeholder).toBe(IMPLANT_PLATFORM_PLACEHOLDER);
    await fireEvent.press(view.getByLabelText("Implant Retention"));
    await fireEvent.press(view.getByText("Cementable"));
    expect(view.getByLabelText("Implant Retention").props.accessibilityState.expanded).toBe(false);
    await fireEvent.press(view.getByLabelText("Implant Manufacturer"));
    for (const option of ["Straumann", "BioHorizons", "Implant Direct", "Other"]) expect(view.getByText(option)).toBeTruthy();
    await fireEvent.press(view.getByText("Other"));
    await fireEvent.changeText(view.getByTestId("implant-platform-notes"), "WB 4.8");
    expect(view.getByTestId("implant-platform-notes").props.value).toBe("WB 4.8");
  });
  it("reverts a refused row save without changing another restoration", async () => {
    vi.mocked(resilientFetch).mockResolvedValue({ ok: false, json: async () => ({ error: "Permission denied" }) } as Response);
    const client = new QueryClient();
    const view = await render(<QueryClientProvider client={client}><SavedImplantDetails row={row} caseId="c1" canEdit /></QueryClientProvider>);
    await fireEvent.changeText(view.getByTestId("implant-platform-notes"), "RN");
    await fireEvent.press(view.getByText("Save implant details"));
    await waitFor(() => expect(view.getByTestId("implant-platform-notes").props.value).toBe("RC"));
    expect(resilientFetch).toHaveBeenCalledWith("/api/cases/c1/restorations/r1", expect.objectContaining({ body: expect.stringContaining('"syncLinkedArch":false') }));
  });
  it("keeps a committed save confirmed when the subsequent refresh fails", async () => {
    vi.mocked(resilientFetch).mockResolvedValue({ ok: true } as Response);
    const client = new QueryClient();
    vi.spyOn(client, "invalidateQueries").mockRejectedValue(new Error("Refresh offline"));
    const view = await render(<QueryClientProvider client={client}><SavedImplantDetails row={row} caseId="c1" canEdit /></QueryClientProvider>);
    await fireEvent.changeText(view.getByTestId("implant-platform-notes"), "WB");
    await fireEvent.press(view.getByText("Save implant details"));
    await waitFor(() => expect(view.getByRole("button", { name: "Save implant details" }).props.accessibilityState.disabled).toBe(true));
    expect(view.getByTestId("implant-platform-notes").props.value).toBe("WB");
    expect(resilientFetch).toHaveBeenCalledTimes(1);
  });
  it("shows authorized readers the saved values without edit controls", async () => {
    const client = new QueryClient();
    const view = await render(<QueryClientProvider client={client}><SavedImplantDetails row={row} caseId="c1" canEdit={false} /></QueryClientProvider>);
    expect(view.getByText("Implant Platform Notes: RC")).toBeTruthy();
    expect(view.queryByTestId("implant-platform-notes")).toBeNull();
    expect(view.queryByText("Save implant details")).toBeNull();
  });
});
