/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { AiPanelContext } from "@/lib/ai-panel-context";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { guardNavigation } from "@/lib/nav-guard";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@/components/FieldCombobox", () => ({
  FieldCombobox: ({ value, onChange, placeholder }: {
    value: string; onChange: (value: string) => void; placeholder: string;
  }) => <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock("@/components/ToothChart", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ToothChart")>();
  return { ...real, ToothChart: ({ onToothClick }: { onToothClick?: (id: string) => void }) =>
    <button onClick={() => onToothClick?.("14")}>Chart tooth 14</button> };
});
vi.mock("@/components/ToothActionDialog", () => ({
  ToothActionDialog: ({ onConfirm }: { onConfirm: (payload: unknown) => void }) => (
    <div>
      <button onClick={() => onConfirm({ kind: "add_crown", toothId: "14", restorationType: "Crown", material: "Zirconia", shade: "A1" })}>Stage crown</button>
      <button onClick={() => onConfirm({ kind: "remove_restoration", toothId: "3", restorationId: "row-3" })}>Stage removal</button>
      <button onClick={() => onConfirm({ kind: "replace_tooth", restorationId: "row-4", oldToothId: "4", newToothNumber: "5", shade: "B1" })}>Stage replacement</button>
    </div>
  ),
}));

const initialCase = {
  id: "footer-case",
  caseNumber: "26-777",
  patientFirstName: "Ada",
  patientLastName: "Shade",
  doctorName: "Dr. Byrne",
  status: "received",
  priority: "normal",
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  totalPrice: "0",
  labOrganizationId: "lab-1",
  viewerIsLabMember: true,
  viewerCanManageAttachments: true,
  caseNotes: "Original prescription notes",
  restorations: [],
  attachments: [],
  notes: [],
  events: [],
} as unknown as LabCase;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let detail: LabCase;
const patchCase = vi.fn<(body: Record<string, unknown>) => Promise<Response>>();
const writeRestoration = vi.fn<(path: string, init: RequestInit) => Promise<Response>>();
let refreshDetail: (() => Promise<Response>) | undefined;

beforeEach(() => {
  detail = { ...initialCase };
  refreshDetail = undefined;
  writeRestoration.mockReset();
  writeRestoration.mockImplementation(async () => json({
    invoiceAction: "updated", repricedCount: 0, manualPriceCount: 0, unpricedCount: 0,
  }));
  patchCase.mockReset();
  patchCase.mockImplementation(async (body) => {
    Object.assign(detail, body, { caseNotes: body.rxNotes });
    return json(detail);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
    if (path === `/cases/${detail.id}/tooth-chart` && init?.method === "PATCH") {
      const response = await writeRestoration(path, init);
      const body = JSON.parse(String(init.body));
      if (response.ok && body.caseDetails) await patchCase(body.caseDetails);
      return response;
    }
    if (path === `/cases/${detail.id}`) {
      if (init?.method === "PATCH") return patchCase(JSON.parse(String(init.body)));
      return refreshDetail ? refreshDetail() : json(detail);
    }
    if (path.includes(`/cases/${detail.id}/restorations`) && init?.method) {
      return writeRestoration(path, init);
    }
    return json([]);
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function renderDrawer(docked = false) {
  const onClose = vi.fn();
  const Wrapper = makeAuthWrapper("/cases", {
    user: { id: "admin-1", role: "admin", userType: "lab" } as SessionUser,
    status: "authed",
  });
  const view = render(
    <Wrapper>
      <AiPanelContext.Provider value={{ openPanel: () => {} }}>
        <CaseDrawer labCase={initialCase} onClose={onClose} docked={docked} />
      </AiPanelContext.Provider>
    </Wrapper>,
  );
  await screen.findByTestId("case-details-edit");
  return { ...view, onClose };
}

function enterEdit() {
  fireEvent.click(screen.getByTestId("case-details-edit"));
  return screen.getByTestId("case-edit-action-bar");
}

function editNotes(notes: string) {
  fireEvent.change(screen.getByPlaceholderText("Prescription notes…"), {
    target: { value: notes },
  });
}

async function stageManualRestoration() {
  fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
  fireEvent.change(await screen.findByPlaceholderText("Case Type…"), { target: { value: "Crown" } });
  fireEvent.change(screen.getByPlaceholderText(/Material…|Legacy\/free text material/), { target: { value: "Zirconia" } });
  fireEvent.change(screen.getByPlaceholderText("e.g. 14 or 14-16"), { target: { value: "18" } });
  fireEvent.click(screen.getByRole("button", { name: "Add restoration" }));
}

describe("Case drawer pinned edit actions", () => {
  it.each([{ docked: false }, { docked: true }])(
    "puts Case Details and Rx Notes actions below, not inside, the scroll pane (docked=$docked)",
    async ({ docked }) => {
      await renderDrawer(docked);
      expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
      const footer = enterEdit();
      const body = screen.getByTestId("case-detail-body");
      expect(body.parentElement).toBe(footer.parentElement);
      expect(body.nextElementSibling).toBe(footer);
      expect(body).toHaveClass("min-h-0", "overflow-y-auto");
      expect(footer).toHaveClass("shrink-0", "border-t", "bg-card");
      expect(footer).toHaveClass("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
      expect(body).toContainElement(screen.getByPlaceholderText("Prescription notes…"));
      expect(within(body).queryByTestId("case-details-edit-save")).not.toBeInTheDocument();
      expect(within(footer).getByRole("button", { name: "Save changes" })).toBeEnabled();
      expect(within(footer).getByRole("button", { name: "Cancel" })).toBeEnabled();
    },
  );

  it("wraps the pending-change notice and keeps both actions independently sized", async () => {
    await renderDrawer();
    await stageManualRestoration();

    const pending = screen.getByTestId("case-pending-actions");
    expect(pending).toHaveClass("flex", "flex-wrap", "items-center");
    expect(within(pending).getByText("Unsaved changes")).toBeInTheDocument();
    expect(within(pending).getByTestId("case-pending-discard")).toHaveClass("min-w-[4.5rem]");
    expect(within(pending).getByTestId("case-pending-save")).toHaveClass("min-w-[6.25rem]");
    expect(within(pending).getByTestId("case-pending-discard")).toBeEnabled();
    expect(within(pending).getByTestId("case-pending-save")).toBeEnabled();
  });

  it("cancel removes the bar and abandons changes to both case fields and Rx Notes", async () => {
    await renderDrawer();
    enterEdit();
    fireEvent.change(screen.getByDisplayValue("Ada"), { target: { value: "Grace" } });
    editNotes("Abandoned draft");
    fireEvent.click(screen.getByTestId("case-details-edit-cancel"));
    expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
    expect(patchCase).not.toHaveBeenCalled();
    enterEdit();
    expect(screen.getByDisplayValue("Ada")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Prescription notes…")).toHaveValue(initialCase.caseNotes);
  });

  it("saves on the first press and keeps the editor open and disabled until success", async () => {
    const { onClose } = await renderDrawer();
    enterEdit();
    fireEvent.change(screen.getByDisplayValue("Ada"), { target: { value: "Grace" } });
    editNotes("Updated prescription");
    let finish!: (value: Response) => void;
    patchCase.mockImplementationOnce((body) => new Promise((resolve) => {
      Object.assign(detail, body, { caseNotes: body.rxNotes });
      finish = resolve;
    }));
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(patchCase).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("case-details-edit-save")).toBeDisabled();
    expect(screen.getByTestId("case-details-edit-save")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("case-details-edit-cancel")).toBeDisabled();
    expect(screen.getByPlaceholderText("Prescription notes…")).toHaveValue("Updated prescription");
    expect(screen.queryByTestId("case-pending-actions")).not.toBeInTheDocument();
    expect(patchCase.mock.calls[0][0]).toMatchObject({
      patientFirstName: "Grace", rxNotes: "Updated prescription",
    });
    finish(json(detail));
    await waitFor(() => expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Rx Notes" })).getByText("Updated prescription")).toBeInTheDocument();
    expect(guardNavigation(vi.fn())).toBe(false);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close case drawer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });

  it("keeps a failed save open with the draft and server error available for retry", async () => {
    await renderDrawer();
    enterEdit();
    editNotes("Retry this prescription");
    patchCase.mockResolvedValueOnce(json({ error: "Case is locked for billing" }, 409));
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    const footer = screen.getByTestId("case-edit-action-bar");
    await waitFor(() => expect(within(footer).getByRole("alert")).toHaveTextContent("Case is locked for billing"));
    await waitFor(() => expect(screen.getByTestId("case-details-edit-save")).toBeEnabled());
    expect(screen.getByTestId("case-details-edit-cancel")).toBeEnabled();
    expect(screen.getByPlaceholderText("Prescription notes…")).toHaveValue("Retry this prescription");
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument());
    expect(patchCase).toHaveBeenCalledTimes(2);
  });

  it("closes the unstaged editor and restores the content space when leaving the Lab Slip tab", async () => {
    await renderDrawer();
    enterEdit();
    editNotes("Unstaged notes");
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    expect(screen.queryByPlaceholderText("Prescription notes…")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-details-edit")).toBeInTheDocument();
    expect(patchCase).not.toHaveBeenCalled();
  });

  it("keeps earlier staged actions reachable during another edit and across tabs until discarded", async () => {
    const view = await renderDrawer();
    await stageManualRestoration();
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    enterEdit();
    const footer = screen.getByTestId("case-edit-action-bar");
    expect(within(footer).getByTestId("case-details-edit-actions")).toBeInTheDocument();
    expect(within(footer).queryByTestId("case-pending-actions")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-details-edit-cancel"));
    expect(screen.queryByTestId("case-details-edit-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-pending-actions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByTestId("case-pending-actions")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("case-pending-discard"));
    expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
    expect(patchCase).not.toHaveBeenCalled();
    view.unmount();
    expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
  });

  it.each([{ docked: false }, { docked: true }])("pins manual restoration actions outside the scroll pane (docked=$docked)", async ({ docked }) => {
    await renderDrawer(docked);
    fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
    const footer = screen.getByTestId("case-edit-action-bar");
    expect(screen.getByTestId("case-detail-body").nextElementSibling).toBe(footer);
    expect(within(footer).getByRole("button", { name: "Add restoration" })).toBeInTheDocument();
    expect(within(screen.getByTestId("case-detail-body")).queryByText("Add restoration")).not.toBeInTheDocument();
    fireEvent.click(within(footer).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument();
    await stageManualRestoration();
    expect(screen.queryByTestId("case-restoration-edit-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("case-pending-actions")).toBeInTheDocument();
    expect(writeRestoration).not.toHaveBeenCalled();
  });

  it("keeps the editor open until refreshed values arrive, without reverting to the original notes", async () => {
    await renderDrawer();
    enterEdit();
    editNotes("Confirmed prescription");
    let finish!: (response: Response) => void;
    refreshDetail = () => new Promise((resolve) => { finish = resolve; });
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(patchCase).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByPlaceholderText("Prescription notes…")).toHaveValue("Confirmed prescription");
    expect(screen.getByTestId("case-details-edit-save")).toBeDisabled();
    refreshDetail = undefined;
    finish(json(detail));
    await waitFor(() => expect(screen.queryByTestId("case-details-edit-save")).not.toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Rx Notes" })).getByText("Confirmed prescription")).toBeInTheDocument();
  });

  it("commits manual rows and every chart staging path along with a clinical edit on one press", async () => {
    detail = { ...detail, restorations: [
      { id: "row-3", toothNumber: "3", restorationType: "Crown", material: "Zirconia" },
      { id: "row-4", toothNumber: "4", restorationType: "Crown", material: "Zirconia" },
    ] } as unknown as LabCase;
    await renderDrawer();
    await stageManualRestoration();
    for (const action of ["Stage crown", "Stage removal", "Stage replacement"]) {
      fireEvent.click(screen.getByRole("button", { name: "Chart tooth 14" }));
      fireEvent.click(screen.getByRole("button", { name: action }));
    }
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    enterEdit();
    editNotes("Everything together");
    fireEvent.change(screen.getByLabelText("Tooth Numbers"), { target: { value: "3, 4" } });
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument());
    expect(patchCase).toHaveBeenCalledTimes(1);
    expect(writeRestoration.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      [`/cases/${detail.id}/tooth-chart`, "PATCH"],
    ]);
    const committed = JSON.parse(String(writeRestoration.mock.calls[0][1].body));
    expect(committed.caseDetails.rxNotes).toBe("Everything together");
    expect(committed.deletes).toEqual(["row-3"]);
    expect(committed.updates).toEqual([expect.objectContaining({ restorationId: "row-4", toothNumber: "5", shade: "B1" })]);
    expect(committed.creates.map((row: { toothNumber: string }) => row.toothNumber)).toEqual(["18", "14"]);
    expect(guardNavigation(vi.fn())).toBe(false);
  });

  it("retries a refused atomic bundle with stable IDs without partially committing clinical details", async () => {
    await renderDrawer();
    await stageManualRestoration();
    fireEvent.click(screen.getByRole("button", { name: "Chart tooth 14" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage crown" }));
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    enterEdit();
    fireEvent.change(screen.getByLabelText("Tooth Numbers"), { target: { value: "6" } });
    writeRestoration.mockResolvedValueOnce(json({ error: "Try again" }, 503)).mockResolvedValueOnce(json({}));
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again"));
    await waitFor(() => expect(screen.getByTestId("case-details-edit-save")).toBeEnabled());
    expect(patchCase).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Tooth Numbers")).toHaveValue("6");
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument());
    expect(writeRestoration).toHaveBeenCalledTimes(2);
    const bundles = writeRestoration.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bundles[0].creates.map((row: { toothNumber: string }) => row.toothNumber)).toEqual(["18", "14"]);
    expect(bundles[1]).toEqual(bundles[0]);
    await waitFor(() => expect(guardNavigation(vi.fn())).toBe(false));
  });

  it("keeps chart replacement IDs alive and consumes removals already made by tooth reconciliation", async () => {
    detail = { ...detail, restorations: [
      { id: "row-3", toothNumber: "3", restorationType: "Crown", material: "Zirconia" },
      { id: "row-4", toothNumber: "4", restorationType: "Crown", material: "Zirconia" },
    ] } as unknown as LabCase;
    await renderDrawer();
    fireEvent.click(screen.getByRole("tab", { name: /Restorations/ }));
    for (const action of ["Stage removal", "Stage replacement"]) {
      fireEvent.click(screen.getByRole("button", { name: "Chart tooth 14" }));
      fireEvent.click(screen.getByRole("button", { name: action }));
    }
    fireEvent.click(screen.getByRole("tab", { name: "Lab Slip" }));
    enterEdit();
    fireEvent.change(screen.getByLabelText("Tooth Numbers"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("case-details-edit-save"));
    await waitFor(() => expect(screen.queryByTestId("case-edit-action-bar")).not.toBeInTheDocument());
    const bundle = JSON.parse(String(writeRestoration.mock.calls[0][1].body));
    expect(bundle.hierarchy.toothNumbers).toEqual(["3"]);
    expect(bundle.deletes).toEqual(["row-3"]);
    expect(bundle.updates).toEqual([expect.objectContaining({ restorationId: "row-4", toothNumber: "5" })]);
    expect(writeRestoration.mock.calls.map(([path]) => path)).toEqual([
      `/cases/${detail.id}/tooth-chart`,
    ]);
  });
});
