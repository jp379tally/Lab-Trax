import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { render, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../vitest.setup";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * normalizeCaseStatus()/normalizeCaseStatuses() coerce legacy uppercase mobile
 * tokens and desktop-bridge tokens (e.g. "DELIVERY", "SHIP", "ON_HOLD") to the
 * canonical lowercase CaseStatus the mobile domain model uses everywhere. The
 * helper is unit-tested in normalize-case-status.test.ts, but a correct helper
 * is useless if the ingestion boundaries stop calling it — that is exactly how
 * the "shipped shows as Intake" bug returns.
 *
 * These tests pin the two real ingestion boundaries in app-context.tsx:
 *   1. fetchCasesFromServer() — cases pulled from /api/legacy/cases.
 *   2. loadData()            — cases hydrated from AsyncStorage on mount.
 *
 * We spy on the real normalizeCaseStatuses export and assert each boundary
 * actually pipes its raw cases through it. The spy fires inside the boundary's
 * .map() before any merge/filter, so the assertion does not depend on a case
 * surviving downstream reconciliation — only on the normalization call itself.
 */

// Spy on the real normalizeCaseStatuses while keeping every other data.ts
// export (and the helper's real implementation) intact.
vi.mock("@/lib/data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data")>(
    "@/lib/data",
  );
  return {
    ...actual,
    normalizeCaseStatuses: vi.fn(actual.normalizeCaseStatuses),
  };
});

// Render the REAL AppProvider (vitest.setup.ts replaces it with a stub by
// default for screen smoke tests; here we need the genuine provider so its
// ingestion effects run).
vi.mock("@/lib/app-context", async () =>
  vi.importActual("@/lib/app-context"),
);

// A signed-in user so the server-fetch effect (gated on currentUserId) fires.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    currentUserId: "user-1",
    currentUser: "tester",
    userType: "lab",
    registeredUsers: [],
    refreshUsers: vi.fn(async () => undefined),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AppProvider, useApp } from "@/lib/app-context";
import { normalizeCaseStatuses } from "@/lib/data";
import type { LabCase } from "@/lib/data";

// Must match CASES_KEY in app-context.tsx.
const CASES_KEY = "@drivesync_cases";

function rawCase(overrides: Record<string, unknown>) {
  return {
    id: "case-x",
    ownerId: "user-1",
    status: "RECEIVED",
    createdAt: 1,
    updatedAt: 1,
    routeHistory: [],
    activityLog: [],
    ...overrides,
  };
}

function renderProvider() {
  return render(
    React.createElement(AppProvider, null, React.createElement(() => null)),
  );
}

// Captures the latest value of useApp().cases on every render so a test can
// assert on what a real consumer of the context actually sees — the case list
// that drives the UI — rather than on an internal helper call.
function makeCaseCapture() {
  const captured: { current: LabCase[] } = { current: [] };
  function CaseCapture() {
    captured.current = useApp().cases;
    return null;
  }
  return { captured, CaseCapture };
}

function renderWithCapture(CaseCapture: React.ComponentType) {
  return render(
    React.createElement(AppProvider, null, React.createElement(CaseCapture)),
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

afterEach(() => {
  resetMockFetchHandler();
});

describe("case-status normalization is applied at ingestion boundaries", () => {
  it("passes server-fetched cases through normalizeCaseStatuses()", async () => {
    const serverCase = rawCase({ id: "server-1", status: "DELIVERY" });

    setMockFetchHandler((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/api/legacy/cases")) {
        return new Response(JSON.stringify({ cases: [serverCase] }), {
          status: 200,
        });
      }
      // Everything else (users, invoices, affiliations, polling) → empty.
      return new Response(JSON.stringify({}), { status: 200 });
    });

    renderProvider();

    await waitFor(() => {
      expect(normalizeCaseStatuses).toHaveBeenCalledWith(
        expect.objectContaining({ id: "server-1", status: "DELIVERY" }),
      );
    });
  });

  it("passes AsyncStorage-hydrated cases through normalizeCaseStatuses()", async () => {
    const cachedCase = rawCase({ id: "hydrate-1", status: "SHIP" });
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([cachedCase]));

    // Keep the server fetch from contributing any normalization calls so the
    // assertion isolates the hydration boundary.
    setMockFetchHandler((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/api/legacy/cases")) {
        return new Response(JSON.stringify({ cases: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    renderProvider();

    await waitFor(() => {
      expect(normalizeCaseStatuses).toHaveBeenCalledWith(
        expect.objectContaining({ id: "hydrate-1", status: "SHIP" }),
      );
    });
  });
});

/**
 * END-TO-END: the normalized status must survive merge/dedup and reach the
 * `cases` value a real consumer of useApp() sees. The boundary tests above
 * only prove normalizeCaseStatuses() is *called*; they would still pass if a
 * later mergeServerCases() / cases-selector bug re-introduced a raw uppercase
 * token. These tests close that gap by asserting the visible status.
 */
describe("normalized case status reaches useApp().cases", () => {
  it("server-fetched DELIVERY surfaces as canonical 'shipped' in useApp().cases", async () => {
    const serverCase = rawCase({ id: "server-1", status: "DELIVERY" });

    setMockFetchHandler((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/api/legacy/cases")) {
        return new Response(JSON.stringify({ cases: [serverCase] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { captured, CaseCapture } = makeCaseCapture();
    renderWithCapture(CaseCapture);

    await waitFor(() => {
      const visible = captured.current.find((c) => c.id === "server-1");
      expect(visible).toBeDefined();
      expect(visible?.status).toBe("shipped");
    });

    // No raw uppercase token leaked through the merge/selector path.
    expect(
      captured.current.some((c) => (c.status as string) === "DELIVERY"),
    ).toBe(false);
  });

  it("AsyncStorage-hydrated SHIP surfaces as canonical 'shipped' in useApp().cases", async () => {
    const cachedCase = rawCase({ id: "hydrate-1", status: "SHIP" });
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([cachedCase]));

    // mergeServerCases is now server-authoritative: local-only cases are not
    // preserved. The server must return the case for it to appear. The test
    // still validates the normalization path (SHIP → shipped) by having the
    // server echo back the same raw case.
    setMockFetchHandler((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/api/legacy/cases")) {
        return new Response(JSON.stringify({ cases: [cachedCase] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { captured, CaseCapture } = makeCaseCapture();
    renderWithCapture(CaseCapture);

    await waitFor(() => {
      const visible = captured.current.find((c) => c.id === "hydrate-1");
      expect(visible).toBeDefined();
      expect(visible?.status).toBe("shipped");
    });

    expect(
      captured.current.some((c) => (c.status as string) === "SHIP"),
    ).toBe(false);
  });
});
