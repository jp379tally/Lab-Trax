/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdateBanner } from "../UpdateBanner";

afterEach(() => {
  cleanup();
  (window as any).electronAPI = {};
});

describe("UpdateBanner", () => {
  it("rehydrates a downloaded update and surfaces installation errors", async () => {
    const api = {
      getUpdateState: vi.fn().mockResolvedValue({
        status: "downloaded",
        latestVersion: "2.5.0",
      }),
      onUpdateState: vi.fn(() => () => {}),
      installUpdate: vi.fn().mockRejectedValue(new Error("Installer could not restart.")),
    };
    (window as any).electronAPI = api;

    render(<UpdateBanner />);

    const installButton = await screen.findByRole("button", { name: /restart & update/i });
    expect(screen.getByText(/v2.5.0 is ready to install/i)).toBeInTheDocument();
    fireEvent.click(installButton);

    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Installer could not restart.");
  });
});
