/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { coerceStatementTemplate } from "@/lib/statement-template";
import { StatementLayoutPanel } from "@/pages/statement-layout-panel";

const apiFetchMock = vi.fn();
const authedMediaFetchMock = vi.fn();
const previewStatementLayoutPdfMock = vi.fn<(options: unknown) => boolean>(() => true);
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  authedMediaFetch: (...args: unknown[]) => authedMediaFetchMock(...args),
}));
vi.mock("@/lib/export", () => ({
  previewStatementLayoutPdf: (options: unknown) => previewStatementLayoutPdfMock(options),
}));

const USER = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  practiceOrganizationId: "lab-1",
  practiceLogoUrl: "https://example.test/protected-logo.png",
};

function renderPanel() {
  const Wrapper = makeAuthWrapper("/settings?tab=statement-layout", {
    user: USER as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  return render(<Wrapper><StatementLayoutPanel /></Wrapper>);
}

describe("statement section manager", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    authedMediaFetchMock.mockReset();
    previewStatementLayoutPdfMock.mockClear();
    authedMediaFetchMock.mockResolvedValue(new Response(
      new Uint8Array([137, 80, 78, 71]),
      { status: 200, headers: { "Content-Type": "image/png" } },
    ));
    const template = coerceStatementTemplate(null);
    apiFetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "PUT") return { data: { template } };
      return { data: { template, isCustom: false, defaultTemplate: template } };
    });
  });

  it("uses a stacked-by-default workspace with a wide-screen column boundary", async () => {
    renderPanel();
    const workspace = await screen.findByTestId("statement-layout-workspace");
    expect(workspace).toHaveClass("grid-cols-1");
    expect(workspace).toHaveClass("2xl:grid-cols-[minmax(0,612px)_minmax(280px,1fr)]");
    expect(screen.getByTestId("statement-layout-settings-rail")).toHaveClass("min-w-0");
  });

  it("prepares the protected logo for header and watermark previews and propagates opacity", async () => {
    renderPanel();
    await waitFor(() => expect(authedMediaFetchMock).toHaveBeenCalledWith(USER.practiceLogoUrl, expect.any(AbortSignal)));

    const previewButton = await screen.findByTestId("button-preview-statement-layout");
    await waitFor(() => expect(previewButton).toBeEnabled());
    expect(screen.getByTestId("statement-logo-header")).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/png;base64,/),
    );
    fireEvent.click(previewButton);
    await waitFor(() => expect(previewStatementLayoutPdfMock).toHaveBeenCalled());
    expect(previewStatementLayoutPdfMock.mock.calls.at(-1)?.[0]).toMatchObject({
      logoUrl: expect.stringMatching(/^data:image\/png;base64,/),
      template: { logo: { mode: "header", opacity: 1 } },
    });

    fireEvent.click(screen.getByLabelText("Watermark (full page)"));
    const opacity = screen.getByRole("slider");
    fireEvent.change(opacity, { target: { value: "0.25" } });
    expect(await screen.findByTestId("statement-logo-watermark")).toHaveStyle({ opacity: "0.25" });
    fireEvent.click(screen.getByTestId("button-preview-statement-layout"));
    await waitFor(() => expect(previewStatementLayoutPdfMock).toHaveBeenCalledTimes(2));
    expect(previewStatementLayoutPdfMock.mock.calls.at(-1)?.[0]).toMatchObject({
      logoUrl: expect.stringMatching(/^data:image\/png;base64,/),
      template: { logo: { mode: "watermark", opacity: 0.25 } },
    });
  });

  it("reports logo-loading failures instead of opening a blank PDF preview", async () => {
    authedMediaFetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    renderPanel();
    expect(await screen.findByTestId("statement-logo-load-error")).toHaveTextContent(
      "Logo preview failed: The lab logo could not be loaded (403).",
    );
    fireEvent.click(screen.getByTestId("button-preview-statement-layout"));
    expect(await screen.findByText("The lab logo could not be loaded (403).")).toBeInTheDocument();
    expect(previewStatementLayoutPdfMock).not.toHaveBeenCalled();
  });

  it("toggles, renames, overrides, copies, and adds sections in the draft", async () => {
    renderPanel();
    const row = await screen.findByTestId("row-section-stmtHeader");
    const checkbox = screen.getByTestId("checkbox-section-visible-stmtHeader");
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    fireEvent.click(row);
    const title = screen.getByTestId("input-section-title-stmtHeader");
    fireEvent.change(title, { target: { value: "Account activity" } });
    fireEvent.click(screen.getByTestId("button-section-mode-custom-stmtHeader"));
    fireEvent.change(screen.getByTestId("textarea-section-content-stmtHeader"), {
      target: { value: "Custom account message" },
    });
    expect(title).toHaveValue("Account activity");
    expect(screen.getByText("Custom account message")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-section-duplicate-stmtHeader"));
    expect(screen.getByDisplayValue(/\(copy\)$/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-add-custom-section"));
    expect(screen.getAllByText("Custom section")).not.toHaveLength(0);
    expect(screen.getByTestId("button-save-statement-layout")).toBeEnabled();
  });

  it("keeps an edited draft after a failed save and lets discard restore it", async () => {
    apiFetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "PUT") throw new Error("Title is required");
      const template = coerceStatementTemplate(null);
      return { data: { template, isCustom: false, defaultTemplate: template } };
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId("row-section-stmtHeader"));
    const title = screen.getByTestId("input-section-title-stmtHeader");
    fireEvent.change(title, { target: { value: "Unsaved title" } });
    fireEvent.click(screen.getByTestId("button-save-statement-layout"));

    expect(await screen.findByText(/Save failed: Title is required/)).toBeInTheDocument();
    expect(screen.getByTestId("input-section-title-stmtHeader")).toHaveValue("Unsaved title");

    fireEvent.click(screen.getByTestId("button-discard-statement-layout"));
    await waitFor(() => expect(screen.queryByTestId("input-section-title-stmtHeader")).not.toBeInTheDocument());
    expect(screen.getAllByText("Statement").length).toBeGreaterThan(0);
  });
});