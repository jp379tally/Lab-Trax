// Mobile provider portal → Stats.
//
// Mirrors the desktop ProviderStats: the same three summary figures, the same
// remake-reason breakdown with bars sized relative to the largest reason, and
// the same loading, error, and no-remakes states.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";

// The global setup swaps `useQuery` for a static stub; this section needs a
// real query so its loading and error states are the ones React Query drives.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

import { ProviderStatsSection } from "@/components/provider-portal/sections/ProviderStatsSection";

interface StatsFixture {
  totalCases: number;
  remakeCount: number;
  remakePct: number;
  reasonCounts: Array<{ reason: string; count: number }>;
}

function installStats(stats: StatsFixture): void {
  setMockFetchHandler((url) => {
    if (url.includes("/api/provider/stats")) {
      return new Response(JSON.stringify({ ok: true, data: stats }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
  });
}

function installStatsFailure(): void {
  setMockFetchHandler((url) => {
    if (url.includes("/api/provider/stats")) {
      return new Response(JSON.stringify({ message: "Failed to load stats." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), { status: 200 });
  });
}

async function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderStatsSection />
    </QueryClientProvider>,
  );
}

/** Let queued promises, timers, and the state updates they cause settle. */
async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

/** Width the breakdown bar was rendered at, e.g. "50%". */
function barWidth(view: Awaited<ReturnType<typeof render>>, index: number): unknown {
  const style = view.getByTestId(`provider-stats-reason-bar-${index}`).props.style;
  const flat = Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean))
    : (style as Record<string, unknown>);
  return (flat as { width?: unknown }).width;
}

beforeEach(() => {
  resetMockAppState();
  resetMockFetchHandler();
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("provider portal → Stats", () => {
  it("shows the three summary figures desktop shows", async () => {
    installStats({
      totalCases: 25,
      remakeCount: 3,
      remakePct: 12,
      reasonCounts: [{ reason: "Shade mismatch", count: 3 }],
    });

    const view = await renderStats();
    await flush();

    expect(view.getByTestId("provider-stats-remake-count").props.children).toBe(3);
    expect(view.getByTestId("provider-stats-total-cases").props.children).toBe(25);
    expect(view.getByText("12%")).toBeTruthy();
    expect(view.getByText("Total remakes")).toBeTruthy();
    expect(view.getByText("of all cases")).toBeTruthy();
    expect(view.getByText("Total cases")).toBeTruthy();
  });

  it("breaks remakes down by reason with counts and bars relative to the largest reason", async () => {
    installStats({
      totalCases: 40,
      remakeCount: 6,
      remakePct: 15,
      reasonCounts: [
        { reason: "Shade mismatch", count: 4 },
        { reason: "Contact too tight", count: 2 },
      ],
    });

    const view = await renderStats();
    await flush();

    expect(view.getByTestId("provider-stats-reasons")).toBeTruthy();
    expect(view.getByText("Remake reasons")).toBeTruthy();
    expect(view.getByText("Shade mismatch")).toBeTruthy();
    expect(view.getByText("Contact too tight")).toBeTruthy();
    expect(view.getByTestId("provider-stats-reason-count-0").props.children).toBe(4);
    expect(view.getByTestId("provider-stats-reason-count-1").props.children).toBe(2);
    expect(barWidth(view, 0)).toBe("100%");
    expect(barWidth(view, 1)).toBe("50%");
  });

  it("shows the loading state while the figures are being fetched", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    setMockFetchHandler((url) => url.includes("/api/provider/stats") ? pending :
      new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }));

    const view = await renderStats();
    expect(view.getByTestId("provider-stats-loading")).toBeTruthy();
    expect(view.getByText("Loading stats…")).toBeTruthy();

    await act(async () => {
      finish(new Response(JSON.stringify({ ok: true, data: {
        totalCases: 0, remakeCount: 0, remakePct: 0, reasonCounts: [],
      } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    await flush();
    expect(view.queryByTestId("provider-stats-loading")).toBeNull();
  });

  it("shows the error state when the figures cannot be loaded", async () => {
    installStatsFailure();

    const view = await renderStats();
    await flush();

    expect(view.getByTestId("provider-stats-error")).toBeTruthy();
    expect(view.getByText("Failed to load stats.")).toBeTruthy();
    expect(view.queryByTestId("provider-stats-reasons")).toBeNull();
  });

  it("shows the no-remakes state instead of an empty breakdown", async () => {
    installStats({ totalCases: 18, remakeCount: 0, remakePct: 0, reasonCounts: [] });

    const view = await renderStats();
    await flush();

    expect(view.getByTestId("provider-stats-no-remakes")).toBeTruthy();
    expect(view.getByText("No remakes on record")).toBeTruthy();
    expect(view.getByText("When a case is remade, the reason and count will appear here.")).toBeTruthy();
    expect(view.queryByTestId("provider-stats-reasons")).toBeNull();
  });
});
