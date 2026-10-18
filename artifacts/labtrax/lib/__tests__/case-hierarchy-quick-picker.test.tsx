import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react-native";
import { CaseHierarchyQuickPicker } from "@/components/CaseHierarchyQuickPicker";
import { setMockFetchHandler, resetMockFetchHandler } from "../../vitest.setup";
import type { CatalogTreeResult } from "@workspace/api-client-react";

const catalog: CatalogTreeResult["data"] = { labOrganizationId: "org-1", caseTypes: [{
  key: "restorative", label: "Restorative", subtypes: [{
    key: "crown_and_bridge", label: "Crown & Bridge", id: null,
    isCustom: false, isActive: true, sortOrder: 0, priceKey: null, materials: [
      { key: "zirconia", label: "Zirconia", id: null, isCustom: false, isActive: true, sortOrder: 0, priceKey: null },
    ],
  }],
}] };

describe("view-mode mobile hierarchy", () => {
  beforeEach(() => { cleanup(); resetMockFetchHandler(); });

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
});
