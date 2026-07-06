/**
 * @vitest-environment jsdom
 *
 * Regression guard: the per-file note prompt must bind each note to the exact
 * file the user typed it for. When several files are attached at once, the
 * confirm step issues one `POST /cases/:caseId/attachments` per file, and each
 * request body must carry that file's own note (trimmed) — or no `note` field
 * at all when the user left it blank.
 *
 * A silent regression here (e.g. notes indexed off-by-one, or a shared draft)
 * would attach the wrong note to the wrong file with no visible error, so this
 * test drives the real drawer UI: it opens the Files tab, picks three files,
 * sets a distinct note on two (leaving one blank, and padding one with
 * whitespace to prove trimming), confirms, and asserts every POST body pairs
 * the correct note with the correct file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";

// ── Module-level mocks (vi.mock is hoisted before imports) ──────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());
const mockUploadMediaFile = vi.hoisted(() => vi.fn());

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
  formatDueDate: (s: string) => s,
  formatShortDueDate: (s: string) => s,
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

vi.mock("@/lib/upload-media-file", () => ({ uploadMediaFile: mockUploadMediaFile }));

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
  MediaLightbox: () => null,
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

const CASE_ID = "abc";

const DETAIL_CASE = {
  id: CASE_ID,
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
  attachments: [],
  notes: [],
  restorations: [],
  events: [],
  viewerCanUploadAttachments: true,
  viewerCanManageAttachments: true,
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
  const { hook } = memoryLocation({ path: initialPath });
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
          <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  }
  return { Wrapper };
}

/** Parsed body of one POST /cases/:id/attachments call. */
type AttachmentPost = {
  storageKey: string;
  fileName: string;
  fileType: string;
  note?: string;
};

function attachmentPosts(): AttachmentPost[] {
  return mockApiFetch.mock.calls
    .filter(
      ([endpoint, opts]) =>
        endpoint === `/cases/${CASE_ID}/attachments` &&
        (opts as RequestInit | undefined)?.method === "POST",
    )
    .map(([, opts]) => JSON.parse((opts as RequestInit).body as string) as AttachmentPost);
}

function makeFile(name: string) {
  return new File(["data"], name, { type: "image/png" });
}

describe("Per-file note prompt — each note lands on the right file", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/cases") return [];
      if (endpoint === `/cases/${CASE_ID}`) return DETAIL_CASE;
      if (endpoint.startsWith("/organizations")) return [];
      // Every other drawer query is a list endpoint (vocabulary, vendors,
      // remake-chain, invoices, doctor-names, …). Returning [] keeps the
      // `.map`/`.filter` call sites from crashing; object-shaped consumers use
      // optional chaining + `?? []`, so an array is a safe default there too.
      return [];
    });
    mockUploadMediaFile.mockReset();
    // Each file gets a distinct storage URL derived from its name so the test
    // can prove the POST body pairs the right file with the right note.
    mockUploadMediaFile.mockImplementation(async (file: File) => ({
      url: `storage://${file.name}`,
    }));
  });

  async function openFilesTabAndPick(names: string[]) {
    const { Wrapper } = makeTestWrapper(`/cases?caseId=${CASE_ID}`);
    const { container } = render(
      React.createElement(Wrapper, null, React.createElement(CasesPage, null)),
    );

    // Wait for the drawer to open (deep-link fetches the case detail).
    const filesTab = await screen.findByRole("button", { name: "Files" }, { timeout: 10000 });
    fireEvent.click(filesTab);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(input, "Files tab must render the hidden multi-file input").not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: names.map(makeFile) },
    });

    // The per-file note prompt renders one textarea per picked file, in order.
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Add a note for this file…")).toHaveLength(
        names.length,
      );
    });
    return screen.getAllByPlaceholderText(
      "Add a note for this file…",
    ) as HTMLTextAreaElement[];
  }

  it("pairs a distinct note with each file, skips blank notes, and trims", async () => {
    const names = ["alpha.png", "bravo.png", "charlie.png"];
    const textareas = await openFilesTabAndPick(names);

    // alpha → its own note; bravo → left blank (skip-note path); charlie →
    // padded with whitespace to prove the note is trimmed before sending.
    fireEvent.change(textareas[0], { target: { value: "Note for alpha" } });
    fireEvent.change(textareas[2], { target: { value: "   Note for charlie   " } });

    fireEvent.click(screen.getByRole("button", { name: /Upload 3 files/i }));

    await waitFor(() => {
      expect(attachmentPosts()).toHaveLength(3);
    });

    const posts = attachmentPosts();
    const byFile = (name: string) => posts.find((p) => p.fileName === name)!;

    // alpha: trimmed note bound to its own file + its own storage key.
    expect(byFile("alpha.png").note).toBe("Note for alpha");
    expect(byFile("alpha.png").storageKey).toBe("storage://alpha.png");

    // bravo: blank note → the `note` field must be omitted entirely.
    expect(byFile("bravo.png")).not.toHaveProperty("note");
    expect(byFile("bravo.png").storageKey).toBe("storage://bravo.png");

    // charlie: whitespace-only padding trimmed to the real note.
    expect(byFile("charlie.png").note).toBe("Note for charlie");
    expect(byFile("charlie.png").storageKey).toBe("storage://charlie.png");
  });

  it("sends no note field for any file when all notes are left blank", async () => {
    const names = ["one.png", "two.png"];
    await openFilesTabAndPick(names);

    fireEvent.click(screen.getByRole("button", { name: /Upload 2 files/i }));

    await waitFor(() => {
      expect(attachmentPosts()).toHaveLength(2);
    });

    for (const post of attachmentPosts()) {
      expect(post).not.toHaveProperty("note");
    }
  });

  it("does not misattach a note when only a later file has one", async () => {
    // Regression shape for an off-by-one: only the LAST file carries a note.
    // It must land on that file and no other.
    const names = ["first.png", "second.png", "third.png"];
    const textareas = await openFilesTabAndPick(names);

    fireEvent.change(textareas[2], { target: { value: "third only" } });

    fireEvent.click(screen.getByRole("button", { name: /Upload 3 files/i }));

    await waitFor(() => {
      expect(attachmentPosts()).toHaveLength(3);
    });

    const posts = attachmentPosts();
    const byFile = (name: string) => posts.find((p) => p.fileName === name)!;

    expect(byFile("first.png")).not.toHaveProperty("note");
    expect(byFile("second.png")).not.toHaveProperty("note");
    expect(byFile("third.png").note).toBe("third only");
  });
});
