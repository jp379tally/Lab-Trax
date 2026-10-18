import { describe, expect, it, vi } from "vitest";

const { sendJson } = vi.hoisted(() => ({ sendJson: vi.fn().mockRejectedValue(new Error("offline")) }));
vi.mock("@/lib/read-api", () => ({ sendJson }));

import { trackSavedCardSetup } from "@/lib/saved-card-analytics";

describe("mobile saved-card analytics", () => {
  it("sends the exact fixed payload without surfacing failures", async () => {
    trackSavedCardSetup("expired");
    await Promise.resolve();
    expect(sendJson).toHaveBeenCalledWith(
      "POST",
      "/api/analytics/saved-card-setup",
      { outcome: "expired" },
    );
  });
});