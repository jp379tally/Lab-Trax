/** @vitest-environment jsdom */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ImplantDetailsControls, SavedImplantDetails } from "../ImplantDetailsControls";
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("implant controls", () => {
  it("shows exact dropdown options, correct order and an unsaved placeholder", () => {
    const changed = vi.fn();
    render(<ImplantDetailsControls value={{}} onChange={changed} />);
    const selects = screen.getAllByRole("combobox");
    expect(Array.from(selects[0].querySelectorAll("option")).map((option) => option.textContent)).toEqual(["—", "Screw retained", "Cementable"]);
    expect(Array.from(selects[1].querySelectorAll("option")).map((option) => option.textContent)).toEqual(["—", "Straumann", "BioHorizons", "Implant Direct", "Other"]);
    expect((screen.getByPlaceholderText("Platform size, RC, RN, WB, etc.") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Implant Platform Notes"), { target: { value: "RC" } });
    expect(changed).toHaveBeenLastCalledWith({ implantPlatformNotes: "RC" });
  });
  it("reverts refused edits and sends only row-scoped clinical metadata", async () => {
    apiFetch.mockRejectedValueOnce(new Error("Permission refused"));
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><SavedImplantDetails row={{ id: "r1", toothNumber: "14", implantManufacturer: "Straumann", implantPlatformNotes: "RC" }} caseId="case1" canEdit /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Implant Platform Notes"), { target: { value: "WB" } });
    fireEvent.click(screen.getByText("Save implant details"));
    await waitFor(() => expect((screen.getByLabelText("Implant Platform Notes") as HTMLInputElement).value).toBe("RC"));
    expect(apiFetch).toHaveBeenCalledWith("/cases/case1/restorations/r1", { method: "PATCH", body: JSON.stringify({ implantRetention: null, implantManufacturer: "Straumann", implantPlatformNotes: "WB", syncLinkedArch: false }) });
  });
  it("lets viewers read populated details without providing editing controls", () => {
    render(<QueryClientProvider client={new QueryClient()}><SavedImplantDetails row={{ id: "r1", toothNumber: "14", implantPlatformNotes: "RC" }} caseId="case1" canEdit={false} /></QueryClientProvider>);
    expect(screen.getByText("Implant Platform Notes: RC")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Save implant details")).toBeNull();
  });
});
