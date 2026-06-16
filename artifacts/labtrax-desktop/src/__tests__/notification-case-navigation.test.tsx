/**
 * @vitest-environment jsdom
 *
 * Regression guard: Notification "View" button must always open the correct
 * case drawer — whether Cases is mounting fresh (initial deep-link) or the
 * component is already mounted when the URL query string changes (same-page
 * navigation from a second "View" click).
 *
 * Two layers of coverage:
 *
 *   Static  — source-text assertions that fail immediately if the fix is
 *             reverted: useSearch must be imported, must appear in the effect
 *             dependency array, and the one-shot boolean guard must be gone.
 *
 *   Runtime — pure-function assertions on getNotificationDestination, which
 *             is the routing decision that drives the "View" click. These
 *             catch regressions in the notification → URL mapping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
import { getNotificationDestination } from "@/components/AppLayout";

// ── Module-level mocks (vi.mock is hoisted before imports) ──────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  getAccessToken: vi.fn().mockResolvedValue("tok"),
  getApiOrigin: vi.fn().mockReturnValue("http://localhost"),
  ApiError: class extends Error {},
  createUploadSession: vi.fn(),
  sendUploadChunk: vi.fn(),
}));

vi.mock("@/lib/ai-panel-context", () => ({
  useAiPanel: () => ({ openPanel: vi.fn(), closePanel: vi.fn() }),
}));

vi.mock("@/hooks/useColumnWidths", () => ({
  useColumnWidths: () => ({
    widths: Array(12).fill(120),
    resizingCol: null,
    startResize: vi.fn(),
    resetColumn: vi.fn(),
  }),
}));

vi.mock("@/lib/nav-guard", () => ({ setNavBlocker: vi.fn() }));

vi.mock("@/lib/format", () => ({
  formatDate: (s: string) => s,
  formatDateTime: (s: string) => s,
  formatMoney: (n: number) => String(n),
  formatPhone: (s: string) => s,
  formatShortDate: (s: string) => s,
  relativeTime: () => "just now",
  statusLabel: (s: string) => s,
}));

vi.mock("@/lib/print", () => ({
  printCaseCard: vi.fn(),
  printCaseCardAdvanced: vi.fn(),
  printCaseHistory: vi.fn(),
  printCaseOverview: vi.fn(),
  printInvoice: vi.fn(),
  printTabContent: vi.fn(),
}));

vi.mock("@/lib/export", () => ({ printInvoicePdf: vi.fn() }));

vi.mock("@/lib/rx-summary", () => ({
  buildHighlightedToothValue: () => null,
  deriveRxSummary: () => ({
    teeth: [],
    shades: [],
    materials: [],
    restorativeType: null,
    isFullArch: false,
  }),
  formatRxTeethLabel: () => "",
  formatRxTeethWithShades: () => "",
}));

vi.mock("@/lib/print-layout", () => ({
  isDefaultLayout: () => true,
  loadPrintLayoutConfig: () => null,
}));

vi.mock("@/lib/case-print-template", () => ({
  coerceCasePrintTemplate: () => null,
}));

vi.mock("@/lib/upload-media-file", () => ({ uploadMediaFile: vi.fn() }));

vi.mock("@/components/ToothChart", () => ({
  ToothChart: () => null,
  parseToothField: () => [],
  parseBridgeConnectors: () => [],
  formatBridgeConnectors: () => "",
}));

vi.mock("@/components/DoctorNamePicker", () => ({
  DoctorNamePicker: () => null,
}));

vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: () => null,
  AuthedVideo: () => null,
  isSameApiOrigin: () => true,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: () => null,
}));

vi.mock("./invoices", () => ({ InvoiceEditor: () => null }));

vi.mock("@/components/ToothActionDialog", () => ({
  ToothActionDialog: () => null,
}));

vi.mock("@/components/ScanViewerModal", () => ({
  default: () => null,
}));

vi.mock("@/components/ScanThumbnail", () => ({
  default: () => null,
}));

vi.mock("@/components/PrintLayoutEditor", () => ({
  PrintLayoutEditor: () => null,
}));

vi.mock("@/components/CasePrintLayoutEditor", () => ({
  CasePrintLayoutEditor: () => null,
}));

vi.mock("@/components/PrescriptionPreview", () => ({
  PrescriptionPreview: () => null,
}));

vi.mock("react-qr-code", () => ({ default: () => null }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn() } }));

vi.mock("@workspace/scan-viewer", () => ({}));


import CasesPage from "@/pages/cases";

// ── Helpers ─────────────────────────────────────────────────────────────────

const MINIMAL_CASE = {
  id: "abc",
  caseNumber: "#2600-1",
  patientFirstName: "Ada",
  patientLastName: "Lovelace",
  doctorName: "Dr. Test",
  status: "received",
  dueDate: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  labOrganizationId: "lab1",
  providerOrganizationId: "prov1",
  items: [],
  needsAiReview: false,
};

const AUTHED_USER = {
  id: "u1",
  username: "testlab",
  role: "owner",
  labOrganizationId: "lab1",
};

function makeTestWrapper(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const { hook, navigate } = memoryLocation({ path: initialPath });
  const authValue = {
    ...MOCK_AUTH_DEFAULTS,
    user: AUTHED_USER as never,
    status: "authed" as const,
    restoreStatus: "ok" as const,
    restoreNoticeDismissed: true,
  };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={authValue}>
            {children}
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  }
  return { Wrapper, navigate, queryClient };
}

// ── Static regression guards ─────────────────────────────────────────────────

const CASES_SRC = path.resolve(__dirname, "../pages/cases.tsx");

describe("Deep-link fix — static source guards", () => {
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(CASES_SRC, "utf-8");
  });

  it("imports useSearch from wouter", () => {
    expect(
      src,
      "cases.tsx must import useSearch from wouter so the effect reacts to URL query changes"
    ).toMatch(/useSearch/);
  });

  it("adds urlSearch to the deep-link useEffect dependency array", () => {
    expect(
      src,
      "The deep-link useEffect must depend on [urlSearch, data, isLoading] so a URL change re-fires it even when the component stays mounted"
    ).toMatch(/\[urlSearch,\s*data,\s*isLoading\]/);
  });

  it("does NOT use a one-shot deepLinkOpenedRef boolean guard", () => {
    expect(
      src,
      "The one-shot boolean guard (deepLinkOpenedRef.current = true) causes the effect to silently skip second 'View' clicks; it must be replaced with a per-caseId guard"
    ).not.toContain("deepLinkOpenedRef.current = true");
  });

  it("uses lastProcessedCaseIdRef to guard against re-opening the same case", () => {
    expect(
      src,
      "cases.tsx must use lastProcessedCaseIdRef (per-caseId guard) instead of a one-shot boolean"
    ).toContain("lastProcessedCaseIdRef");
  });
});

// ── Runtime: getNotificationDestination ─────────────────────────────────────

type MinimalNotif = Parameters<typeof getNotificationDestination>[0];

function notif(type: string, dataJson?: Record<string, unknown>): MinimalNotif {
  return {
    id: "n1",
    userId: "u1",
    type,
    title: "Test",
    body: "Test body",
    dataJson: dataJson ?? null,
    readAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("getNotificationDestination — notification → URL routing", () => {
  it("case_imported_from_itero with caseId → /cases?caseId=<id>", () => {
    const dest = getNotificationDestination(
      notif("case_imported_from_itero", { caseId: "abc-123" })
    );
    expect(dest).toBe("/cases?caseId=abc-123");
  });

  it("alert type with caseId → /cases?caseId=<id>", () => {
    const dest = getNotificationDestination(
      notif("alert", { caseId: "xyz-789" })
    );
    expect(dest).toBe("/cases?caseId=xyz-789");
  });

  it("alert type without caseId → null (no drawer destination)", () => {
    const dest = getNotificationDestination(notif("alert", { reason: "something_else" }));
    expect(dest).toBeNull();
  });

  it("case_imported_from_itero without caseId in dataJson → null", () => {
    const dest = getNotificationDestination(notif("case_imported_from_itero", {}));
    expect(dest).toBeNull();
  });

  it("encodes special characters in caseId", () => {
    const dest = getNotificationDestination(
      notif("case_imported_from_itero", { caseId: "case/with spaces&chars" })
    );
    expect(dest).toBe("/cases?caseId=case%2Fwith%20spaces%26chars");
  });

  it("security_session_revoked → /settings?tab=sessions", () => {
    const dest = getNotificationDestination(notif("security_session_revoked"));
    expect(dest).toBe("/settings?tab=sessions");
  });

  it("suspicious_signin → /settings?tab=sessions", () => {
    const dest = getNotificationDestination(notif("suspicious_signin"));
    expect(dest).toBe("/settings?tab=sessions");
  });

  it("alert with security alertReason → /settings?tab=sessions", () => {
    const dest = getNotificationDestination(
      notif("alert", { alertReason: "Security violation detected" })
    );
    expect(dest).toBe("/settings?tab=sessions");
  });

  it("unknown notification type → null", () => {
    const dest = getNotificationDestination(notif("some_unknown_type"));
    expect(dest).toBeNull();
  });
});

// ── Runtime: deep-link drawer behavior ──────────────────────────────────────

describe("CasesPage deep-link — initial mount with ?caseId=abc opens drawer", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/cases") return [];
      if (endpoint === "/cases/abc") return MINIMAL_CASE;
      if (endpoint === "/organizations") return [];
      return {};
    });
  });

  it("(a) fetches and opens the case when mounted at /cases?caseId=abc", async () => {
    const { Wrapper } = makeTestWrapper("/cases?caseId=abc");
    render(React.createElement(Wrapper, null, React.createElement(CasesPage, null)));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/cases/abc");
    }, { timeout: 10000 });
  }, 15000);

  it("(b) fetches case when URL changes from /cases to /cases?caseId=abc while mounted", async () => {
    const { Wrapper, navigate } = makeTestWrapper("/cases");
    render(React.createElement(Wrapper, null, React.createElement(CasesPage, null)));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/cases");
    }, { timeout: 10000 });

    mockApiFetch.mockClear();

    navigate("/cases?caseId=abc");

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/cases/abc");
    }, { timeout: 10000 });
  }, 25000);
});
