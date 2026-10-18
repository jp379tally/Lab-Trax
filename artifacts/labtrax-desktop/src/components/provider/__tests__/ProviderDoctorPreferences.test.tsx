/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderDoctorPreferences } from "../ProviderDoctorPreferences";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const SAVED = {
  occlusionAmount: 0.2,
  occlusionUnit: "mm",
  proximalContactAmount: 40,
  proximalContactUnit: "microns",
  anatomyPreference: "other",
  anatomyOther: "Match the adjacent central",
  caseQuestionContactMethod: "email",
  caseQuestionContactValue: "doctor@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProviderDoctorPreferences", () => {
  it("loads saved values and shows conditional fields", async () => {
    apiFetchMock.mockResolvedValueOnce(SAVED);
    render(<ProviderDoctorPreferences />);

    expect(await screen.findByDisplayValue("0.2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Match the adjacent central")).toHaveAttribute("maxlength", "100");
    expect(screen.getByDisplayValue("doctor@example.com")).toBeInTheDocument();
  });

  it("validates the conditional contact value before saving", async () => {
    apiFetchMock.mockResolvedValueOnce({ ...SAVED, caseQuestionContactMethod: null, caseQuestionContactValue: null });
    render(<ProviderDoctorPreferences />);
    await screen.findByDisplayValue("0.2");

    fireEvent.change(screen.getByLabelText("Case-question contact method"), {
      target: { value: "email" },
    });
    fireEvent.change(screen.getByLabelText("Case-question contact value"), {
      target: { value: "invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Doctor Preferences" }));

    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("saves the full form and shows success", async () => {
    apiFetchMock.mockResolvedValueOnce(SAVED).mockResolvedValueOnce(SAVED);
    render(<ProviderDoctorPreferences />);
    await screen.findByDisplayValue("0.2");

    fireEvent.click(screen.getByRole("button", { name: "Save Doctor Preferences" }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/users/me/doctor-preferences",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify(SAVED),
      }),
    ));
    expect(await screen.findByText("Doctor preferences saved.")).toBeInTheDocument();
  });

  it("keeps entered values after a failed save", async () => {
    apiFetchMock.mockResolvedValueOnce(SAVED).mockRejectedValueOnce(new Error("Offline"));
    render(<ProviderDoctorPreferences />);
    const amount = await screen.findByDisplayValue("0.2");
    fireEvent.change(amount, { target: { value: "0.35" } });

    fireEvent.click(screen.getByRole("button", { name: "Save Doctor Preferences" }));

    expect(await screen.findByText(/Your entries are still here/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.35")).toBeInTheDocument();
  });
});