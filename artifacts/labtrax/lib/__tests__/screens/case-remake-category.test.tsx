import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import CaseDetailScreen from "@/app/case/[id]";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
} from "../../../vitest.setup";
import { inProgressCase } from "./__fixtures__/cases";

const existing = {
  ...inProgressCase,
  id: "remake-category-case",
  labOrganizationId: "remake-category-lab",
  remakeOriginal: { id: "original-case", caseNumber: "4999" },
  remakeReasonKey: "shade_wrong",
  remakeReason: "Shade was wrong",
  remakeCategory: "crown_bridge",
  remakeCharged: false,
};

beforeEach(() => {
  setMockSearchParams({ id: existing.id });
  setMockAppState({
    cases: [existing], invoices: [],
    meMemberships: [{ organizationId: existing.labOrganizationId, role: "admin", status: "active" }],
  });
});

afterEach(async () => {
  await cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("case remake category follows the shared catalogue, not picker grouping", () => {
  for (const mode of ["edit", "create"] as const) {
    it.each([
      { key: "other", category: null },
      { key: "shade_wrong", category: "crown_bridge" },
      { key: "denture_tissue_color", category: "removable" },
    ])(`${mode}: saves $key without inferring a category from its display group`, async ({ key, category }) => {
      let sent: Record<string, unknown> | undefined;
      const method = mode === "edit" ? "PATCH" : "POST";
      const url = `/api/cases/${existing.id}${mode === "create" ? "/remake" : ""}`;
      setMockFetchHandler(async (requestUrl, init) => {
        if (requestUrl === url && init?.method === method) {
          sent = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ data: { ...existing, id: "new-remake" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: existing }), { status: 200 });
      });
      const screen = await render(<CaseDetailScreen />);
      await fireEvent.press(screen.getByTestId("section-tab-overview"));
      if (mode === "edit") await fireEvent.press(screen.getByLabelText("Edit remake reason"));
      else await fireEvent.press(screen.getByTestId("case-remake-btn"));
      await fireEvent.press(screen.getByTestId(`remake-reason-${key}${mode === "edit" ? "-edit" : ""}`));
      if (key === "other") {
        await fireEvent.changeText(
          screen.getByTestId(`${mode === "edit" ? "edit" : "create"}-remake-custom-reason`),
          "  Open distal margin  ",
        );
      }
      if (mode === "create") await fireEvent.press(screen.getAllByText("No charge").at(-1)!);
      await fireEvent.press(screen.getAllByText(mode === "edit" ? "Save Changes" : "Create Remake").at(-1)!);
      await waitFor(() => expect(sent?.remakeReasonKey).toBe(key));
      // PATCH must explicitly clear the former category. POST's schema allows
      // an omitted category, not null; the API then infers Other as unset.
      expect(sent?.remakeCategory).toBe(category === null && mode === "create" ? undefined : category);
      if (key === "other") expect(sent?.remakeReason).toBe("Open distal margin");
    });
  }
});

describe("mobile remake creation response handling", () => {
  async function openCreateRemake() {
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("case-remake-btn"));
    await fireEvent.press(screen.getByTestId("remake-reason-shade_wrong"));
    await fireEvent.press(screen.getAllByText("No charge").at(-1)!);
    return screen;
  }

  it("decodes the created case response, closes the form, and navigates to the remake", async () => {
    setMockFetchHandler(async (url, init) => {
      if (url === `/api/cases/${existing.id}/remake` && init?.method === "POST") {
        return new Response(
          JSON.stringify({ data: { id: "created-remake", caseNumber: "4999B" } }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ data: existing }), { status: 200 });
    });
    const screen = await openCreateRemake();

    await fireEvent.press(screen.getByTestId("case-remake-submit"));

    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/case/created-remake"),
    );
  });

  it("shows a server error and keeps the create form open", async () => {
    setMockFetchHandler(async (url, init) => {
      if (url === `/api/cases/${existing.id}/remake` && init?.method === "POST") {
        return new Response(
          JSON.stringify({ message: "Remake permission is required." }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify({ data: existing }), { status: 200 });
    });
    const screen = await openCreateRemake();

    await fireEvent.press(screen.getByTestId("case-remake-submit"));

    await waitFor(() =>
      expect(screen.getByText("Remake permission is required.")).toBeTruthy(),
    );
    expect(screen.getByTestId("case-remake-submit")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalledWith(expect.stringMatching(/^\/case\/created-remake/));
  });

  it("allows only one in-flight create when submit is tapped repeatedly", async () => {
    let finishRequest!: (response: Response) => void;
    let submitCount = 0;
    setMockFetchHandler(async (url, init) => {
      if (url === `/api/cases/${existing.id}/remake` && init?.method === "POST") {
        submitCount += 1;
        return await new Promise<Response>((resolve) => {
          finishRequest = resolve;
        });
      }
      return new Response(JSON.stringify({ data: existing }), { status: 200 });
    });
    const screen = await openCreateRemake();

    await fireEvent.press(screen.getByTestId("case-remake-submit"));
    expect(screen.getByTestId("case-remake-submit").props.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId("case-remake-submit"));

    expect(submitCount).toBe(1);
    finishRequest(
      new Response(
        JSON.stringify({ data: { id: "created-remake", caseNumber: "4999B" } }),
        { status: 201 },
      ),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/case/created-remake"));
  });
});
