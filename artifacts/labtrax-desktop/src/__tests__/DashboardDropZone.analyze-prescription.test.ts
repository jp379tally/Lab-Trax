/**
 * @vitest-environment jsdom
 *
 * Regression guard: DashboardDropZone must call /analyze-prescription (not any
 * other AI endpoint) so the desktop drag-and-drop path stays in sync with the
 * mobile Scan tab.
 *
 * Two layers of coverage:
 *
 *   Static  — source-text assertions that fail immediately if the endpoint is
 *             renamed or the imageBase64 field is removed.
 *
 *   Runtime — renders the component with mocked dependencies, submits a JPEG
 *             via the file input, and asserts apiFetch is called with
 *             "/analyze-prescription" and a body containing "imageBase64".
 *             This exercises the actual handleFileInput → handleFiles →
 *             runRxAnalyze → apiFetch execution path, not just source text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import { makeAuthWrapper } from "./test-utils";
import type { SessionUser } from "@/lib/api";

// ── Module-level mocks (vi.mock is hoisted before imports) ────────────────────

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
  createUploadSession: vi.fn().mockResolvedValue({ sessionId: "s1", uploadUrl: "http://x" }),
  sendUploadChunk: vi.fn().mockResolvedValue({ finished: true }),
  ApiError: class extends Error {},
}));

vi.mock("@/lib/format", () => ({
  formatPhone: (s: string) => s,
}));

vi.mock("lucide-react", () => {
  const N = () => null;
  return {
    AlertTriangle: N,
    CheckCircle2: N,
    FileText: N,
    Loader2: N,
    PackageOpen: N,
    Sparkles: N,
    Upload: N,
    X: N,
  };
});

vi.mock("jszip", () => ({
  default: class {
    async loadAsync() { return this; }
    files: Record<string, unknown> = {};
  },
}));

vi.mock("@/components/DoctorNamePicker", () => ({
  DoctorNamePicker: () => null,
}));

import { DashboardDropZone } from "@/components/DashboardDropZone";

const PRESCRIPTION_TEST_USER = {
  id: "u1",
  username: "testuser",
  labOrganizationId: null,
} as unknown as SessionUser;

// ── Static regression guards ──────────────────────────────────────────────────

describe("DashboardDropZone — /analyze-prescription endpoint wiring (static)", () => {
  it("references /analyze-prescription in the component source", () => {
    const src = path.resolve(
      __dirname,
      "../components/DashboardDropZone.tsx"
    );
    const content = fs.readFileSync(src, "utf-8");
    expect(
      content,
      "DashboardDropZone must call /analyze-prescription; the endpoint was renamed or removed"
    ).toContain("/analyze-prescription");
  });

  it("does NOT hardcode a legacy endpoint (/analyze-rx, /parse-rx, /rx-analyze)", () => {
    const src = path.resolve(
      __dirname,
      "../components/DashboardDropZone.tsx"
    );
    const content = fs.readFileSync(src, "utf-8");
    for (const legacy of ["/analyze-rx", "/parse-rx", "/rx-analyze"]) {
      expect(
        content,
        `DashboardDropZone must not reference legacy endpoint ${legacy}`
      ).not.toContain(legacy);
    }
  });

  it("sends imageBase64 (not formData or file) to match the mobile Scan tab contract", () => {
    const src = path.resolve(
      __dirname,
      "../components/DashboardDropZone.tsx"
    );
    const content = fs.readFileSync(src, "utf-8");
    expect(content, "DashboardDropZone must send imageBase64 field").toContain(
      "imageBase64"
    );
  });
});

// ── Runtime behavioral test ───────────────────────────────────────────────────

describe("DashboardDropZone — /analyze-prescription call behavior (runtime)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    // Default: return empty lists for startup queries (/legacy/cases, /organizations)
    // and a valid AI result for the analyze call.
    mockApiFetch.mockImplementation(async (endpointPath: string) => {
      if (endpointPath === "/legacy/cases") return { cases: [] };
      if (endpointPath === "/organizations") return [];
      if (endpointPath === "/cases/doctor-names") return [];
      if (endpointPath === "/analyze-prescription") {
        return {
          doctorName: "Dr. Runtime",
          patientName: "Runtime Patient",
          confidence: 0.9,
        };
      }
      return {};
    });
  });

  it("calls /analyze-prescription with imageBase64 when a JPEG file is submitted via the file input", async () => {
    const Wrapper = makeAuthWrapper("/", {
      user: PRESCRIPTION_TEST_USER,
      status: "authed",
    });
    const { container } = render(
      React.createElement(Wrapper, null,
        React.createElement(DashboardDropZone, null)
      )
    );

    // The component renders a hidden <input type="file" aria-label="Upload files">.
    const input = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(input, "DashboardDropZone must render an <input type=file>").not.toBeNull();

    // Create a fake JPEG file (type triggers the isImage() path → runRxAnalyze).
    const file = new File(["fake-jpeg-content"], "prescription.jpg", {
      type: "image/jpeg",
    });

    // jsdom does not allow setting input.files through direct assignment;
    // override the property so handleFileInput sees our file via e.target.files.
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: Object.assign(Object.create(null), {
        0: file,
        length: 1,
        item: (i: number) => (i === 0 ? file : null),
        [Symbol.iterator]: function* () {
          yield file;
        },
      }),
    });

    // Fire the change event — React routes it through handleFileInput →
    // handleFiles → runRxAnalyze → fileToDataUrl → apiFetch.
    act(() => {
      fireEvent.change(input!);
    });

    // Wait for the async chain: FileReader.readAsDataURL → apiFetch call.
    await waitFor(
      () => {
        const analyzeCall = mockApiFetch.mock.calls.find(
          ([endpoint]: [string]) => endpoint === "/analyze-prescription"
        );
        expect(
          analyzeCall,
          "apiFetch('/analyze-prescription', ...) must be called when a JPEG is submitted"
        ).not.toBeUndefined();

        const opts = analyzeCall![1] as { method?: string; body?: string };
        expect(opts.method, "must use POST").toBe("POST");
        expect(opts.body, "request body must contain imageBase64 field").toContain(
          '"imageBase64"'
        );
      },
      { timeout: 5000 }
    );
  });
});
