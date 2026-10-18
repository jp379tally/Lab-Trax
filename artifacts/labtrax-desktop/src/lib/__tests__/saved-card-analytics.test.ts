import { describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn().mockRejectedValue(new Error("offline")) }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { trackSavedCardSetup } from "@/lib/analytics";

describe("desktop saved-card analytics", () => {
  it("sends only the fixed outcome and ignores failures", async () => {
    trackSavedCardSetup("started");
    await Promise.resolve();
    expect(apiFetch).toHaveBeenCalledWith("/analytics/saved-card-setup", {
      method: "POST",
      body: JSON.stringify({ outcome: "started" }),
    });
  });
});