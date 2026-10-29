import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react-native";
import { CaseHierarchyQuickPicker } from "@/components/CaseHierarchyQuickPicker";
import { setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import { deriveCaseHierarchy } from "@workspace/case-taxonomy";

const catalog: CatalogTreeResult["data"] = { labOrganizationId: "org-1", caseTypes: [{
  key: "restorative", label: "Restorative", subtypes: [{
    key: "crown_and_bridge", label: "Crown & Bridge", id: null,
    isCustom: false, isActive: true, sortOrder: 0, priceKey: null, materials: [
      { key: "zirconia", label: "Zirconia", id: null, isCustom: false, isActive: true, sortOrder: 0, priceKey: null },
    ],
  }],
}] };

describe("view-mode mobile hierarchy", () => {
  beforeEach(() => { resetMockFetchHandler(); });
  afterEach(async () => { await cleanup(); resetMockFetchHandler(); });

  it("immediately persists the empty-case cascade and refreshes without a row-specific request", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    setMockFetchHandler((url, init) => {
      requests.push({ url, body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ data: { invoiceAction: "updated", repricedCount: 0, manualPriceCount: 0, unpricedCount: 0 } }));
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const props = { caseId: "empty-case", catalog, arch: "" as const, refresh };
    const view = await render(<CaseHierarchyQuickPicker {...props} hierarchy={null} empty />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(view.getByTestId("quick-type-restorative"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(requests[0].body).toEqual({ restorationType: "Crown", restorationSubtype: null, material: null, toothNumbers: [] });
    await view.rerender(<CaseHierarchyQuickPicker {...props} empty={false}
      hierarchy={{ caseType: "restorative", subtype: null, materialSubtype: null }} />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-subtype-btn"));
    await fireEvent.press(view.getByTestId("quick-subtype-crown_and_bridge"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(requests[1].body).toEqual({ restorationType: "Crown & Bridge", restorationSubtype: "restorative/crown_and_bridge", material: null });
    await view.rerender(<CaseHierarchyQuickPicker {...props} empty={false}
      hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: null }} />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    await fireEvent.press(view.getByTestId("quick-material-zirconia"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    expect(requests[2].body).toEqual({ restorationType: "Crown & Bridge", restorationSubtype: "restorative/crown_and_bridge/zirconia", material: "Zirconia" });
    expect(requests.map((request) => request.url)).toEqual(Array(3).fill("/api/cases/empty-case/restorations/hierarchy"));
  });

  it("shows refusal, keeps confirmed selections and releases controls for retry", async () => {
    const refresh = vi.fn();
    setMockFetchHandler(() => new Response(JSON.stringify({ error: "Invoice is locked" }), { status: 409 }));
    const view = await render(<CaseHierarchyQuickPicker caseId="locked" catalog={catalog} arch="" empty={false}
      refresh={refresh} hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: "zirconia" }} />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    await fireEvent.press(view.getByTestId("quick-material-none"));
    await waitFor(() => expect(view.getByText(/Invoice is locked/)).toBeTruthy());
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    expect(view.getByTestId("hierarchy-subtype-value")).toHaveTextContent("Crown & Bridge");
    expect(refresh).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    expect(view.getByTestId("quick-material-none")).toBeTruthy();
  });

  it("keeps saved labels through loading, catalog hydration and dismissal without any writes", async () => {
    const request = vi.fn(() => new Response("{}"));
    setMockFetchHandler(request);
    const saved = { restorationType: "Crown", restorationSubtype: "restorative/crown_and_bridge/zirconia", material: "Zirconia" };
    const props = { caseId: "labels", savedValues: saved, hierarchy: deriveCaseHierarchy(saved.restorationType, saved.restorationSubtype, saved.material), arch: "" as const, empty: false, refresh: vi.fn() };
    const view = await render(<CaseHierarchyQuickPicker {...props} />);
    expect(view.getByTestId("hierarchy-subtype-value")).toHaveTextContent("Crown & Bridge");
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    expect(view.getByTestId("hierarchy-edit-material-btn").props.accessibilityState.disabled).toBe(true);
    await view.rerender(<CaseHierarchyQuickPicker {...props} catalog={catalog} />);
    for (const id of ["hierarchy-edit-btn", "hierarchy-edit-subtype-btn", "hierarchy-edit-material-btn"]) {
      await fireEvent.press(view.getByTestId(id));
      expect(view.getByTestId(id).props.accessibilityState.expanded).toBe(true);
      await fireEvent.press(view.getByTestId(id));
      expect(view.getByTestId(id).props.accessibilityState.expanded).toBe(false);
    }
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    await fireEvent.press(view.getByTestId("quick-material-zirconia"));
    await view.rerender(<CaseHierarchyQuickPicker {...props} />);
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    expect(request).not.toHaveBeenCalled();
    expect(props.refresh).not.toHaveBeenCalled();
  });

  it("shows custom and unmapped legacy values even when no catalog options exist", async () => {
    const props = { caseId: "custom", arch: "upper" as const, empty: false, refresh: vi.fn() };
    const custom = { restorationType: "Lab's long custom appliance", restorationSubtype: "removable/custom:appliance/custom:resin", material: "Legacy specialty resin" };
    const view = await render(<CaseHierarchyQuickPicker {...props}
      hierarchy={deriveCaseHierarchy(custom.restorationType, custom.restorationSubtype, custom.material)} savedValues={custom} />);
    expect(view.getByTestId("hierarchy-subtype-value")).toHaveTextContent(custom.restorationType);
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent(custom.material);
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await view.rerender(<CaseHierarchyQuickPicker {...props} hierarchy={null}
      catalog={{ labOrganizationId: "org-1", caseTypes: [] }}
      savedValues={{ restorationType: "Historical appliance", restorationSubtype: "Retired subtype", material: "Old resin" }} />);
    expect(view.getByTestId("hierarchy-casetype-value")).toHaveTextContent("Historical appliance");
    expect(view.getByTestId("hierarchy-subtype-value")).toHaveTextContent("Retired subtype");
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Old resin");
  });

  it("retains the last committed choice when refresh fails, then adopts a real server change", async () => {
    const hierarchy = { caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: null } as const;
    const props = { caseId: "stale", catalog, hierarchy, empty: false, arch: "" as const, refresh: vi.fn().mockRejectedValue(new Error("Offline")) };
    setMockFetchHandler(() => new Response(JSON.stringify({ data: { invoiceAction: "updated", repricedCount: 1 } })));
    const view = await render(<CaseHierarchyQuickPicker {...props} />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    await fireEvent.press(view.getByTestId("quick-material-zirconia"));
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    await view.rerender(<CaseHierarchyQuickPicker {...props} />);
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    setMockFetchHandler(() => new Response(JSON.stringify({ error: "Invoice is locked" }), { status: 409 }));
    await fireEvent.press(view.getByTestId("hierarchy-edit-material-btn"));
    await fireEvent.press(view.getByTestId("quick-material-none"));
    await waitFor(() => expect(view.getByText(/Invoice is locked/)).toBeTruthy());
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    await view.rerender(<CaseHierarchyQuickPicker {...props} hierarchy={{ ...hierarchy, materialSubtype: "zirconia" }} />);
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("Zirconia");
    await view.rerender(<CaseHierarchyQuickPicker {...props} />);
    expect(view.getByTestId("hierarchy-material-value")).toHaveTextContent("—");
  });

  it("waits for required arch confirmation and cancels without replacing the saved type", async () => {
    const request = vi.fn((_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { invoiceAction: "updated" } })));
    setMockFetchHandler(request);
    const view = await render(<CaseHierarchyQuickPicker caseId="arch" catalog={catalog} arch="" empty={false}
      refresh={vi.fn()} hierarchy={{ caseType: "restorative", subtype: "crown_and_bridge", materialSubtype: "zirconia" }} />);
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(view.getByTestId("quick-type-removable"));
    expect(view.getByTestId("hierarchy-casetype-value")).toHaveTextContent("Restorative");
    await fireEvent.press(view.getByTestId("quick-arch-cancel"));
    expect(request).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(view.getByTestId("quick-type-removable"));
    await fireEvent.press(view.getByTestId("quick-arch-both"));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({ restorationType: "Full Denture", arch: "upper_lower" });
  });

  it("uses the same vertical values without edit triggers for read-only and mixed cases", async () => {
    const props = { caseId: "mixed", catalog, hierarchy: null, arch: "" as const, empty: false, mixed: true, canEdit: false, refresh: vi.fn() };
    const view = await render(<CaseHierarchyQuickPicker {...props} />);
    for (const id of ["hierarchy-casetype-value", "hierarchy-subtype-value", "hierarchy-material-value"]) {
      expect(view.getByTestId(id)).toHaveTextContent("Multiple");
    }
    expect(view.queryAllByRole("button")).toHaveLength(0);
    await view.rerender(<CaseHierarchyQuickPicker {...props} empty mixed={false} />);
    for (const id of ["hierarchy-casetype-value", "hierarchy-subtype-value", "hierarchy-material-value"]) {
      expect(view.getByTestId(id)).toHaveTextContent("—");
    }
  });
});
