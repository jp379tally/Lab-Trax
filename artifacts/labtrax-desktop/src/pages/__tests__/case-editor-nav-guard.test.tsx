/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CaseDrawer } from "@/pages/cases";
import { guardNavigation } from "@/lib/nav-guard";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

// jspdf and react-pdf pull in heavy/non-jsdom-friendly modules at import time.
// The nav-guard flow never touches PDF code, but the imports load at module
// time and are not jsdom-friendly.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

const fakeCase: LabCase = {
  id: "case-1",
  caseNumber: "26-1",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  doctorName: "Dr. Smith",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: new Date("2026-01-15T10:00:00Z").toISOString(),
  updatedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
  totalPrice: "0",
} as unknown as LabCase;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Case detail endpoint — return the full case so edit-mode fields are
      // populated (startEdit reads from this query's data, falling back to the
      // labCase prop only until it resolves).
      if (url.includes(`/cases/${fakeCase.id}`) && !url.includes("remake")) {
        return new Response(JSON.stringify(fakeCase), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.includes("/cases") ||
        url.includes("/organizations") ||
        url.includes("/finance/vendors") ||
        url.includes("/presets")
      ) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDrawer() {
  const onClose = vi.fn();
  const Wrapper = makeAuthWrapper("/cases");
  const view = render(
    <Wrapper>
      {withAiPanel(
        <CaseDrawer
          labCase={fakeCase}
          onClose={onClose}
          doctorNames={["Dr. Smith", "Dr. Jones"]}
        />,
      )}
    </Wrapper>,
  );
  return { onClose, view };
}

// Stage an unsaved edit by entering edit mode, changing the doctor field, and
// applying it to the drawer's pending-changes state.
async function makeDirty() {
  fireEvent.click(await screen.findByRole("button", { name: /Edit/i }));
  // Doctor field is now a DoctorNamePicker (button + dropdown)
  const doctorPicker = await screen.findByRole("button", { name: /Dr\. Smith/i });
  fireEvent.click(doctorPicker);
  const drJones = await screen.findByRole("button", { name: /Dr\. Jones/i });
  fireEvent.click(drJones);
  fireEvent.click(await screen.findByRole("button", { name: /Save changes/i }));
}

describe("CaseDrawer navigation guard", () => {
  it("does not block navigation when there are no unsaved edits", async () => {
    renderDrawer();
    await waitFor(() =>
      expect(screen.getAllByText(/Jane/).length).toBeGreaterThan(0),
    );

    const proceed = vi.fn();
    // No blocker registered → guardNavigation lets the navigation proceed.
    expect(guardNavigation(proceed)).toBe(false);
    expect(
      screen.queryByRole("heading", { name: "Unsaved changes" }),
    ).not.toBeInTheDocument();
  });

  it("intercepts navigation and prompts to discard when there are unsaved edits", async () => {
    renderDrawer();
    await makeDirty();

    const proceed = vi.fn();
    let blocked = false;
    await waitFor(() => {
      blocked = guardNavigation(proceed);
      expect(blocked).toBe(true);
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Unsaved changes" }),
    ).toBeInTheDocument();
  });

  it("'Keep editing' cancels the deferred navigation", async () => {
    renderDrawer();
    await makeDirty();

    const proceed = vi.fn();
    await waitFor(() => expect(guardNavigation(proceed)).toBe(true));
    fireEvent.click(screen.getByText("Keep editing"));

    expect(proceed).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Unsaved changes" }),
    ).not.toBeInTheDocument();
  });

  it("'Discard changes' proceeds with the deferred navigation", async () => {
    renderDrawer();
    await makeDirty();

    const proceed = vi.fn();
    await waitFor(() => expect(guardNavigation(proceed)).toBe(true));
    fireEvent.click(screen.getByText("Discard changes"));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Unsaved changes" }),
    ).not.toBeInTheDocument();
  });

  it("warns via beforeunload only while there are unsaved edits", async () => {
    renderDrawer();
    await waitFor(() =>
      expect(screen.getAllByText(/Jane/).length).toBeGreaterThan(0),
    );

    // Clean form: beforeunload is not cancelled.
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await makeDirty();
    // Dirty form: the handler cancels the unload to trigger the native warning.
    await waitFor(() => {
      const dirtyEvent = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(dirtyEvent);
      expect(dirtyEvent.defaultPrevented).toBe(true);
    });
  });

  it("stops blocking navigation once the drawer unmounts", async () => {
    const { view } = renderDrawer();
    await makeDirty();

    await waitFor(() => expect(guardNavigation(vi.fn())).toBe(true));
    fireEvent.click(screen.getByText("Keep editing"));

    view.unmount();

    // With the drawer gone, the blocker is cleared and navigation proceeds.
    expect(guardNavigation(vi.fn())).toBe(false);
  });
});
