/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CasePrintLayoutEditor } from "@/components/CasePrintLayoutEditor";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  type CasePrintTemplate,
} from "@/lib/case-print-template";

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch: mockApiFetch,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { practiceOrganizationId: "lab-1", role: "admin" },
  }),
}));

vi.mock("@/lib/print", () => ({
  buildAnatomicalToothChartSvg: () => "<svg />",
  fetchTemplateImageAsDataUrl: vi.fn(),
  printCaseCardAdvanced: vi.fn(),
}));

function customizeTemplate(template: CasePrintTemplate): CasePrintTemplate {
  return {
    ...template,
    elements: template.elements.map((element) =>
      element.kind === "teeth"
        ? { ...element, x: 404 }
        : element.kind === "rxNotes"
          ? { ...element, x: 418, y: 290, w: 300, h: 96 }
          : { ...element },
    ),
  };
}

describe("CasePrintLayoutEditor saved-template state", () => {
  it("adds, hides, and removes opt-in provider preferences", async () => {
    mockApiFetch.mockResolvedValue({
      template: DEFAULT_CASE_PRINT_TEMPLATE,
      isCustom: false,
      defaultTemplate: DEFAULT_CASE_PRINT_TEMPLATE,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CasePrintLayoutEditor onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByText(/Using default layout/);
    fireEvent.click(
      screen.getByRole("button", { name: "+ Add Provider Preferences" }),
    );

    const hideButton = screen.getAllByTitle("Hide").at(-1)!;
    fireEvent.click(hideButton);
    expect(screen.getAllByTitle("Show")).toHaveLength(2);

    fireEvent.click(screen.getByTitle("Remove Provider Preferences"));
    expect(screen.queryByTitle("Remove Provider Preferences")).not.toBeInTheDocument();
  });

  it("replaces the shared Print query with the server-confirmed saved layout", async () => {
    const savedTemplate = customizeTemplate(DEFAULT_CASE_PRINT_TEMPLATE);
    const response = {
      template: savedTemplate,
      isCustom: true,
      defaultTemplate: DEFAULT_CASE_PRINT_TEMPLATE,
    };
    const expectedSaved = {
      ...response,
      template: coerceCasePrintTemplate(savedTemplate),
    };
    mockApiFetch.mockImplementation((_: string, options?: RequestInit) =>
      Promise.resolve(options?.method === "PUT"
        ? response
        : {
            template: DEFAULT_CASE_PRINT_TEMPLATE,
            isCustom: false,
            defaultTemplate: DEFAULT_CASE_PRINT_TEMPLATE,
          }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onTemplateSaved = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <CasePrintLayoutEditor onClose={vi.fn()} onTemplateSaved={onTemplateSaved} />
      </QueryClientProvider>,
    );

    await screen.findByText(/Using default layout/);

    // Hide a field to create a dirty draft. Save must then use the canonical
    // PUT response, not this local visibility change, for the next Print.
    fireEvent.click(screen.getAllByTitle("Hide")[0]);
    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onTemplateSaved).toHaveBeenCalledWith(expectedSaved);
    });

    expect(
      queryClient.getQueryData<typeof expectedSaved>([
        "casePrintTemplate",
        "lab-1",
      ]),
    ).toEqual(expectedSaved);

    const savedRxNotes = expectedSaved.template.elements.find(
      (element) => element.kind === "rxNotes",
    );
    expect(savedRxNotes).toMatchObject({
      x: 418,
      y: 290,
      w: 300,
      h: 96,
    });
  });
});