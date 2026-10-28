import React from "react";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "@playwright/test";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderScreen,
  waitFor,
  within,
} from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
  mockUpdateCaseMutateAsync,
  mockAddCaseNoteMutateAsync,
  mockDeleteAttachmentMutateAsync,
  mockUpdateCaseRestorationMutateAsync,
  mockGenerateInvoiceForCaseMutateAsync,
  mockInvalidateQueries,
  mockMergeDoctorsMutate,
  mockSearchDoctors,
  mockGetCaseDoctorCandidates,
  mockReassignCaseDoctorMutateAsync,
  flushPendingReactUpdates,
} from "../../../vitest.setup";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";

import { Alert, StyleSheet } from "react-native";
import { Spacing } from "@/constants/tokens";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resilientFetch } from "@/lib/query-client";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import { acquireAuthedMediaUri, getAuthedMediaUri } from "@/lib/authed-media-cache";
import {
  migratedLegacyPhotoContract,
  migratedLegacyVideoContract,
} from "@workspace/legacy-case-media-contract";
import { createVideoThumbnail } from "react-native-compressor";
import { clearVideoThumbnailCacheForTests } from "@/lib/video-thumbnail";
import { prepareVideoForUpload } from "@/lib/prepare-video-upload";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import {
  peekSharedFiles,
  pushSharedFile,
} from "@/lib/shared-file-inbox";
import {
  isMockKeyboardVisible,
  showMockKeyboard,
} from "../../../vitest.setup";

vi.mock("@/lib/prepare-video-upload", () => ({
  prepareVideoForUpload: vi.fn(),
}));
vi.mock("@/lib/uploadCaseAttachment", () => ({
  uploadCaseAttachment: vi.fn(async () => ({ ok: true, attachment: null })),
}));

const mockUploadCaseAttachment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uploadCaseAttachment", () => ({
  uploadCaseAttachment: mockUploadCaseAttachment,
}));

import CaseDetailScreen from "@/app/case/[id]";
import FinancialHubScreen from "@/app/(tabs)/financial";
import InvoicesScreen from "@/app/finance/invoices";
import StatementsScreen from "@/app/finance/statements";
import {
  caseWithInvoiceEventHistory,
  caseWithNoteHistory,
  completedCaseWithInvoice,
  inProgressCase,
  invoiceWithUnpricedAlloySub,
  pfmCaseWithUnpricedAlloyInvoice,
  removableCaseNoHierarchy,
  removableCaseNoStep,
  removableCaseProcessStep,
  removableCaseWaxSetup,
  sampleInvoice,
} from "./__fixtures__/cases";
import { locationsOnlyHandler } from "./__fixtures__/locations";

type FinanceNavigationStage = "case" | "hub" | "statements" | "invoices";
const sharedQueryClientImplementation = vi.mocked(useQueryClient).getMockImplementation()!;

// These existing editing/layout scenarios exercise the Lab Slip (Overview).
// Select it explicitly; opening defaults have their own focused suite.
async function render(component: React.ReactElement) {
  const screen = await renderScreen(component);
  const overview = screen.queryByTestId("section-tab-overview");
  if (overview) await fireEvent.press(overview);
  return screen;
}

function FinanceNavigationHarness({
  stage,
}: {
  stage: FinanceNavigationStage;
}) {
  if (stage === "case") return <CaseDetailScreen />;
  if (stage === "hub") return <FinancialHubScreen />;
  if (stage === "statements") return <StatementsScreen />;
  return <InvoicesScreen />;
}

const it = (
  name: string,
  testFn: () => void | Promise<void>,
  timeout?: number,
): void => {
  vitestIt(
    name,
    async () => {
      await testFn();
      await flushPendingReactUpdates();
    },
    timeout,
  );
};

type CaseActionLayoutItem = {
  testID: string;
  label: string;
  accessibilityLabel: string;
  buttonStyle: Record<string, unknown>;
  textStyle: Record<string, unknown>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssLength(value: unknown): string {
  return typeof value === "number" ? `${value}px` : String(value ?? "0px");
}

function caseActionLayoutHtml(
  rowStyle: Record<string, unknown>,
  bodyPadding: number,
  buttons: CaseActionLayoutItem[],
): string {
  const rowCss = [
    "display:flex",
    `flex-direction:${String(rowStyle.flexDirection ?? "row")}`,
    `flex-wrap:${String(rowStyle.flexWrap ?? "nowrap")}`,
    `align-items:${String(rowStyle.alignItems ?? "stretch")}`,
    `gap:${cssLength(rowStyle.gap)}`,
    "align-content:flex-start",
    "width:100%",
  ].join(";");
  const buttonHtml = buttons
    .map((button) => {
      const style = button.buttonStyle;
      const fontFamily = String(button.textStyle.fontFamily ?? "");
      const textWeight =
        /(?:600|700)/.test(fontFamily) || button.textStyle.fontWeight === "bold"
          ? "600"
          : "400";
      const buttonCss = [
        "appearance:none",
        "box-sizing:border-box",
        "display:flex",
        "flex:0 0 auto",
        `flex-direction:${String(style.flexDirection ?? "row")}`,
        `align-items:${String(style.alignItems ?? "center")}`,
        `justify-content:${String(style.justifyContent ?? "center")}`,
        `gap:${cssLength(style.gap)}`,
        `min-height:${cssLength(style.minHeight)}`,
        `padding:${cssLength(style.paddingVertical)} ${cssLength(style.paddingHorizontal)}`,
        `border:${cssLength(style.borderWidth)} solid ${String(style.borderColor ?? "transparent")}`,
        `border-radius:${cssLength(style.borderRadius)}`,
        `background-color:${String(style.backgroundColor ?? "transparent")}`,
        "font:inherit",
        "white-space:nowrap",
      ].join(";");
      const textCss = [
        "display:inline-block",
        `font-size:${cssLength(button.textStyle.fontSize)}`,
        `line-height:${cssLength(button.textStyle.lineHeight)}`,
        `font-weight:${textWeight}`,
        "font-family:Arial,sans-serif",
        `letter-spacing:${cssLength(button.textStyle.letterSpacing)}`,
        `color:${String(button.textStyle.color ?? "inherit")}`,
        "white-space:nowrap",
      ].join(";");
      return `<button data-action-button="${escapeHtml(button.testID)}" role="button" aria-label="${escapeHtml(button.accessibilityLabel)}" style="${buttonCss}"><span aria-hidden="true" style="width:14px;height:14px;flex:0 0 14px"></span><span class="action-label" style="${textCss}">${escapeHtml(button.label)}</span></button>`;
    })
    .join("");

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;width:100%;font-family:Arial,sans-serif}#screen{box-sizing:border-box;width:100%;padding:0 ${bodyPadding}px}#action-row{${rowCss}}</style></head><body><main id="screen"><div id="action-row">${buttonHtml}</div></main></body></html>`;
}

function resolveChromiumExecutable(): string | undefined {
  const configuredPath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];
  if (configuredPath) return configuredPath;
  if (!process.env["REPL_ID"]) return undefined;
  return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
}

afterEach(async () => {
  await flushPendingReactUpdates();
  clearVideoThumbnailCacheForTests();
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CaseDetailScreen (read-only viewer)", () => {
  describe("when the case id does not match anything", () => {
    beforeEach(() => {
      setMockSearchParams({ id: "nonexistent-case-id" });
    });

    it("renders without throwing", async () => {
      await expect(render(<CaseDetailScreen />)).resolves.toBeDefined();
    });

    it("renders the unable-to-load empty state", async () => {
      const { getByText } = await render(<CaseDetailScreen />);
      expect(getByText("Unable to load this case")).toBeTruthy();
    });
  });

  describe("with a normal in-progress case", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({ cases: [inProgressCase], invoices: [] });
    });

    it("renders without throwing", async () => {
      await expect(render(<CaseDetailScreen />)).resolves.toBeDefined();
    });

    it("keeps the vertical scroll owner outside the keyboard tap responder and preserves section controls", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      const body = getByTestId("case-detail-body");
      const dismissContent = getByTestId("case-detail-keyboard-dismiss");

      // The ScrollView must be a sibling of the horizontal tabs, not a
      // descendant of the full-screen TouchableWithoutFeedback. The
      // dismiss-on-tap layer belongs *inside* the scroll owner.
      expect(body.parent?.type).toBe("View");
      expect(within(body).getByTestId("case-detail-keyboard-dismiss")).toBe(dismissContent);
      expect(body.props.horizontal).toBeFalsy();
      expect(body.props.keyboardShouldPersistTaps).toBe("handled");
      expect(["interactive", "on-drag"]).toContain(body.props.keyboardDismissMode);
      expect(body.props.refreshControl.type).toBeDefined();
      expect(getByTestId("section-tab-notes").parent?.props.horizontal).toBe(true);

      await act(() => showMockKeyboard());
      await fireEvent(body, "scrollBeginDrag", {
        nativeEvent: { contentOffset: { x: 0, y: 24 } },
      });
      expect(isMockKeyboardVisible()).toBe(false);

      await act(() => showMockKeyboard());
      await fireEvent.press(dismissContent);
      expect(isMockKeyboardVisible()).toBe(false);

      await fireEvent.press(getByTestId("section-tab-notes"));
      expect(getByTestId("case-detail-body")).toBeTruthy();
      expect(getByTestId("section-tab-notes")).toBeTruthy();
    });

    it("opens a case-content action with one tap while the keyboard is visible", async () => {
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await act(() => showMockKeyboard());

      await fireEvent.press(getByTestId("overview-edit"));

      expect(getByTestId("overview-save")).toBeTruthy();
    });

    it("renders the case header (case number + patient)", async () => {
      const { getAllByText } = await render(<CaseDetailScreen />);
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
    });

    it("shows patient and doctor in the default overview section", async () => {
      const { getAllByText } = await render(<CaseDetailScreen />);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
      expect(getAllByText(inProgressCase.doctorName).length).toBeGreaterThan(0);
    });

    it("shows notes when the Notes section is selected", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-notes"));
      expect(getAllByText(/Initial impression looks good/).length).toBeGreaterThan(0);
    });

    it("shows restoration material when the Restorations section is selected", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-restorations"));
      expect(getAllByText(/Zirconia/).length).toBeGreaterThan(0);
    });

    it("shows history events when the History section is selected", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getAllByText(/Status Change/).length).toBeGreaterThan(0);
    });

    it("shows derived Case Type label in the overview section", async () => {
      // inProgressCase has restorationType "crown" on its first restoration, which
      // deriveCaseHierarchy resolves to caseType "restorative" → label "Restorative".
      const { getAllByText } = await render(<CaseDetailScreen />);
      expect(getAllByText(/Restorative/).length).toBeGreaterThan(0);
    });
  });

  describe("history note bodies (Task #2597)", () => {
    beforeEach(() => {
      setMockSearchParams({ id: caseWithNoteHistory.id });
      setMockAppState({ cases: [caseWithNoteHistory], invoices: [] });
    });

    it("renders the note body inline on a 'Note Added' history row", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(
        getAllByText(/Shared note body visible to everyone/).length
      ).toBeGreaterThan(0);
    });

    it("does not leak an internal note body that is absent from the viewer's visible notes", async () => {
      const { getByTestId, queryByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      // The internal note's id is not in the visible notes map, so even though a
      // stale `noteText` lingers in the event metadata, the client withholds it.
      expect(queryByText(/TOP SECRET internal lab note/)).toBeNull();
    });
  });

  describe("case overview action row", () => {
    function seedAdminCase(
      overrides: Record<string, unknown> = {},
      caseExceptions: unknown[] = [],
    ) {
      const actionCase = {
        ...inProgressCase,
        ...overrides,
        organizationId: "org-1",
        labOrganizationId: "org-1",
        providerOrganizationId: "practice-1",
      };
      setMockSearchParams({ id: actionCase.id });
      setMockAppState({
        cases: [actionCase],
        invoices: [],
        caseExceptions,
        meMemberships: [
          { organizationId: "org-1", role: "owner", status: "active" },
        ],
      });
      return actionCase;
    }

    it("places permitted actions before Details and keeps them out of the detail rows", async () => {
      seedAdminCase();
      const { getByTestId, getByText, queryByTestId } = await render(
        <CaseDetailScreen />,
      );
      const actionRow = getByTestId("overview-case-actions");
      const detailsCard = getByTestId("overview-details-card");

      expect(actionRow.parent).toBe(detailsCard.parent);
      const siblings = actionRow.parent?.children ?? [];
      expect(siblings.indexOf(actionRow)).toBeLessThan(
        siblings.indexOf(detailsCard),
      );
      expect(actionRow.props.style).toMatchObject({ flexWrap: "wrap" });
      expect(within(actionRow).getByTestId("overview-preview-rx")).toBeTruthy();
      expect(within(actionRow).getByTestId("case-exception-create")).toBeTruthy();
      expect(within(actionRow).getByTestId("rush-toggle")).toBeTruthy();
      expect(within(actionRow).getByTestId("doctor-reassign-action")).toBeTruthy();
      for (const testID of [
        "overview-preview-rx",
        "case-exception-create",
        "rush-toggle",
        "doctor-reassign-action",
      ]) {
        const button = within(actionRow).getByTestId(testID);
        expect(button.props.accessibilityRole).toBe("button");
        expect(StyleSheet.flatten(button.props.style).minHeight).toBe(44);
      }

      expect(within(detailsCard).getByText("Jane Doe")).toBeTruthy();
      expect(within(detailsCard).getByText(inProgressCase.doctorName)).toBeTruthy();
      expect(within(detailsCard).getByTestId("overview-priority")).toHaveTextContent(/Standard/);
      expect(queryByTestId("case-exception-create")).toBeTruthy();
      expect(queryByTestId("rush-toggle")).toBeTruthy();
      expect(queryByTestId("doctor-reassign-action")).toBeTruthy();
      expect(getByText("Case Details")).toBeTruthy();
      expect(within(detailsCard).queryByTestId("overview-preview-rx")).toBeNull();
      expect(within(detailsCard).queryByTestId("case-exception-create")).toBeNull();
      expect(within(detailsCard).queryByTestId("rush-toggle")).toBeNull();
      expect(within(detailsCard).queryByTestId("doctor-reassign-action")).toBeNull();
    });

    describe("rendered action layout at small phone widths", () => {
      let browser: Browser | undefined;

      async function getLayoutBrowser(): Promise<Browser> {
        if (browser) return browser;
        const executablePath = resolveChromiumExecutable();
        browser = await chromium.launch({
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          args: ["--no-sandbox"],
        });
        return browser;
      }

      afterAll(async () => {
        await browser?.close();
      });

      async function measureActionLayout(
        width: number,
        rowStyle: Record<string, unknown>,
        bodyPadding: number,
        buttons: CaseActionLayoutItem[],
      ) {
        const activeBrowser = await getLayoutBrowser();
        const page = await activeBrowser.newPage({
          viewport: { width, height: 220 },
        });
        try {
          await page.setContent(
            caseActionLayoutHtml(rowStyle, bodyPadding, buttons),
          );
          return await page.locator("#action-row").evaluate((row) => {
            const rowRect = row.getBoundingClientRect();
            const buttonRects = Array.from(
              row.querySelectorAll<HTMLButtonElement>("button"),
            ).map((button) => {
              const rect = button.getBoundingClientRect();
              const label = button.querySelector<HTMLElement>(".action-label");
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
                ariaLabel: button.getAttribute("aria-label") ?? "",
                label: label?.textContent ?? "",
                labelClipped:
                  !label ||
                  label.scrollWidth > label.clientWidth + 1 ||
                  getComputedStyle(label).textOverflow === "ellipsis" ||
                  getComputedStyle(label).overflow === "hidden",
              };
            });
            const overlaps = buttonRects.some((left, index) =>
              buttonRects.slice(index + 1).some(
                (right) =>
                  left.left < right.right &&
                  left.right > right.left &&
                  left.top < right.bottom &&
                  left.bottom > right.top,
              ),
            );
            return {
              rowCount: new Set(buttonRects.map((button) => Math.round(button.top)))
                .size,
              overlaps,
              buttonsStayInRow: buttonRects.every(
                (button) =>
                  button.left >= rowRect.left - 0.5 &&
                  button.right <= rowRect.right + 0.5,
              ),
              labelsClipped: buttonRects.some((button) => button.labelClipped),
              buttonHeights: buttonRects.map((button) => button.height),
              labels: buttonRects.map((button) => button.label),
              accessibilityLabels: buttonRects.map(
                (button) => button.ariaLabel,
              ),
            };
          });
        } finally {
          await page.close();
        }
      }

      function readActionLayoutStyles(
        getByTestId: (testID: string) => {
          props: { style?: unknown };
        },
        actionRow: ReturnType<typeof within>,
        specs: { testID: string; label: string }[],
      ) {
        const rowStyle = StyleSheet.flatten(
          getByTestId("overview-case-actions").props.style as never,
        ) as Record<string, unknown>;
        const bodyPadding = Spacing.lg;
        const buttons = specs.map(({ testID, label }) => {
          const button = actionRow.getByTestId(testID);
          const labelNode = within(button).getByText(label);
          expect(button.props.accessibilityRole).toBe("button");
          expect(button.props.onPress).toEqual(expect.any(Function));
          expect(StyleSheet.flatten(button.props.style).minHeight).toBe(44);
          expect(labelNode.props.numberOfLines).toBeUndefined();
          expect(labelNode.props.ellipsizeMode).toBeUndefined();

          return {
            testID,
            label,
            accessibilityLabel: button.props.accessibilityLabel as string,
            buttonStyle: StyleSheet.flatten(
              button.props.style,
            ) as Record<string, unknown>,
            textStyle: StyleSheet.flatten(
              labelNode.props.style,
            ) as Record<string, unknown>,
          };
        });

        return { rowStyle, bodyPadding, buttons };
      }

      it(
        "wraps all four actions without overlap or clipped labels at 320 and 375 points",
        async () => {
          seedAdminCase({ casePanBarcode: "" });
          const { getByTestId } = await render(<CaseDetailScreen />);
          const actionRow = within(getByTestId("overview-case-actions"));
          const specs = [
            { testID: "overview-preview-rx", label: "Preview Rx" },
            {
              testID: "case-exception-create",
              label: "Create Exception Case",
            },
            { testID: "rush-toggle", label: "Mark rush" },
            { testID: "doctor-reassign-action", label: "Reassign" },
          ];
          const layout = readActionLayoutStyles(getByTestId, actionRow, specs);
          expect(layout.rowStyle.flexWrap).toBe("wrap");

          for (const width of [320, 375]) {
            const rendered = await measureActionLayout(
              width,
              layout.rowStyle,
              layout.bodyPadding,
              layout.buttons,
            );
            expect(rendered.rowCount).toBeGreaterThan(1);
            expect(rendered.overlaps).toBe(false);
            expect(rendered.buttonsStayInRow).toBe(true);
            expect(rendered.labelsClipped).toBe(false);
            expect(rendered.buttonHeights.every((height) => height >= 44)).toBe(
              true,
            );
            expect(rendered.labels).toEqual(specs.map(({ label }) => label));
          }
        },
        90_000,
      );

      it(
        "keeps the two available actions readable at 320 and on one row at 375",
        async () => {
          const actionCase = {
            ...inProgressCase,
            organizationId: "org-1",
            labOrganizationId: "org-1",
            casePanBarcode: "",
          };
          setMockSearchParams({ id: actionCase.id });
          setMockAppState({
            cases: [actionCase],
            invoices: [],
            caseExceptions: [],
            meMemberships: [
              { organizationId: "org-1", role: "user", status: "active" },
            ],
          });
          const { getByTestId, queryByTestId } = await render(
            <CaseDetailScreen />,
          );
          const actionRowNode = getByTestId("overview-case-actions");
          const actionRow = within(actionRowNode);
          expect(queryByTestId("rush-toggle")).toBeNull();
          expect(queryByTestId("doctor-reassign-action")).toBeNull();
          const specs = [
            { testID: "overview-preview-rx", label: "Preview Rx" },
            {
              testID: "case-exception-create",
              label: "Create Exception Case",
            },
          ];
          const layout = readActionLayoutStyles(
            getByTestId,
            actionRow,
            specs,
          );

          for (const width of [320, 375]) {
            const rendered = await measureActionLayout(
              width,
              layout.rowStyle,
              layout.bodyPadding,
              layout.buttons,
            );
            // Arial's fallback metrics differ across Linux images. Either
            // one or two rows is usable at 320; keep the real layout gates
            // below and require a single row at the wider phone size.
            expect(rendered.rowCount).toBeGreaterThanOrEqual(1);
            expect(rendered.rowCount).toBeLessThanOrEqual(width === 320 ? 2 : 1);
            expect(rendered.overlaps).toBe(false);
            expect(rendered.buttonsStayInRow).toBe(true);
            expect(rendered.labelsClipped).toBe(false);
            expect(rendered.buttonHeights.every((height) => height >= 44)).toBe(
              true,
            );
          }
        },
        30_000,
      );
    });

    it("keeps only Preview Rx visible when the viewer has no lab membership", async () => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        meMemberships: [],
      });
      const { getByTestId, queryByTestId } = await render(
        <CaseDetailScreen />,
      );
      const actionRow = getByTestId("overview-case-actions");

      expect(within(actionRow).getByTestId("overview-preview-rx")).toBeTruthy();
      expect(queryByTestId("case-exception-create")).toBeNull();
      expect(queryByTestId("rush-toggle")).toBeNull();
      expect(queryByTestId("doctor-reassign-action")).toBeNull();
    });

    it("keeps exception creation available to an active non-editor lab member", async () => {
      const actionCase = {
        ...inProgressCase,
        organizationId: "org-1",
        labOrganizationId: "org-1",
      };
      setMockSearchParams({ id: actionCase.id });
      setMockAppState({
        cases: [actionCase],
        invoices: [],
        caseExceptions: [],
        meMemberships: [
          { organizationId: "org-1", role: "user", status: "active" },
        ],
      });
      const { getByTestId, queryByTestId } = await render(
        <CaseDetailScreen />,
      );
      const actionRow = getByTestId("overview-case-actions");

      expect(within(actionRow).getByTestId("case-exception-create")).toBeTruthy();
      expect(queryByTestId("rush-toggle")).toBeNull();
      expect(queryByTestId("doctor-reassign-action")).toBeNull();
    });

    it("opens the prescription preview from the action row", async () => {
      seedAdminCase();
      const { getByTestId, getByText } = await render(<CaseDetailScreen />);

      await fireEvent.press(getByTestId("overview-preview-rx"));

      expect(getByText("Prescription Preview")).toBeTruthy();
    });

    it("opens the exception create flow", async () => {
      seedAdminCase();
      const { getByTestId } = await render(<CaseDetailScreen />);

      await fireEvent.press(getByTestId("case-exception-create"));
      expect(getByTestId("case-exception-create-sheet")).toBeTruthy();
    });

    it("opens an active exception from the action row", async () => {
      const actionCase = seedAdminCase(
        {},
        [{ id: "exception-1", caseId: inProgressCase.id }],
      );
      const { getByTestId } = await render(<CaseDetailScreen />);

      await fireEvent.press(getByTestId("case-exception-open"));
      expect(getByTestId("case-exception-detail-sheet")).toBeTruthy();
    });

    it("toggles rush through the existing case update flow", async () => {
      const actionCase = seedAdminCase();
      const { getByTestId } = await render(<CaseDetailScreen />);
      const rushButton = getByTestId("rush-toggle");

      expect(rushButton.props.accessibilityRole).toBe("button");
      expect(rushButton.props.accessibilityLabel).toBe("Mark as rush");
      await fireEvent.press(rushButton);

      await waitFor(() =>
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: actionCase.id,
          data: { priority: "rush" },
        }),
      );
    });

    it("shows Clear rush and returns priority to normal for an already-rush case", async () => {
      const actionCase = seedAdminCase({ priority: "rush" });
      const { getByTestId } = await render(<CaseDetailScreen />);
      const rushButton = getByTestId("rush-toggle");

      expect(rushButton.props.accessibilityLabel).toBe("Clear rush");
      expect(within(rushButton).getByText("Clear rush")).toBeTruthy();
      await fireEvent.press(rushButton);

      await waitFor(() =>
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: actionCase.id,
          data: { priority: "normal" },
        }),
      );
    });

    it("opens doctor reassignment from the action row", async () => {
      seedAdminCase();
      const { getByTestId, getByText } = await render(<CaseDetailScreen />);

      await fireEvent.press(getByTestId("doctor-reassign-action"));

      expect(getByText("Reassign doctor")).toBeTruthy();
    });

    it("changes exactly the open case, retains its confirmed doctor on refusal, and refreshes after a committed save", async () => {
      const actionCase = seedAdminCase();
      const assignment = {
        caseId: actionCase.id, recordType: "canonical", caseNumber: actionCase.caseNumber,
        labOrganizationId: "org-1", providerOrganizationId: "practice-1", practiceName: "Practice A",
        doctorName: inProgressCase.doctorName, revision: "saved-revision", updatedAt: null,
      };
      const targetDoctor = {
        key: "user:synthetic-reassignment-target",
        doctorName: "Dr. Reassignment Candidate",
        userId: "synthetic-reassignment-target",
        platformAccountNumber: null,
      };
      mockGetCaseDoctorCandidates.mockResolvedValue({
        ok: true, data: { assignment, entries: [targetDoctor], total: 1, nextOffset: null },
      });
      setMockAppState({ liveDoctorSearchQueries: true });

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      });
      const app = () => (
        <QueryClientProvider client={queryClient}>
          <CaseDetailScreen />
        </QueryClientProvider>
      );
      const screen = await render(app());
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

      try {
        await fireEvent.press(screen.getByTestId("doctor-reassign-action"));
        const searchInput = screen.getByPlaceholderText("Type a doctor name…");
        await fireEvent.changeText(searchInput, targetDoctor.doctorName);
        await waitFor(() =>
          expect(
            screen.getByPlaceholderText("Type a doctor name…").props.value,
          ).toBe(targetDoctor.doctorName),
        );

        await waitFor(() => {
          expect(mockGetCaseDoctorCandidates).toHaveBeenCalledWith(
            actionCase.id,
            expect.objectContaining({
              q: targetDoctor.doctorName,
              limit: 50,
              offset: 0,
            }),
          );
          expect(screen.getByText(targetDoctor.doctorName)).toBeTruthy();
        });
        const doctorOptions = screen.getAllByTestId("doctor-reassign-option");
        expect(doctorOptions).toHaveLength(1);
        expect(within(doctorOptions[0]).getByText(targetDoctor.doctorName)).toBeTruthy();

        await fireEvent.press(screen.getByText(targetDoctor.doctorName));
        mockReassignCaseDoctorMutateAsync.mockRejectedValueOnce(new Error("Doctor is no longer associated with this practice"));
        mockInvalidateQueries.mockClear();

        await fireEvent.press(screen.getByTestId("doctor-reassign-save"));

        expect(mockReassignCaseDoctorMutateAsync).toHaveBeenNthCalledWith(1, {
          caseId: actionCase.id,
          data: {
            recordType: "canonical", expectedDoctorName: inProgressCase.doctorName, expectedPracticeId: "practice-1",
            expectedRevision: "saved-revision", candidateKey: targetDoctor.key,
          },
        });
        expect(await screen.findByText("Doctor is no longer associated with this practice")).toBeTruthy();
        expect(screen.getByText("Reassign doctor")).toBeTruthy();
        expect(screen.getByTestId("doctor-reassign-save").props.disabled).toBe(false);
        expect(
          within(screen.getByTestId("overview-details-card")).getByText(
            inProgressCase.doctorName,
          ),
        ).toBeTruthy();
        expect(alertSpy).not.toHaveBeenCalledWith(
          "Doctor changed for this case only",
          expect.anything(),
          expect.anything(),
        );
        expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
          queryKey: ["cases", actionCase.id],
        });

        mockReassignCaseDoctorMutateAsync.mockResolvedValueOnce({
          ok: true, data: {
            assignment: { ...assignment, doctorName: targetDoctor.doctorName, revision: "new-revision" },
            previousDoctorName: inProgressCase.doctorName, auditLogId: "case-only-audit",
            undoExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        });
        await fireEvent.press(screen.getByTestId("doctor-reassign-save"));

        expect(mockReassignCaseDoctorMutateAsync).toHaveBeenNthCalledWith(2, {
          caseId: actionCase.id,
          data: {
            recordType: "canonical", expectedDoctorName: inProgressCase.doctorName, expectedPracticeId: "practice-1",
            expectedRevision: "saved-revision", candidateKey: targetDoctor.key,
          },
        });
        await waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: ["cases", actionCase.id],
          }, { throwOnError: true });
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: ["cases"],
          }, { throwOnError: true });
        });
        expect(alertSpy).toHaveBeenCalledWith(
          "Doctor changed for this case only",
          expect.stringContaining(`${inProgressCase.doctorName} → ${targetDoctor.doctorName}`),
          expect.any(Array),
        );
        expect(mockSearchDoctors).not.toHaveBeenCalled();
        expect(mockMergeDoctorsMutate).not.toHaveBeenCalled();

        setMockAppState({
          cases: [{ ...actionCase, doctorName: targetDoctor.doctorName }],
        });
        await screen.rerender(app());
        expect(
          within(screen.getByTestId("overview-details-card")).getByText(
            targetDoctor.doctorName,
          ),
        ).toBeTruthy();
      } finally {
        alertSpy.mockRestore();
      }
    });
  });

  // The lab slip now presents only the prescription. Authored notes remain
  // available in their separate Notes tab, with visibility and history intact.
  describe("authored notes stay separate from Rx Notes", () => {
    const localIso = (year: number, monthIndex: number, day: number) =>
      new Date(year, monthIndex, day, 12, 0, 0, 0).toISOString();

    function seedCaseWithNotes(notes: unknown[]) {
      const datedCase = {
        ...inProgressCase,
        id: "case-dated-notes",
        caseNumber: "5010",
        notes,
      };
      setMockSearchParams({ id: datedCase.id });
      setMockAppState({ cases: [datedCase], invoices: [] });
    }

    it("removes the latest-note preview without losing either authored note", async () => {
      seedCaseWithNotes([
        {
          id: "note-old",
          noteText: "Model poured",
          visibility: "all",
          authorName: "Robin Tech",
          createdAt: localIso(2026, 0, 5),
        },
        {
          id: "note-new",
          noteText: "Confirmed with Dr. Byrne that we are going to TIW.",
          visibility: "all",
          authorName: "Casey Lab",
          createdAt: localIso(2026, 8, 15),
        },
      ]);

      const screen = await render(<CaseDetailScreen />);
      expect(screen.queryByTestId("overview-latest-note")).toBeNull();
      expect(screen.queryByText("Model poured")).toBeNull();
      await fireEvent.press(screen.getByTestId("section-tab-notes"));
      expect(screen.getByText("Model poured")).toBeTruthy();
      expect(screen.getByText("Confirmed with Dr. Byrne that we are going to TIW.")).toBeTruthy();
    });

    it("keeps a legacy undated note in the Notes tab only", async () => {
      seedCaseWithNotes([
        {
          id: "note-undated",
          noteText: "Legacy note",
          visibility: "all",
          authorName: "Older System",
          createdAt: null,
        },
      ]);

      const screen = await render(<CaseDetailScreen />);
      expect(screen.queryByTestId("overview-latest-note")).toBeNull();
      expect(screen.queryByText("Legacy note")).toBeNull();
      await fireEvent.press(screen.getByTestId("section-tab-notes"));
      expect(screen.getByText("Legacy note")).toBeTruthy();
    });

    it("renders nothing extra when the case has no notes", async () => {
      seedCaseWithNotes([]);

      const { queryByTestId } = await render(<CaseDetailScreen />);
      expect(queryByTestId("overview-latest-note")).toBeNull();
    });
  });

  // The server mirrors invoice bulk-status changes onto the case timeline by
  // inserting `invoice_updated` / `invoice_voided` caseEvents (see the bulk-status
  // handler in `artifacts/api-server/src/routes/invoices.ts`). Backend + desktop
  // tests prove those rows are persisted and rendered, but nothing on mobile
  // proved the History view renders them — a rendering regression could silently
  // hide bulk status changes from mobile users.
  describe("invoice lifecycle events on the History timeline (desktop parity)", () => {
    beforeEach(() => {
      setMockSearchParams({ id: caseWithInvoiceEventHistory.id });
      setMockAppState({ cases: [caseWithInvoiceEventHistory], invoices: [] });
    });

    it("renders an invoice_updated event as a plain-language one-line summary", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      // The row reads as a sentence ("Invoice INV-9001 marked Open") instead of
      // a stacked "Invoice Updated" title + number + "Draft → Open" arrow.
      expect(getAllByText("Invoice INV-9001 marked Open").length).toBeGreaterThan(0);
    });

    it("renders an invoice_voided event as a plain-language one-line summary", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getAllByText("Invoice INV-9002 voided").length).toBeGreaterThan(0);
    });

    it("surfaces the affected invoice number + status change within each summary", async () => {
      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      // The one-line summary still names WHICH invoice changed and its new status.
      expect(getAllByText("Invoice INV-9001 marked Open").length).toBeGreaterThan(0);
      expect(getAllByText("Invoice INV-9002 voided").length).toBeGreaterThan(0);
    });
  });

  describe("overview editing (desktop parity)", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({
        cases: [{ ...inProgressCase, organizationId: "org-1", labOrganizationId: "org-1" }],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });
    });

    it("keeps case-detail actions below the scroll area and clears them on close", async () => {
      const screen = await render(<CaseDetailScreen />);
      expect(screen.queryByTestId("case-edit-action-bar")).toBeNull();

      await fireEvent.press(screen.getByTestId("overview-edit"));
      await waitFor(() =>
        expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy(),
      );
      const body = screen.getByTestId("case-detail-body");
      const actionBar = screen.getByTestId("case-edit-action-bar");
      expect(actionBar.parent).toBe(body.parent);
      expect(within(actionBar).getByTestId("overview-cancel")).toBeTruthy();
      expect(within(actionBar).getByTestId("overview-save")).toBeTruthy();

      await fireEvent.press(screen.getByTestId("overview-cancel"));
      await waitFor(() =>
        expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
      );

      await fireEvent.press(screen.getByTestId("overview-edit"));
      await fireEvent.changeText(
        screen.getByDisplayValue(inProgressCase.doctorName),
        "Dr. Smithson",
      );
      await fireEvent.press(screen.getByTestId("overview-save"));
      await waitFor(() =>
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: inProgressCase.id,
          data: { doctorName: "Dr. Smithson" },
        }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
      );

      await fireEvent.press(screen.getByTestId("overview-edit"));
      expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("section-tab-restorations"));
      await waitFor(() =>
        expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
      );
    });

    it("uses one action bar for details and notes, retaining notes-only editing outside it", async () => {
      const screen = await render(<CaseDetailScreen />);
      await fireEvent.press(screen.getByTestId("overview-edit"));
      await waitFor(() => expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy());

      expect(screen.getByTestId("clinical-rx-notes")).toBeTruthy();
      expect(screen.queryByTestId("overview-rx-edit")).toBeNull();
      expect(within(screen.getByTestId("case-edit-action-bar")).getByTestId("overview-save")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("overview-cancel"));
      await fireEvent.press(screen.getByTestId("overview-rx-edit"));
      await waitFor(() => {
        const actionBar = screen.getByTestId("case-edit-action-bar");
        expect(within(actionBar).getByTestId("overview-rx-cancel")).toBeTruthy();
        expect(within(actionBar).getByTestId("overview-rx-save")).toBeTruthy();
      });
      expect(
        within(screen.getByTestId("case-edit-action-bar")).queryByTestId(
          "overview-save",
        ),
      ).toBeNull();
      await fireEvent.press(screen.getByTestId("overview-rx-cancel"));
      await waitFor(() =>
        expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
      );
    });

    it("saves a typed due date through overview editing, but not a cancelled draft", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("overview-edit"));
      await fireEvent.press(getByTestId("select-due"));
      await fireEvent.press(getByTestId("cal-type"));
      await fireEvent.changeText(getByTestId("cal-typed-input"), "02/30/2028");
      await fireEvent.press(getByTestId("cal-typed-confirm"));
      expect(getByTestId("cal-typed-error")).toBeTruthy();
      await fireEvent.press(getByTestId("cal-typed-cancel"));
      expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
      await fireEvent.press(getByTestId("select-due"));
      await fireEvent.press(getByTestId("cal-type"));
      await fireEvent.changeText(getByTestId("cal-typed-input"), "02/29/2028");
      await fireEvent.press(getByTestId("cal-typed-confirm"));
      await fireEvent.press(getByTestId("overview-save"));
      await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: inProgressCase.id, data: { dueDate: "2028-02-29" },
      }));
    });

    it("enters edit mode and saves only the changed field via useUpdateCase", async () => {
      const { getByTestId, getByDisplayValue, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("overview-edit"));

      await fireEvent.changeText(getByDisplayValue(inProgressCase.doctorName), "Dr. Smithson");
      await fireEvent.press(getByTestId("overview-save"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: inProgressCase.id,
          data: { doctorName: "Dr. Smithson" },
        });
      });
      // Returns to read mode after a successful save.
      await waitFor(() => expect(queryByTestId("overview-edit")).toBeTruthy());
    });

  it("includes a changed Date received in the update and refreshes invoices", async () => {
    const editableCase = {
      ...inProgressCase,
      organizationId: "org-1",
      labOrganizationId: "org-1",
      receivedAt: "2024-01-10T12:00:00.000Z",
    };
    setMockSearchParams({ id: editableCase.id });
    setMockAppState({ cases: [editableCase], invoices: [] });

    const { getAllByTestId, getByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("overview-edit"));
    await fireEvent.press(getByTestId("select-received"));
    await fireEvent.press(getAllByTestId("cal-day-15")[0]!);
    await fireEvent.press(getByTestId("overview-save"));

    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: { receivedAt: "2024-01-15" },
      });
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("does not invalidate invoices when an overview save fails", async () => {
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Network error"));

    const { getByDisplayValue, getByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("overview-edit"));
    await fireEvent.changeText(getByDisplayValue(inProgressCase.doctorName), "Dr. Smithson");
    await fireEvent.press(getByTestId("overview-save"));

    await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalled());
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

    it("adds a note via useAddCaseNote with the default internal visibility", async () => {
      // The note composer is gated to editors, so seed an editable case +
      // active billing-role membership on its org → canEdit === true.
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });

      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-notes"));
      await fireEvent.changeText(getByTestId("note-input"), "Follow-up scheduled");
      await fireEvent.press(getByTestId("note-submit"));

      await waitFor(() => {
        expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: { noteText: "Follow-up scheduled", visibility: "internal_lab_only" },
        });
      });
    });

    it("hides the note composer when the user cannot edit", async () => {
      setMockAppState({ meMemberships: [] });
      // Default membership stub → canEdit === false: notes remain readable but
      // the composer input is absent.
      const { getByTestId, queryByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-notes"));
      expect(getAllByText(/Initial impression looks good/).length).toBeGreaterThan(0);
      expect(queryByTestId("note-input")).toBeNull();
    });

    it("does not render the Locate Case card when the user cannot edit", async () => {
      // Default membership stub → canEdit === false: the Locate Case control
      // (like every editor-only affordance) is absent.
      const { queryByTestId } = await render(<CaseDetailScreen />);
      expect(queryByTestId("locate-select")).toBeNull();
      expect(queryByTestId("locate-confirm")).toBeNull();
    });
  });

  // The case-detail screen has its own inline "Locate Case" card (separate from
  // the shared LocateCaseSheet used by the case list / dashboard). It must show
  // the SAME locations desktop shows for the lab — never a shorter built-in
  // list standing in while the fetch is in flight, failed, or came back empty.
  describe("Locate Case card — lab locations parity with desktop", () => {
    // inProgressCase.status is "in_design", so that location is filtered out of
    // the destination list (you can't move a case to where it already is).
    const editableCase = { ...inProgressCase, organizationId: "org-1" };

    function seed(): void {
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });
    }

    beforeEach(() => {
      seed();
      setMockFetchHandler(locationsOnlyHandler());
    });

    it("locates the case to a new station via useUpdateCase with its location id", async () => {
      // Status/location is changed exclusively through the desktop-style
      // "Locate Case" control (editor-only), not the edit form.
      const { getByTestId, getAllByTestId } = await render(<CaseDetailScreen />);
      await waitFor(() => expect(getByTestId("locate-select")).toBeTruthy());
      const header = getByTestId("case-top-header");
      const location = getByTestId("case-header-location");
      expect(within(header).getByTestId("case-header-patient")).toHaveTextContent("Jane Doe");
      expect(within(header).getByTestId("case-header-location")).toBe(location);
      expect(within(getByTestId("case-detail-body")).queryByTestId("locate-select")).toBeNull();
      expect(getAllByTestId("case-header-location")).toHaveLength(1);
      expect(getAllByTestId("locate-select")).toHaveLength(1);

      // Pick a destination station, then press Locate (mirrors desktop).
      await fireEvent.press(getByTestId("locate-select"));
      await fireEvent.press(getByTestId("option-loc-complete"));
      await fireEvent.press(getByTestId("locate-confirm"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          // The mapped status is accompanied by its unique location row id.
          data: { status: "complete", labLocationId: "loc-complete" },
        });
      });
      // Confirmation mirrors desktop's "Case located successfully."
      await waitFor(() => expect(getByTestId("locate-success")).toBeTruthy());
    });

    it("retains a picked station across tabs and edit toggles with only one header owner", async () => {
      const screen = await render(<CaseDetailScreen />);
      await waitFor(() => expect(screen.getByTestId("locate-select")).toBeTruthy());
      await fireEvent.press(screen.getByTestId("locate-select"));
      await fireEvent.press(screen.getByTestId("option-loc-glaze"));
      for (const tab of ["history", "notes", "files", "restorations", "overview"]) {
        await fireEvent.press(screen.getByTestId(`section-tab-${tab}`));
        expect(screen.getAllByTestId("locate-select")).toHaveLength(1);
        expect(within(screen.getByTestId("locate-select")).getByText("Glaze Oven")).toBeTruthy();
        expect(within(screen.getByTestId("case-detail-body")).queryByTestId("locate-select")).toBeNull();
      }
      await fireEvent.press(screen.getByTestId("overview-edit"));
      expect(screen.getAllByTestId("case-header-location")).toHaveLength(1);
      expect(screen.queryByTestId("locate-select")).toBeNull();
      expect(screen.queryByTestId("locate-confirm")).toBeNull();
      await fireEvent.press(screen.getByTestId("overview-cancel"));
      await waitFor(() => expect(screen.getByTestId("locate-select")).toBeTruthy());
      expect(within(screen.getByTestId("locate-select")).getByText("Glaze Oven")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("section-tab-history"));
      await fireEvent.press(screen.getByTestId("locate-confirm"));
      await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        data: { status: "qc", labLocationId: "loc-glaze" },
      }));
    });

    it("keeps the selected station on a refused route and allows a successful retry", async () => {
      const alert = vi.spyOn(Alert, "alert");
      mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Route refused."));
      const screen = await render(<CaseDetailScreen />);
      await waitFor(() => expect(screen.getByTestId("locate-select")).toBeTruthy());
      await fireEvent.press(screen.getByTestId("locate-select"));
      await fireEvent.press(screen.getByTestId("option-loc-glaze"));
      await fireEvent.press(screen.getByTestId("locate-confirm"));
      await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't locate case", "Route refused."));
      expect(screen.queryByTestId("locate-success")).toBeNull();
      expect(within(screen.getByTestId("locate-select")).getByText("Glaze Oven")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("locate-confirm"));
      await waitFor(() => expect(screen.getByTestId("locate-success")).toBeTruthy());
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(2);
    });

    it("does not offer another write after a committed route whose refresh fails", async () => {
      mockInvalidateQueries.mockRejectedValueOnce(new Error("Refresh offline."));
      const alert = vi.spyOn(Alert, "alert");
      const screen = await render(<CaseDetailScreen />);
      await waitFor(() => expect(screen.getByTestId("locate-select")).toBeTruthy());
      await fireEvent.press(screen.getByTestId("locate-select"));
      await fireEvent.press(screen.getByTestId("option-loc-glaze"));
      await fireEvent.press(screen.getByTestId("locate-confirm"));
      await waitFor(() => expect(screen.getByTestId("locate-success")).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId("locate-confirm").props.disabled).toBe(true));
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
      expect(alert).not.toHaveBeenCalledWith("Couldn't locate case", expect.anything());
    });

    it("shows a read-only header location on every tab without offering routing", async () => {
      setMockAppState({ meMemberships: [] });
      const screen = await render(<CaseDetailScreen />);
      for (const tab of ["overview", "history", "notes"]) {
        await fireEvent.press(screen.getByTestId(`section-tab-${tab}`));
        expect(screen.getAllByTestId("case-header-location")).toHaveLength(1);
        expect(within(screen.getByTestId("case-top-header")).getByTestId("overview-current-location")).toBeTruthy();
        expect(screen.queryByTestId("locate-select")).toBeNull();
        expect(screen.queryByTestId("locate-confirm")).toBeNull();
      }
      expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
    });

    it("shows a loading state while the lab's locations are in flight", async () => {
      let resolveLocations!: (response: Response) => void;
      const locationsPending = new Promise<Response>((resolve) => {
        resolveLocations = resolve;
      });
      setMockFetchHandler((url, init) =>
        String(url).includes("/api/locations")
          ? locationsPending
          : locationsOnlyHandler()(url, init),
      );

      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      // Before the fetch resolves there is no selectable list at all — the
      // built-in station list is never shown as if it were the lab's.
      expect(getByTestId("locate-locations-loading")).toBeTruthy();
      expect(queryByTestId("locate-select")).toBeNull();

      resolveLocations(
        await locationsOnlyHandler()("/api/locations?activeOnly=true"),
      );
      await waitFor(() => expect(getByTestId("locate-select")).toBeTruthy());
      expect(queryByTestId("locate-locations-loading")).toBeNull();
    });

    it("shows an error with retry when the locations fetch fails, and recovers on retry", async () => {
      setMockFetchHandler((url) =>
        String(url).includes("/api/locations")
          ? new Response(JSON.stringify({ message: "boom" }), { status: 500 })
          : new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }),
      );

      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await waitFor(() => expect(getByTestId("locate-locations-error")).toBeTruthy());
      // A failed fetch must not silently fall back to the built-in list.
      expect(queryByTestId("locate-select")).toBeNull();

      setMockFetchHandler(locationsOnlyHandler());
      await fireEvent.press(getByTestId("locate-locations-retry"));

      await waitFor(() => expect(getByTestId("locate-select")).toBeTruthy());
      expect(queryByTestId("locate-locations-error")).toBeNull();
    });

    it("shows an explicit empty state when the lab has no active locations", async () => {
      setMockFetchHandler(locationsOnlyHandler([]));

      const { getByTestId, queryByTestId, getByText } = await render(<CaseDetailScreen />);
      await waitFor(() => expect(getByTestId("locate-locations-empty")).toBeTruthy());
      expect(getByText("This lab has no active locations yet.")).toBeTruthy();
      // No stand-in list, and nothing to submit.
      expect(queryByTestId("locate-select")).toBeNull();
      expect(queryByTestId("locate-confirm")).toBeNull();
    });

    it("lists the lab's custom active locations and never an inactive one", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await waitFor(() => expect(getByTestId("locate-select")).toBeTruthy());
      await fireEvent.press(getByTestId("locate-select"));

      // Custom location that is NOT part of the built-in station list.
      expect(getByTestId("option-loc-polish")).toBeTruthy();
      // Inactive locations are excluded by the activeOnly=true request.
      expect(queryByTestId("option-loc-retired")).toBeNull();
      // The case's current location is not offered as a destination.
      expect(queryByTestId("option-loc-in-design")).toBeNull();
    });

    it("keeps two custom locations that share a workflow status independently selectable", async () => {
      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await waitFor(() => expect(getByTestId("locate-select")).toBeTruthy());
      await fireEvent.press(getByTestId("locate-select"));

      // Both "qc"-mapped locations appear as their own rows (the old
      // status-keyed list collapsed them into one).
      expect(getByTestId("option-loc-polish")).toBeTruthy();
      expect(getByTestId("option-loc-glaze")).toBeTruthy();

      // The picked location's own name lands in the select row — the two
      // qc-mapped rows are distinct selections, not one shared entry.
      await fireEvent.press(getByTestId("option-loc-glaze"));
      expect(within(getByTestId("locate-select")).getByText("Glaze Oven")).toBeTruthy();

      // Selecting the sibling location swaps the selection (one destination at
      // a time) rather than sharing it.
      await fireEvent.press(getByTestId("locate-select"));
      await fireEvent.press(getByTestId("option-loc-polish"));
      const selectRow = within(getByTestId("locate-select"));
      expect(selectRow.getByText("Polishing Bench")).toBeTruthy();
      expect(selectRow.queryByText("Glaze Oven")).toBeNull();

      await fireEvent.press(getByTestId("locate-confirm"));
      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: { status: "qc", labLocationId: "loc-polish" },
        });
      });
    });

    it("requests only the lab's active locations, scoped to the case's lab", async () => {
      await render(<CaseDetailScreen />);
      await waitFor(() => {
        expect(resilientFetch).toHaveBeenCalledWith(
          expect.stringContaining("/api/locations?organizationId=org-1&activeOnly=true"),
        );
      });
    });
  });

  describe("with a completed case that has a real invoice", () => {
    beforeEach(() => {
      setMockSearchParams({ id: completedCaseWithInvoice.id });
      setMockAppState({
        cases: [completedCaseWithInvoice],
        invoices: [sampleInvoice],
      });
    });

    it("renders without throwing for a paid invoice attached to a complete case", async () => {
      await expect(render(<CaseDetailScreen />)).resolves.toBeDefined();
    });

    it("renders the completed case number in the header", async () => {
      const { getAllByText } = await render(<CaseDetailScreen />);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });

    it("shows the invoice number when the Invoice section is selected", async () => {
      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-invoice"));
      expect(getByText(/Invoice #INV-2024-002/)).toBeTruthy();
    });

    it("exports the invoice PDF to the OS share sheet (available to all viewers)", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-invoice"));
      // Export is not gated to editors — a read-only viewer can still export.
      await fireEvent.press(getByTestId("invoice-export"));

      await waitFor(() => {
        expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalled();
      });
      const [, opts] = vi.mocked(Sharing.shareAsync).mock.calls[0] as [
        string,
        { mimeType?: string },
      ];
      expect(opts.mimeType).toBe("application/pdf");
    });

    it("hides the Email action for a read-only viewer", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-invoice"));
      // Export is always present; Email is editor-only.
      expect(getByTestId("invoice-export")).toBeTruthy();
      expect(queryByTestId("invoice-email")).toBeNull();
    });
  });

  describe("case invoice finance refreshes", () => {
    const editableCase = {
      ...inProgressCase,
      id: "case-finance-actions",
      organizationId: "org-1",
      labOrganizationId: "org-1",
    };
    const editableMembership = {
      organizationId: "org-1",
      role: "admin",
      status: "active",
      organization: { id: "org-1", type: "lab", name: "Test Lab" },
    };
    const openInvoice = {
      ...sampleInvoice,
      id: "inv-finance-actions",
      caseId: editableCase.id,
      invoiceNumber: "INV-FINANCE-ACTIONS",
      status: "open",
      balanceDue: 500,
    };

    function seedCase(invoices: unknown[] = []) {
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices,
        meMemberships: [editableMembership],
      });
    }

    function expectInvalidations(keys: string[][]) {
      const invalidatedKeys = (mockInvalidateQueries.mock.calls as unknown[][]).map(
        (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey,
      );
      expect(invalidatedKeys).toEqual(
        expect.arrayContaining(keys),
      );
    }

    it("refreshes invoice and statement summaries after creating an invoice", async () => {
      seedCase();
      const screen = await render(<CaseDetailScreen />);
      await fireEvent.press(screen.getByTestId("section-tab-invoice"));
      mockInvalidateQueries.mockClear();

      await fireEvent.press(screen.getByTestId("create-invoice"));

      await waitFor(() =>
        expect(mockGenerateInvoiceForCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: {},
        }),
      );
      expectInvalidations([
        ["invoices"],
        ["statement-account-summaries"],
      ]);
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["payment-history"],
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["undeposited-funds-summary"],
      });
    });

    it("does not refresh finance views when invoice creation fails", async () => {
      seedCase();
      mockGenerateInvoiceForCaseMutateAsync.mockRejectedValueOnce(
        new Error("Invoice unavailable"),
      );
      const screen = await render(<CaseDetailScreen />);
      await fireEvent.press(screen.getByTestId("section-tab-invoice"));
      mockInvalidateQueries.mockClear();

      await fireEvent.press(screen.getByTestId("create-invoice"));

      await waitFor(() =>
        expect(mockGenerateInvoiceForCaseMutateAsync).toHaveBeenCalled(),
      );
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["invoices"],
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["statement-account-summaries"],
      });
    });

    it("shows a case-created invoice across finance screens after navigation", async () => {
      seedCase();
      const createdInvoice = {
        ...openInvoice,
        id: "inv-created-from-case",
        invoiceNumber: "INV-CREATED-FROM-CASE",
        total: 275,
        balanceDue: 275,
      };
      mockGenerateInvoiceForCaseMutateAsync.mockImplementationOnce(async () => {
        setMockAppState({
          invoices: [createdInvoice],
          statementAccountSummaries: [{
            practiceId: "practice-1",
            practiceName: "Test Practice",
            billingEmail: "billing@test.example",
            openInvoiceCount: 1,
            openInvoiceTotal: 275,
            totalOpenBalance: 275,
            overdueBalance: 0,
            unpaidStatements: [],
          }],
        });
        return { ok: true, data: null };
      });

      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const navigation = (stage: FinanceNavigationStage) => (
        <QueryClientProvider client={client}>
          <FinanceNavigationHarness stage={stage} />
        </QueryClientProvider>
      );
      const screen = await render(navigation("case"));
      await fireEvent.press(screen.getByTestId("section-tab-invoice"));
      await fireEvent.press(screen.getByTestId("create-invoice"));

      await waitFor(() =>
        expect(mockGenerateInvoiceForCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: {},
        }),
      );
      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["invoices"],
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["statement-account-summaries"],
        });
      });
      await flushPendingReactUpdates();

      await screen.rerender(navigation("hub"));
      expect(screen.getByTestId("hub-/finance/invoices")).toBeTruthy();
      expect(screen.getByTestId("hub-/finance/statements")).toBeTruthy();

      await screen.rerender(navigation("statements"));
      expect(screen.getByTestId("column-total-total").props.children).toBe("$275.00");
      expect(screen.getByTestId("statement-open-total-practice-1").props.children).toBe("$275.00");
      expect(screen.getByTestId("statement-balance-practice-1").props.children).toBe("$275.00");

      await screen.rerender(navigation("invoices"));
      expect(screen.getByText("1 invoice")).toBeTruthy();
      expect(screen.getByTestId("invoice-inv-created-from-case")).toBeTruthy();
      expect(screen.getByTestId("column-total-total").props.children).toBe("$275.00");
      expect(screen.getByTestId("column-total-balance").props.children).toBe("$275.00");
    });

    it("refreshes statement, payment-history, and Undeposited Funds views after a direct payment", async () => {
      seedCase([openInvoice]);
      let paymentAttempted = false;
      setMockFetchHandler(async (url, init) => {
        if (
          url === `/api/invoices/${openInvoice.id}/payments` &&
          init?.method === "POST"
        ) {
          paymentAttempted = true;
        }
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const navigation = (stage: FinanceNavigationStage) => (
        <QueryClientProvider client={client}>
          <FinanceNavigationHarness stage={stage} />
        </QueryClientProvider>
      );
      const screen = await render(navigation("case"));
      await fireEvent.press(screen.getByTestId("section-tab-invoice"));
      await fireEvent.press(screen.getByTestId("record-payment"));
      await fireEvent.changeText(screen.getByTestId("payment-amount"), "50");
      mockInvalidateQueries.mockClear();

      await fireEvent.press(screen.getByTestId("save-payment"));

      await waitFor(() => expect(paymentAttempted).toBe(true));
      expectInvalidations([
        ["invoices"],
        ["statement-account-summaries"],
        ["payment-history"],
        ["undeposited-funds-summary"],
      ]);
      await flushPendingReactUpdates();

      setMockAppState({
        undepositedFundsSummary: { count: 1, total: 50 },
      });
      await screen.rerender(navigation("hub"));
      expect(screen.getByTestId("undeposited-funds-banner")).toBeTruthy();
      expect(screen.getByText("1 payment · $50.00 waiting to deposit")).toBeTruthy();
    });

    it("does not refresh finance views when a direct payment fails", async () => {
      seedCase([openInvoice]);
      let paymentAttempted = false;
      const alertSpy = vi
        .spyOn(Alert, "alert")
        .mockImplementation(() => undefined);
      setMockFetchHandler(async (url, init) => {
        if (
          url === `/api/invoices/${openInvoice.id}/payments` &&
          init?.method === "POST"
        ) {
          paymentAttempted = true;
           return new Response(JSON.stringify({ message: "Payment unavailable" }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      });
      const screen = await render(<CaseDetailScreen />);
      await fireEvent.press(screen.getByTestId("section-tab-invoice"));
      await fireEvent.press(screen.getByTestId("record-payment"));
      await fireEvent.changeText(screen.getByTestId("payment-amount"), "50");
      mockInvalidateQueries.mockClear();

      await fireEvent.press(screen.getByTestId("save-payment"));

      await waitFor(() => expect(paymentAttempted).toBe(true));
      expect(alertSpy).toHaveBeenCalledWith(
        "Couldn't record payment",
        "Payment unavailable",
      );
      expect(screen.getByTestId("payment-amount").props.value).toBe("50");
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["invoices"],
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["statement-account-summaries"],
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["payment-history"],
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ["undeposited-funds-summary"],
      });
      alertSpy.mockRestore();
    });
  });

  describe("files (open attachment) — desktop parity", () => {
    const pdfAttachment = {
      id: "att-pdf-1",
      fileName: "iTero_Rx_309233315.pdf",
      fileType: "application/pdf",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    const stlAttachment = {
      id: "att-stl-1",
      fileName: "scan.stl",
      fileType: "model/stl",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    const imageAttachment = {
      id: "att-img-1",
      fileName: "occlusal.jpg",
      fileType: "image/jpeg",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    const videoAttachment = {
      id: "att-video-1",
      fileName: "bite-video.mp4",
      fileType: "video/mp4",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:01:00.000Z",
    };
    const unsupportedVideoAttachment = {
      id: "att-video-webm-1",
      fileName: "scan.webm",
      fileType: "video/webm",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:02:00.000Z",
    };

    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
    });

    it("renders a tappable thumbnail for an image attachment", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`img-open-${imageAttachment.id}`)).toBeTruthy();
    });

    it("renders a generated frame and play treatment for a video attachment", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));

      expect(getByTestId(`img-open-${videoAttachment.id}`)).toBeTruthy();
      await waitFor(() =>
        expect(getByTestId("video-thumbnail-image")).toBeTruthy(),
      );
      expect(getByTestId("video-thumbnail-play")).toBeTruthy();
      expect(createVideoThumbnail).toHaveBeenCalled();
    });

    it("keeps a failed video thumbnail tappable with a video placeholder", async () => {
      vi.mocked(createVideoThumbnail).mockRejectedValueOnce(new Error("no frame"));
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));

      await waitFor(() =>
        expect(getByTestId("video-thumbnail-fallback")).toBeTruthy(),
      );
      await fireEvent.press(getByTestId(`img-open-${videoAttachment.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
    });

    it("shows the video placeholder when a generated frame cannot be decoded", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      const thumbnail = await waitFor(() =>
        getByTestId("video-thumbnail-image"),
      );

      await fireEvent(thumbnail, "error");
      await waitFor(() =>
        expect(getByTestId("video-thumbnail-fallback")).toBeTruthy(),
      );
    });

    it("long-pressing a video thumbnail offers save without starting playback", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        const thumb = getByTestId(`img-open-${videoAttachment.id}`);

        await fireEvent(thumb, "longPress");
        expect(alertSpy).toHaveBeenCalledWith(
          "Save File",
          expect.any(String),
          expect.any(Array),
        );
        await fireEvent.press(thumb);
        expect(queryByTestId("lightbox-video")).toBeNull();
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("opens a tapped image thumbnail in the full-screen lightbox preview", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));

      // Lightbox is closed until the thumbnail is tapped.
      expect(queryByTestId("lightbox-image")).toBeNull();

      await fireEvent.press(getByTestId(`img-open-${imageAttachment.id}`));

      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      // Opening an image preview must not invoke the OS share sheet.
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("keeps photo gestures inside the viewer while preserving save, gallery and close controls", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment, { ...imageAttachment, id: "second-photo" }],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`img-open-${imageAttachment.id}`));
        await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
        expect(getByTestId("zoom-gesture")).toBeTruthy();
        await fireEvent.press(getByTestId("lightbox-image-touch"));
        expect(getByTestId("lightbox-image")).toBeTruthy();
        await fireEvent(getByTestId("lightbox-image-touch"), "longPress");
        expect(alertSpy).toHaveBeenCalledWith("Save Photo", expect.any(String), expect.any(Array));
        await fireEvent.press(getByTestId("lightbox-next"));
        expect(getByTestId("lightbox-image")).toBeTruthy();
        await fireEvent.press(getByTestId("lightbox-close"));
        await waitFor(() => expect(queryByTestId("lightbox-image")).toBeNull());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("opens mixed media by attachment identity and navigates in server order", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment, videoAttachment],
      });
      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`img-open-${videoAttachment.id}`));

      expect(getByText("2 of 2")).toBeTruthy();
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
      expect(getByTestId("lightbox-next")).toBeTruthy();
      expect(getByTestId("lightbox-previous")).toBeTruthy();

      // The final item disables next, while previous moves to the photo
      // without relying on an array index that could change after refresh.
      expect(getByTestId("lightbox-next").props.disabled).toBe(true);
      await fireEvent.press(getByTestId("lightbox-previous"));
      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      expect(getByText("1 of 2")).toBeTruthy();
      expect(getByTestId("lightbox-previous").props.disabled).toBe(true);
    });

    it("plays an mp4 when the server MIME is generic but the filename is video", async () => {
      const genericMimeVideo = {
        ...videoAttachment,
        id: "att-video-generic-mime",
        fileName: "camera-clip.mp4",
        fileType: "application/octet-stream",
      };
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [genericMimeVideo],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`img-open-${genericMimeVideo.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
    });

    for (const fileType of [null, "application/octet-stream", " VIDEO/QUICKTIME "]) {
      it(`opens a camera MOV from Files with native controls when MIME is ${fileType}`, async () => {
        const cameraVideo = { ...videoAttachment, fileName: "IMG_0042.MOV", fileType };
        setMockAppState({ cases: [inProgressCase], invoices: [], attachments: [cameraVideo] });
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`img-open-${cameraVideo.id}`));
        const player = await waitFor(() => getByTestId("lightbox-video"));
        expect(player.props.useNativeControls).toBe(true);
        expect(player.props.shouldPlay).toBe(true);
        expect(acquireAuthedMediaUri).toHaveBeenCalledWith(
          `/api/cases/${inProgressCase.id}/attachments/${cameraVideo.id}/file`,
          undefined,
          cameraVideo.fileName,
          fileType,
        );
        expect(queryByTestId("lightbox-video-fallback")).toBeNull();
        await fireEvent(getByTestId("lightbox-backdrop"), "press", {
          target: 2,
          currentTarget: 1,
        });
        expect(getByTestId("lightbox-video")).toBeTruthy();
      });
    }

    it("falls back to open/download when authenticated video loading fails", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await waitFor(() =>
        expect(getByTestId("video-thumbnail-image")).toBeTruthy(),
      );
      vi.mocked(acquireAuthedMediaUri).mockRejectedValueOnce(
        new Error("authenticated download failed"),
      );
      await fireEvent.press(getByTestId(`img-open-${videoAttachment.id}`));
      await waitFor(() =>
        expect(getByTestId("lightbox-video-fallback")).toBeTruthy(),
      );
      expect(getByTestId("lightbox-video-fallback")).toHaveTextContent("Open / Download");
      await fireEvent.press(getByTestId("lightbox-video-fallback"));
      await waitFor(() => expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalled());
    });

    it("falls back to open/download when native video playback reports a codec error", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [videoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`img-open-${videoAttachment.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
      await fireEvent(getByTestId("lightbox-video"), "error", {
        error: "unsupported codec",
      });
      await waitFor(() =>
        expect(getByTestId("lightbox-video-fallback")).toBeTruthy(),
      );
      expect(getByTestId("lightbox-video-fallback")).toHaveTextContent("Open / Download");
    });

    it("keeps unsupported videos in the gallery with an open/download fallback", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment, unsupportedVideoAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`img-open-${unsupportedVideoAttachment.id}`));
      expect(getByTestId("lightbox-video-fallback")).toBeTruthy();
      await fireEvent.press(getByTestId("lightbox-video-fallback"));
      await waitFor(() => expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalled());
    });

    it("long-pressing an image thumbnail shows the save prompt without opening the lightbox on the follow-up press", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        const thumb = getByTestId(`img-open-${imageAttachment.id}`);

        await fireEvent(thumb, "longPress");
        expect(alertSpy).toHaveBeenCalledWith(
          "Save Photo",
          expect.any(String),
          expect.any(Array),
        );

        // RN fires the release `onPress` right after `onLongPress` on the
        // same element — that follow-up press must be absorbed, not open
        // the lightbox behind the save prompt.
        await fireEvent.press(thumb);
        expect(queryByTestId("lightbox-image")).toBeNull();

        // A genuine, separate tap still opens the lightbox as normal.
        await fireEvent.press(thumb);
        await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("long-pressing the open lightbox shows the save prompt without closing it on the follow-up press", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`img-open-${imageAttachment.id}`));
        await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());

        const backdrop = getByTestId("lightbox-backdrop");
        await fireEvent(backdrop, "longPress");
        expect(alertSpy).toHaveBeenCalledWith(
          "Save Photo",
          expect.any(String),
          expect.any(Array),
        );

        // The release `onPress` from that same long-press must not close
        // the lightbox behind the save prompt.
        await fireEvent.press(backdrop);
        expect(getByTestId("lightbox-image")).toBeTruthy();

        // A genuine, separate tap still closes it as normal.
        await fireEvent.press(backdrop);
        await waitFor(() => expect(queryByTestId("lightbox-image")).toBeNull());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("renders a tappable card for a PDF attachment", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [pdfAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`doc-open-${pdfAttachment.id}`)).toBeTruthy();
    });

    it("opens a tapped PDF in the in-app viewer (never the share sheet)", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [pdfAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`doc-open-${pdfAttachment.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/pdf-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${inProgressCase.id}/attachments/${pdfAttachment.id}/file`,
              fileName: pdfAttachment.fileName,
              fileType: pdfAttachment.fileType,
            }),
          }),
        );
      });
      // Tapping a PDF must not invoke the OS share sheet.
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("long-pressing a PDF card shows the save prompt without opening the in-app viewer on the follow-up press", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [pdfAttachment],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        const card = getByTestId(`doc-open-${pdfAttachment.id}`);

        await fireEvent(card, "longPress");
        expect(alertSpy).toHaveBeenCalledWith("Save File", expect.any(String), expect.any(Array));

        await fireEvent.press(card);
        expect(vi.mocked(router.push)).not.toHaveBeenCalled();

        // A genuine, separate tap still opens the in-app viewer as normal.
        await fireEvent.press(card);
        await waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalled());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("opens a tapped 3D scan (STL/PLY/OBJ) in the in-app scan viewer (never the share sheet)", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [stlAttachment],
      });
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`doc-open-${stlAttachment.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/scan-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${inProgressCase.id}/attachments/${stlAttachment.id}/file`,
              fileName: stlAttachment.fileName,
              fileType: stlAttachment.fileType,
              format: "stl",
            }),
          }),
        );
      });
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("hides the delete affordance when the user cannot edit", async () => {
      // Default useQuery stub returns no memberships → canEdit === false.
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));

      // The thumbnail is still viewable, but the trash button must be absent.
      expect(getByTestId(`img-open-${imageAttachment.id}`)).toBeTruthy();
      expect(queryByTestId(`img-delete-${imageAttachment.id}`)).toBeNull();
    });

    it("deletes an attachment after confirmation when the user can edit", async () => {
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        attachments: [imageAttachment],
        // Active billing-role membership on the case's org → canEdit === true.
        meMemberships: [
          { organizationId: "org-1", role: "owner", status: "active" },
        ],
      });

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));

        // Editors see the trash affordance; pressing it asks for confirmation.
        await fireEvent.press(getByTestId(`img-delete-${imageAttachment.id}`));
        expect(alertSpy).toHaveBeenCalled();
        expect(mockDeleteAttachmentMutateAsync).not.toHaveBeenCalled();

        // Invoke the destructive "Delete" action from the confirm dialog.
        const buttons = alertSpy.mock.calls[0][2];
        const deleteButton = buttons?.find((b) => b.style === "destructive");
        expect(deleteButton).toBeTruthy();
        await act(async () => {
          await deleteButton?.onPress?.();
        });

        await waitFor(() =>
          expect(mockDeleteAttachmentMutateAsync).toHaveBeenCalledWith({
            caseId: editableCase.id,
            attachmentId: imageAttachment.id,
          }),
        );
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("does not open a document when its delete action is pressed", async () => {
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        attachments: [pdfAttachment],
        meMemberships: [
          { organizationId: "org-1", role: "owner", status: "active" },
        ],
      });
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`doc-delete-${pdfAttachment.id}`));

        expect(alertSpy).toHaveBeenCalled();
        expect(vi.mocked(router.push)).not.toHaveBeenCalled();
        expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
      } finally {
        alertSpy.mockRestore();
      }
    });
  });

  // The "Add photo or file" source chooser used to be an `Alert.alert` action
  // sheet, which rendered as a clipped, un-tappable fragment on the app's
  // surfaces (Task #2689). It is now an in-app bottom-sheet Modal so the chooser
  // is always visible and each row still runs the existing picker.
  describe("files (add-photo source chooser) — bottom-sheet regression", () => {
    const editableCase = { ...inProgressCase, organizationId: "org-1" };

    beforeEach(() => {
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        attachments: [],
        // Active membership on the case's org → canUpload === true, so the
        // "Add photo or file" button is present.
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });
      mockUploadCaseAttachment.mockReset();
    });

    it("opens a fully visible in-app bottom sheet when the Add button is pressed", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));

      // The sheet is closed until the Add button is pressed.
      expect(queryByTestId("files-add-sheet")).toBeNull();

      await fireEvent.press(getByTestId("files-add-button"));

      // The chooser renders as an in-app sheet with all four rows visible.
      expect(getByTestId("files-add-sheet")).toBeTruthy();
      expect(getByTestId("files-add-camera")).toBeTruthy();
      expect(getByTestId("files-add-library")).toBeTruthy();
      expect(getByTestId("files-add-document")).toBeTruthy();
      expect(getByTestId("files-add-cancel")).toBeTruthy();
    });

    it("closes the sheet and launches the camera when Take Photo is pressed", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-camera"));

      await waitFor(() =>
        expect(vi.mocked(ImagePicker.launchCameraAsync)).toHaveBeenCalled(),
      );
      // The sheet dismisses before the picker runs.
      expect(queryByTestId("files-add-sheet")).toBeNull();
    });

    it("closes the sheet and launches the photo library when Choose from Library is pressed", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-library"));

      await waitFor(() =>
        expect(vi.mocked(ImagePicker.launchImageLibraryAsync)).toHaveBeenCalled(),
      );
      expect(queryByTestId("files-add-sheet")).toBeNull();
    });

    it("shows video preparation before upload and hands off compressed metadata", async () => {
      let finishPreparation!: (value: {
        uri: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        compressed: boolean;
      }) => void;
      vi.mocked(prepareVideoForUpload).mockReturnValueOnce(
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
      );
      vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [{
          uri: "file:///original.mov",
          fileName: "case-video.mov",
          mimeType: "video/quicktime",
          type: "video",
          fileSize: 12_000_000,
          width: 1920,
          height: 1080,
          duration: 20_000,
        }],
      } as never);

      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-library"));
      await waitFor(() => expect(getByTestId("attachment-note-skip")).toBeTruthy());
      await fireEvent.press(getByTestId("attachment-note-skip"));

      await waitFor(() => expect(getByText("Preparing video…")).toBeTruthy());
      finishPreparation({
        uri: "file:///case-video-720p.mp4",
        fileName: "case-video-720p.mp4",
        mimeType: "video/mp4",
        fileSize: 3_000_000,
        compressed: true,
      });

      await waitFor(() =>
        expect(uploadCaseAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            fileUri: "file:///case-video-720p.mp4",
            fileName: "case-video-720p.mp4",
            mimeType: "video/mp4",
            fileSize: 3_000_000,
          }),
        ),
      );
    });

    it("shows a retryable preparation error without uploading the original", async () => {
      vi.mocked(prepareVideoForUpload)
        .mockRejectedValueOnce(new Error("Video preparation failed. Please retry."))
        .mockResolvedValueOnce({
          uri: "file:///retry-720p.mp4",
          fileName: "retry-720p.mp4",
          mimeType: "video/mp4",
          fileSize: 2_000_000,
          compressed: true,
        });
      vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [{
          uri: "file:///original.mov",
          fileName: "retry.mov",
          mimeType: "video/quicktime",
          type: "video",
          fileSize: 10_000_000,
          width: 1920,
          height: 1080,
          duration: 20_000,
        }],
      } as never);

      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-library"));
      await waitFor(() => expect(getByTestId("attachment-note-skip")).toBeTruthy());
      await fireEvent.press(getByTestId("attachment-note-skip"));

      await waitFor(() =>
        expect(getByText("Video preparation failed. Please retry.")).toBeTruthy(),
      );
      expect(uploadCaseAttachment).not.toHaveBeenCalled();

      const retryButton = getByTestId(/^upload-retry-/);
      await fireEvent.press(retryButton);
      await fireEvent.press(retryButton);
      await waitFor(() => expect(prepareVideoForUpload).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(uploadCaseAttachment).toHaveBeenCalledWith(
          expect.objectContaining({ fileUri: "file:///retry-720p.mp4" }),
        ),
      );
    });

    it("closes the sheet and launches the document picker when Attach File is pressed", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-document"));

      await waitFor(() =>
        expect(vi.mocked(DocumentPicker.getDocumentAsync)).toHaveBeenCalled(),
      );
      expect(queryByTestId("files-add-sheet")).toBeNull();
    });

    it("prepares videos selected through Attach File before upload", async () => {
      let finishPreparation!: (value: {
        uri: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        compressed: boolean;
      }) => void;
      vi.mocked(prepareVideoForUpload).mockReturnValueOnce(
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
      );
      vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [{
          uri: "file:///document-video.mov",
          name: "document-video.mov",
          mimeType: "video/quicktime",
          size: 9_000_000,
        }],
      } as never);

      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-document"));
      await waitFor(() => expect(getByTestId("attachment-note-skip")).toBeTruthy());
      await fireEvent.press(getByTestId("attachment-note-skip"));

      await waitFor(() => expect(getByText("Preparing video…")).toBeTruthy());
      expect(uploadCaseAttachment).not.toHaveBeenCalled();
      finishPreparation({
        uri: "file:///document-video-720p.mp4",
        fileName: "document-video-720p.mp4",
        mimeType: "video/mp4",
        fileSize: 2_000_000,
        compressed: true,
      });
      await waitFor(() =>
        expect(uploadCaseAttachment).toHaveBeenCalledWith(
          expect.objectContaining({ fileUri: "file:///document-video-720p.mp4" }),
        ),
      );
    });

    it("prepares shared-intent videos before attaching them to the case", async () => {
      await pushSharedFile("file:///shared-case.mov");
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      let finishPreparation!: (value: {
        uri: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        compressed: boolean;
      }) => void;
      vi.mocked(prepareVideoForUpload).mockReturnValueOnce(
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
      );

      const { getByText } = await render(<CaseDetailScreen />);
      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith(
          "Attach shared files?",
          expect.any(String),
          expect.any(Array),
        ),
      );
      const buttons = alertSpy.mock.calls.find((call) => call[0] === "Attach shared files?")?.[2];
      const attach = buttons?.find((button) => button.text === "Attach");
      await attach?.onPress?.();

      await waitFor(() => expect(getByText("Preparing video…")).toBeTruthy());
      expect(uploadCaseAttachment).not.toHaveBeenCalled();
      finishPreparation({
        uri: "file:///shared-case-720p.mp4",
        fileName: "shared-case-720p.mp4",
        mimeType: "video/mp4",
        fileSize: 1_500_000,
        compressed: true,
      });
      await waitFor(() =>
        expect(uploadCaseAttachment).toHaveBeenCalledWith(
          expect.objectContaining({ fileUri: "file:///shared-case-720p.mp4" }),
        ),
      );
      alertSpy.mockRestore();
    });

    it("confirms before discarding the displayed shared files and does not prompt on the next case opening", async () => {
      await AsyncStorage.clear();
      await pushSharedFile("file:///shared-old.pdf");
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

      try {
        const firstRender = await render(<CaseDetailScreen />);
        await waitFor(() =>
          expect(alertSpy).toHaveBeenCalledWith(
            "Attach shared files?",
            expect.any(String),
            expect.any(Array),
          ),
        );
        const promptButtons = alertSpy.mock.calls.find(
          (call) => call[0] === "Attach shared files?",
        )?.[2];
        expect(promptButtons?.some((button) => button.text === "Not now")).toBe(false);
        const discard = promptButtons?.find((button) => button.text === "Discard");
        await discard?.onPress?.();

        const confirmation = alertSpy.mock.calls.find(
          (call) => call[0] === "Discard shared files?",
        );
        expect(confirmation).toBeDefined();
        expect(await peekSharedFiles()).toHaveLength(1);

        const confirmDiscard = confirmation?.[2]?.find(
          (button) => button.text === "Discard",
        );
        await confirmDiscard?.onPress?.();
        await waitFor(async () => expect(await peekSharedFiles()).toEqual([]));

        await firstRender.unmount();
        alertSpy.mockClear();
        await render(<CaseDetailScreen />);
        await flushPendingReactUpdates();
        expect(
          alertSpy.mock.calls.some((call) => call[0] === "Attach shared files?"),
        ).toBe(false);
      } finally {
        await AsyncStorage.clear();
        alertSpy.mockRestore();
      }
    });

    it("keeps shared files pending when discard confirmation is cancelled", async () => {
      await AsyncStorage.clear();
      await pushSharedFile("file:///shared-keep.pdf");
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

      try {
        await render(<CaseDetailScreen />);
        await waitFor(() =>
          expect(alertSpy).toHaveBeenCalledWith(
            "Attach shared files?",
            expect.any(String),
            expect.any(Array),
          ),
        );
        const promptButtons = alertSpy.mock.calls.find(
          (call) => call[0] === "Attach shared files?",
        )?.[2];
        await promptButtons?.find((button) => button.text === "Discard")?.onPress?.();
        const confirmationButtons = alertSpy.mock.calls.find(
          (call) => call[0] === "Discard shared files?",
        )?.[2];
        await confirmationButtons
          ?.find((button) => button.text === "Cancel")
          ?.onPress?.();

        expect((await peekSharedFiles()).map((entry) => entry.url)).toEqual([
          "file:///shared-keep.pdf",
        ]);
      } finally {
        await AsyncStorage.clear();
        alertSpy.mockRestore();
      }
    });

    it("discards only files shown in the prompt and preserves files shared later", async () => {
      await AsyncStorage.clear();
      await pushSharedFile("file:///shared-old.pdf");
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

      try {
        await render(<CaseDetailScreen />);
        await waitFor(() =>
          expect(alertSpy).toHaveBeenCalledWith(
            "Attach shared files?",
            expect.any(String),
            expect.any(Array),
          ),
        );
        const promptButtons = alertSpy.mock.calls.find(
          (call) => call[0] === "Attach shared files?",
        )?.[2];
        await promptButtons?.find((button) => button.text === "Discard")?.onPress?.();
        await pushSharedFile("file:///shared-new.pdf");
        const confirmationButtons = alertSpy.mock.calls.find(
          (call) => call[0] === "Discard shared files?",
        )?.[2];
        await confirmationButtons
          ?.find((button) => button.text === "Discard")
          ?.onPress?.();

        await waitFor(async () =>
          expect((await peekSharedFiles()).map((entry) => entry.url)).toEqual([
            "file:///shared-new.pdf",
          ]),
        );
      } finally {
        await AsyncStorage.clear();
        alertSpy.mockRestore();
      }
    });

    it("dismisses the sheet without launching any picker when Cancel is pressed", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-cancel"));

      expect(queryByTestId("files-add-sheet")).toBeNull();
      expect(vi.mocked(ImagePicker.launchCameraAsync)).not.toHaveBeenCalled();
      expect(vi.mocked(ImagePicker.launchImageLibraryAsync)).not.toHaveBeenCalled();
      expect(vi.mocked(DocumentPicker.getDocumentAsync)).not.toHaveBeenCalled();
    });

    it("does not render the Add button when the user cannot upload", async () => {
      // Default membership stub → canUpload === false: the Add button is absent.
      setMockAppState({ cases: [inProgressCase], invoices: [], attachments: [] });
      setMockSearchParams({ id: inProgressCase.id });
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(queryByTestId("files-add-button")).toBeNull();
    });

    it("uploads first, then offers a skippable note without reversing the upload", async () => {
      vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: "file:///alpha.pdf", name: "alpha.pdf", mimeType: "application/pdf" }],
      } as never);
      mockUploadCaseAttachment.mockResolvedValueOnce({
        ok: true,
        attachment: { id: "att-alpha", fileName: "alpha.pdf" },
      });

      const { getByTestId, getByText, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-document"));

      await waitFor(() => expect(mockUploadCaseAttachment).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(getByText(/already uploaded/)).toBeTruthy());
      await fireEvent.press(getByTestId("attachment-note-skip"));

      expect(mockUploadCaseAttachment).toHaveBeenCalledTimes(1);
      expect(queryByTestId("attachment-note-input")).toBeTruthy();
    });

    it("prompts separately for each successfully uploaded file", async () => {
      vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [
          { uri: "file:///one.pdf", name: "one.pdf", mimeType: "application/pdf" },
          { uri: "file:///two.pdf", name: "two.pdf", mimeType: "application/pdf" },
        ],
      } as never);
      mockUploadCaseAttachment
        .mockResolvedValueOnce({ ok: true, attachment: { id: "att-one", fileName: "one.pdf" } })
        .mockResolvedValueOnce({ ok: true, attachment: { id: "att-two", fileName: "two.pdf" } });
      setMockFetchHandler(async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { note: JSON.parse(String(init?.body)).note } }),
        text: async () => "",
      } as Response));

      const { getByTestId, getAllByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId("files-add-button"));
      await fireEvent.press(getByTestId("files-add-document"));

      await waitFor(() => expect(getAllByText(/one\.pdf/).length).toBeGreaterThan(0));
      await fireEvent.changeText(getByTestId("attachment-note-input"), "First note");
      await fireEvent.press(getByTestId("attachment-note-upload"));
      await waitFor(() => {
        const patchBodies = vi.mocked(resilientFetch).mock.calls
          .filter(([, init]) => init?.method === "PATCH")
          .map(([, init]) => JSON.parse(String(init?.body)));
        expect(patchBodies).toEqual([{ note: "First note" }]);
      });
      await waitFor(() =>
        expect(getByTestId("attachment-note-input").props.value).toBe(""),
      );
      expect(getAllByText(/two\.pdf/).length).toBeGreaterThan(0);
      await fireEvent.changeText(getByTestId("attachment-note-input"), "Second note");
      await fireEvent.press(getByTestId("attachment-note-upload"));

      await waitFor(() => {
        const patchBodies = vi.mocked(resilientFetch).mock.calls
          .filter(([, init]) => init?.method === "PATCH")
          .map(([, init]) => JSON.parse(String(init?.body)));
        expect(patchBodies).toEqual([{ note: "First note" }, { note: "Second note" }]);
      });
    });

    it("lets an upload-capable non-admin add, edit, and clear an existing attachment note", async () => {
      const attachment = {
        id: "att-existing-note",
        fileName: "existing.pdf",
        fileType: "application/pdf",
        uploaderName: "Lab Tech",
        createdAt: "2026-06-10T12:00:00.000Z",
        note: "Existing note",
      };
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        attachments: [attachment],
        meMemberships: [{ organizationId: "org-1", role: "technician", status: "active" }],
      });
      setMockFetchHandler(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { note: null } }),
        text: async () => "",
      } as Response));

      const { getByTestId, getByText } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(getByText("Existing note")).toBeTruthy();
      await fireEvent.press(getByTestId(`doc-note-${attachment.id}`));
      await fireEvent.changeText(getByTestId("attachment-note-input"), "");
      await fireEvent.press(getByTestId("attachment-note-upload"));

      await waitFor(() =>
        expect(vi.mocked(resilientFetch)).toHaveBeenCalledWith(
          `/api/cases/${editableCase.id}/attachments/${attachment.id}`,
          expect.objectContaining({ method: "PATCH", body: JSON.stringify({ note: "" }) }),
        ),
      );
    });
  });

  describe("history (interactive attachments) — desktop parity", () => {
    const historyImageEvent = {
      id: "evt-att-img",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-h-img",
        fileName: "occlusal.jpg",
        fileType: "image/jpeg",
      },
      occurredAt: "2024-01-12T10:00:00.000Z",
    };
    const historyPdfEvent = {
      id: "evt-att-pdf",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-h-pdf",
        fileName: "iTero_Rx.pdf",
        fileType: "application/pdf",
      },
      occurredAt: "2024-01-12T11:00:00.000Z",
    };
    const historyVideoEvent = {
      id: "evt-att-video",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-h-video",
        fileName: "bite-video.mp4",
        fileType: "video/mp4",
      },
      occurredAt: "2024-01-12T12:00:00.000Z",
    };
    const caseWithHistoryAttachments = {
      ...inProgressCase,
      id: "case-history-att",
      events: [
        ...inProgressCase.events,
        historyImageEvent,
        historyPdfEvent,
        historyVideoEvent,
      ],
    };

    beforeEach(() => {
      setMockSearchParams({ id: caseWithHistoryAttachments.id });
      setMockAppState({ cases: [caseWithHistoryAttachments], invoices: [] });
    });

    it("renders a tappable thumbnail for an image attachment event", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${historyImageEvent.id}`)).toBeTruthy();
    });

    it("renders a generated frame and play treatment for a video attachment event", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));

      expect(getByTestId(`history-attachment-${historyVideoEvent.id}`)).toBeTruthy();
      await waitFor(() =>
        expect(getByTestId("video-thumbnail-image")).toBeTruthy(),
      );
      expect(getByTestId("video-thumbnail-play")).toBeTruthy();
      expect(createVideoThumbnail).toHaveBeenCalled();
    });

    it("keeps a failed history video thumbnail tappable with a stable fallback", async () => {
      vi.mocked(createVideoThumbnail).mockRejectedValueOnce(new Error("no frame"));
      const { getByTestId } = await renderScreen(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));

      await waitFor(() =>
        expect(getByTestId("video-thumbnail-fallback")).toBeTruthy(),
      );
      expect(getByTestId("video-thumbnail-play")).toBeTruthy();
      await fireEvent.press(getByTestId(`history-attachment-${historyVideoEvent.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
    });

    it("opens a history image attachment in the full-screen lightbox preview", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));

      expect(queryByTestId("lightbox-image")).toBeNull();
      await fireEvent.press(getByTestId(`history-attachment-${historyImageEvent.id}`));

      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("long-pressing a history image thumbnail shows the save prompt without opening the lightbox on the follow-up press", async () => {
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-history"));
        const thumb = getByTestId(`history-attachment-${historyImageEvent.id}`);

        await fireEvent(thumb, "longPress");
        expect(alertSpy).toHaveBeenCalledWith(
          "Save Photo",
          expect.any(String),
          expect.any(Array),
        );

        await fireEvent.press(thumb);
        expect(queryByTestId("lightbox-image")).toBeNull();

        await fireEvent.press(thumb);
        await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("renders a tappable row for a non-image attachment event", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${historyPdfEvent.id}`)).toBeTruthy();
    });

    it("opens a history PDF attachment in the in-app viewer (never the share sheet)", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      await fireEvent.press(getByTestId(`history-attachment-${historyPdfEvent.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/pdf-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${caseWithHistoryAttachments.id}/attachments/${historyPdfEvent.metadataJson.attachmentId}/file`,
              fileName: historyPdfEvent.metadataJson.fileName,
              fileType: historyPdfEvent.metadataJson.fileType,
            }),
          }),
        );
      });
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("long-pressing a history document row shows the save prompt without opening the in-app viewer on the follow-up press", async () => {
      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-history"));
        const row = getByTestId(`history-attachment-${historyPdfEvent.id}`);

        await fireEvent(row, "longPress");
        expect(alertSpy).toHaveBeenCalledWith("Save File", expect.any(String), expect.any(Array));

        await fireEvent.press(row);
        expect(vi.mocked(router.push)).not.toHaveBeenCalled();

        await fireEvent.press(row);
        await waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalled());
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("prefers the legacy imageUri over the canonical /file route when present", async () => {
      const legacyEvent = {
        id: "evt-att-legacy",
        eventType: "attachment_added",
        actorInitials: "AB",
        metadataJson: {
          imageUri: "data:image/png;base64,AAAA",
          fileName: "legacy.png",
          fileType: "image/png",
        },
        occurredAt: "2024-01-12T12:00:00.000Z",
      };
      const legacyCase = {
        ...inProgressCase,
        id: "case-history-legacy",
        events: [...inProgressCase.events, legacyEvent],
      };
      setMockSearchParams({ id: legacyCase.id });
      setMockAppState({ cases: [legacyCase], invoices: [] });

      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${legacyEvent.id}`)).toBeTruthy();
    });

    it("keeps migrated legacy photos visible in the gallery and activity history", async () => {
      const { caseId, attachments, events } = migratedLegacyPhotoContract;
      const migratedCase = {
        ...inProgressCase,
        id: caseId,
        events: [...inProgressCase.events, ...events],
      };
      setMockSearchParams({ id: migratedCase.id });
      setMockAppState({
        cases: [migratedCase],
        invoices: [],
        attachments,
      });

      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(
        getByTestId(`media-open-${attachments[0]!.id}`),
      ).toBeTruthy();
      expect(
        getByTestId(`media-open-${attachments[1]!.id}`),
      ).toBeTruthy();

      await fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${events[0]!.id}`)).toBeTruthy();
      expect(getByTestId(`history-attachment-${events[1]!.id}`)).toBeTruthy();
      await waitFor(() => {
        expect(vi.mocked(getAuthedMediaUri)).toHaveBeenCalledWith(
          events[0]!.metadataJson.imageUri,
        );
        expect(vi.mocked(getAuthedMediaUri)).toHaveBeenCalledWith(
          events[1]!.metadataJson.imageUri,
        );
      });
    });

    it("plays migrated legacy videos from Files and keeps their history previews available", async () => {
      const { caseId, attachments, events } = migratedLegacyVideoContract;
      const migratedCase = {
        ...inProgressCase,
        id: caseId,
        events: [...inProgressCase.events, ...events],
      };
      setMockSearchParams({ id: caseId });
      setMockAppState({ cases: [migratedCase], invoices: [], attachments });

      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`media-open-${attachments[0]!.id}`)).toBeTruthy();
      expect(getByTestId(`media-open-${attachments[1]!.id}`)).toBeTruthy();
      await fireEvent.press(getByTestId(`img-open-${attachments[0]!.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
      await waitFor(() =>
        expect(vi.mocked(acquireAuthedMediaUri)).toHaveBeenCalledWith(
          `/api/cases/${caseId}/attachments/${attachments[0]!.id}/file`,
        ),
      );

      await fireEvent.press(getByTestId("section-tab-history"));
      for (const event of events) {
        expect(getByTestId(`history-attachment-${event.id}`)).toBeTruthy();
      }
      await waitFor(() => {
        for (const event of events) {
          expect(vi.mocked(getAuthedMediaUri)).toHaveBeenCalledWith(
            event.metadataJson.imageUri,
          );
        }
      });
      await fireEvent.press(getByTestId(`history-attachment-${events[1]!.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
    });
  });

  // ─── Merged remake timeline: media belongs to the event's own case ──────────
  // The History tab also renders the linked original case's events and each
  // remake child's events. The protected file route
  // (/api/cases/:caseId/attachments/:attachmentId/file) is scoped to the case
  // in its URL — that scoping is how the server authorizes the read — so a URL
  // built from the case on screen 404s for a linked case's attachment and the
  // thumbnail falls back to "Unavailable".
  describe("history attachments on a merged remake timeline", () => {
    const ORIGINAL_CASE_ID = "case-remake-original";
    const CHILD_CASE_ID = "case-remake-child";

    const originalPdfEvent = {
      id: "evt-att-original-pdf",
      caseId: ORIGINAL_CASE_ID,
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-original-pdf",
        fileName: "original_Rx.pdf",
        fileType: "application/pdf",
      },
      occurredAt: "2024-01-09T10:00:00.000Z",
    };
    const childPdfEvent = {
      id: "evt-att-child-pdf",
      caseId: CHILD_CASE_ID,
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-child-pdf",
        fileName: "child_Rx.pdf",
        fileType: "application/pdf",
      },
      occurredAt: "2024-01-13T10:00:00.000Z",
    };
    const originalImageEvent = {
      id: "evt-att-original-image",
      caseId: ORIGINAL_CASE_ID,
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-original-image",
        fileName: "original-photo.jpg",
        fileType: "image/jpeg",
      },
      occurredAt: "2024-01-10T10:00:00.000Z",
    };
    const originalVideoEvent = {
      id: "evt-att-original-video",
      caseId: ORIGINAL_CASE_ID,
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-original-video",
        fileName: "original-video.mp4",
        fileType: "video/mp4",
      },
      occurredAt: "2024-01-11T10:00:00.000Z",
    };
    const ownPdfEvent = {
      id: "evt-att-own-pdf",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-own-pdf",
        fileName: "own_Rx.pdf",
        fileType: "application/pdf",
      },
      occurredAt: "2024-01-12T10:00:00.000Z",
    };

    const remakeCase = {
      ...inProgressCase,
      id: "case-remake-viewed",
      events: [...inProgressCase.events, ownPdfEvent],
      originalCaseEvents: [
        originalPdfEvent,
        originalImageEvent,
        originalVideoEvent,
      ],
      remakeOriginal: { id: ORIGINAL_CASE_ID, caseNumber: "5000" },
      remakeChildrenEvents: [
        { caseId: CHILD_CASE_ID, caseNumber: "5001B", events: [childPdfEvent] },
      ],
    };

    beforeEach(() => {
      setMockSearchParams({ id: remakeCase.id });
      setMockAppState({ cases: [remakeCase], invoices: [] });
    });

    async function openFromHistory(eventId: string): Promise<string> {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      await fireEvent.press(getByTestId(`history-attachment-${eventId}`));
      await waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalled());
      const call = vi.mocked(router.push).mock.calls[0]![0] as {
        params?: { url?: string };
      };
      return String(call.params?.url ?? "");
    }

    it("opens an original case's attachment under the ORIGINAL case id", async () => {
      const url = await openFromHistory(originalPdfEvent.id);
      expect(url).toBe(
        `/api/cases/${ORIGINAL_CASE_ID}/attachments/${originalPdfEvent.metadataJson.attachmentId}/file`,
      );
      expect(url).not.toContain(remakeCase.id);
    });

    it("opens a remake child's attachment under the CHILD case id", async () => {
      const url = await openFromHistory(childPdfEvent.id);
      expect(url).toBe(
        `/api/cases/${CHILD_CASE_ID}/attachments/${childPdfEvent.metadataJson.attachmentId}/file`,
      );
      expect(url).not.toContain(remakeCase.id);
    });

    it("opens a linked original image standalone without adding gallery navigation", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      await fireEvent.press(getByTestId(`history-attachment-${originalImageEvent.id}`));
      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      expect(queryByTestId("lightbox-next")).toBeNull();
      expect(queryByTestId("lightbox-previous")).toBeNull();
    });

    it("opens a linked original video standalone with authenticated playback", async () => {
      const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-history"));
      await fireEvent.press(getByTestId(`history-attachment-${originalVideoEvent.id}`));
      await waitFor(() => expect(getByTestId("lightbox-video")).toBeTruthy());
      expect(queryByTestId("lightbox-next")).toBeNull();
      expect(queryByTestId("lightbox-previous")).toBeNull();
    });

    it("still opens the viewed case's own attachment under the viewed case id", async () => {
      const url = await openFromHistory(ownPdfEvent.id);
      expect(url).toBe(
        `/api/cases/${remakeCase.id}/attachments/${ownPdfEvent.metadataJson.attachmentId}/file`,
      );
    });
  });

  // ─── Generic (non-PDF, non-scan) document attachments ────────────────────────
  // These go through `openAttachment` → `getAuthedMediaUri` → local file:// URI
  // before the OS share sheet sees them. The contract: the raw API URL must
  // NEVER be passed directly to a browser tab or Linking.openURL — doing so
  // would produce a "401 Authentication Required" page for the user.
  describe("generic document attachments — auth-download path", () => {
    // A file that is neither an image, PDF, nor 3-D scan — goes through the
    // `openAttachment` / `getAuthedMediaUri` path regardless of platform.
    const docAttachment = {
      id: "att-docx-1",
      fileName: "treatment_plan.docx",
      fileType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };

    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [docAttachment],
      });
    });

    it("renders a tappable card for the generic document attachment", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`doc-open-${docAttachment.id}`)).toBeTruthy();
    });

    it("calls getAuthedMediaUri (auth-download) and shares via a local file URI — never opens a raw API URL in a browser", async () => {
      const { getByTestId } = await render(<CaseDetailScreen />);
      await fireEvent.press(getByTestId("section-tab-files"));
      await fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

      await waitFor(() => {
        // The auth-aware cache layer must be entered: verifies the code does
        // NOT skip straight to Linking.openURL / WebBrowser with the raw URL.
        expect(vi.mocked(getAuthedMediaUri)).toHaveBeenCalledWith(
          `/api/cases/${inProgressCase.id}/attachments/${docAttachment.id}/file`,
        );
        // The OS share sheet is reached only with a local file:// URI that was
        // produced by downloading (with auth) and then copying to a named path.
        expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalledWith(
          expect.stringMatching(/^file:\/\//),
          expect.any(Object),
        );
      });
    });

    it("shows a user-friendly error alert when the authenticated download fails (not a silent auth-error page)", async () => {
      // Simulate a failed download (e.g., network error or 401 after token expiry).
      vi.mocked(getAuthedMediaUri).mockResolvedValueOnce(null);

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith(
            "Couldn't open file",
            expect.stringContaining("could not be downloaded"),
          );
        });
        // The OS share sheet must not be invoked when the download fails.
        expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("shows a user-friendly alert when the OS share sheet is not available on the device", async () => {
      vi.mocked(Sharing.isAvailableAsync).mockResolvedValueOnce(false);

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = await render(<CaseDetailScreen />);
        await fireEvent.press(getByTestId("section-tab-files"));
        await fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith(
            "Can't open file",
            expect.stringContaining("supported"),
          );
        });
      } finally {
        alertSpy.mockRestore();
      }
    });
  });
});

describe("CaseDetailScreen custom remake reason flow", () => {
  const editCase = {
    ...inProgressCase,
    id: "case-custom-remake",
    labOrganizationId: "lab-custom-remake",
    remakeOriginal: { id: "original-case", caseNumber: "4999" },
    remakeReasonKey: "shade_wrong",
    remakeReason: "Shade was wrong",
    remakeCharged: false,
  };

  beforeEach(() => {
    setMockSearchParams({ id: editCase.id });
    setMockAppState({
      cases: [editCase],
      invoices: [],
      meMemberships: [{ organizationId: "lab-custom-remake", role: "admin", status: "active" }],
    });
  });

  async function openRemakeEditor() {
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByLabelText("Edit remake reason"));
    return screen;
  }

  it("reveals Other's custom field and hides stale text when switching to a standard reason", async () => {
    const screen = await openRemakeEditor();
    await fireEvent.press(screen.getByTestId("remake-reason-other-edit"));
    expect(
      screen.getByTestId("edit-remake-custom-reason").props.autoFocus,
    ).toBe(true);
    expect(
      screen.getByTestId("edit-remake-keyboard-aware-scroll").props.bottomOffset,
    ).toBe(72);
    expect(
      screen.getAllByPlaceholderText("Describe why this case is being remade").length,
    ).toBeGreaterThan(0);
    await fireEvent.changeText(
      screen.getAllByPlaceholderText("Describe why this case is being remade").at(-1)!,
      "temporary custom reason",
    );
    await fireEvent.press(screen.getByTestId("remake-reason-shade_wrong-edit"));
    expect(
      screen
        .queryAllByPlaceholderText("Describe why this case is being remade")
        .every((field) => field.props.value === ""),
    ).toBe(true);
    expect(screen.getAllByText("Shade — too light or too dark?").length).toBeGreaterThan(0);
  });

  it("focuses Other's custom field in the create-remake flow and clears it when switching reasons", async () => {
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("case-remake-btn"));
    await fireEvent.press(screen.getByTestId("remake-reason-other"));

    expect(
      screen.getByTestId("create-remake-custom-reason").props.autoFocus,
    ).toBe(true);
    expect(
      screen.getByTestId("create-remake-keyboard-aware-scroll").props.bottomOffset,
    ).toBe(72);

    await fireEvent.press(screen.getByTestId("remake-reason-shade_wrong"));
    expect(screen.queryByTestId("create-remake-custom-reason")).toBeNull();
  });

  it("does not submit a blank Other reason", async () => {
    let patchBody: unknown = null;
    setMockFetchHandler(async (url, init) => {
      if (url === `/api/cases/${editCase.id}` && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
      }
      return new Response(JSON.stringify({ data: editCase }), { status: 200 });
    });
    const screen = await openRemakeEditor();
    await fireEvent.press(screen.getByTestId("remake-reason-other-edit"));
    expect(screen.getByTestId("edit-remake-keyboard-aware-scroll").props.bottomOffset).toBe(72);
    expect(screen.getByText("Save Changes").parent?.props.accessibilityState?.disabled).not.toBe(true);
    await fireEvent.press(screen.getByText("Save Changes"));
    expect(patchBody).toBeNull();
    expect(screen.getByRole("alert", { name: "Enter a custom remake reason." })).toBeTruthy();
  });

  it("submits trimmed custom text with the Other key", async () => {
    let patchBody: any = null;
    setMockFetchHandler(async (url, init) => {
      if (url === `/api/cases/${editCase.id}` && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
      }
      return new Response(JSON.stringify({ data: editCase }), { status: 200 });
    });
    const screen = await openRemakeEditor();
    await fireEvent.press(screen.getByTestId("remake-reason-other-edit"));
    await fireEvent.changeText(
      screen.getAllByPlaceholderText("Describe why this case is being remade").at(-1)!,
      "  Open margin on distal unit  ",
    );
    await fireEvent.press(screen.getByText("Save Changes"));
    await waitFor(() =>
      expect(patchBody).toMatchObject({
        remakeReasonKey: "other",
        remakeReason: "Open margin on distal unit",
      }),
    );
  });

  it("hydrates a saved keyed custom reason into the editor", async () => {
    const savedCase = {
      ...editCase,
      remakeReasonKey: "other",
      remakeReason: "Custom reason saved on the case",
    };
    setMockAppState({
      cases: [savedCase],
      invoices: [],
      meMemberships: [{ organizationId: "lab-custom-remake", role: "admin", status: "active" }],
    });
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByLabelText("Edit remake reason"));
    expect(
      screen.getAllByDisplayValue("Custom reason saved on the case")[0],
    ).toBeTruthy();
  });
});

// ─── Restoration-type change invalidates the cases list (Task #3275) ─────────
//
// Restorations are embedded in the ["cases", id] response (DetailedCase.restorations).
// Changing a restoration's type also changes the DERIVED case type (e.g. crown →
// restorative).  That derived label is shown on the cases-list screen, so the list
// query ["cases"] must be invalidated after any restoration-type edit — not just the
// ── Unpriced-alloy badge (Task #3611) ─────────────────────────────────────────
// When a PFM/FCM invoice has an alloy sub-item with priced:false the screen
// should show a persistent amber reminder badge so techs notice before billing.
describe("unpriced-alloy badge", () => {
  it("shows the badge when the invoice has an Alloy sub-item with priced:false", async () => {
    setMockSearchParams({ id: pfmCaseWithUnpricedAlloyInvoice.id });
    setMockAppState({
      cases: [pfmCaseWithUnpricedAlloyInvoice],
      invoices: [invoiceWithUnpricedAlloySub],
    });
    const { getByTestId } = await render(<CaseDetailScreen />);
    expect(getByTestId("unpriced-alloy-badge")).toBeTruthy();
  });

  it("hides the badge when no invoice lines have priced:false on an Alloy description", async () => {
    setMockSearchParams({ id: completedCaseWithInvoice.id });
    setMockAppState({
      cases: [completedCaseWithInvoice],
      invoices: [sampleInvoice],
    });
    const { queryByTestId } = await render(<CaseDetailScreen />);
    expect(queryByTestId("unpriced-alloy-badge")).toBeNull();
  });

  it("hides the badge when there is no invoice at all", async () => {
    setMockSearchParams({ id: inProgressCase.id });
    setMockAppState({ cases: [inProgressCase], invoices: [] });
    const { queryByTestId } = await render(<CaseDetailScreen />);
    expect(queryByTestId("unpriced-alloy-badge")).toBeNull();
  });

  it("badge is visible regardless of which section tab is active", async () => {
    setMockSearchParams({ id: pfmCaseWithUnpricedAlloyInvoice.id });
    setMockAppState({
      cases: [pfmCaseWithUnpricedAlloyInvoice],
      invoices: [invoiceWithUnpricedAlloySub],
    });
    const { getByTestId, queryByTestId } = await render(<CaseDetailScreen />);
    // Default tab is overview — badge still visible.
    expect(getByTestId("unpriced-alloy-badge")).toBeTruthy();
    // Switch to restorations tab — badge still visible.
    await fireEvent.press(getByTestId("section-tab-restorations"));
    expect(queryByTestId("unpriced-alloy-badge")).toBeTruthy();
    // Switch to notes tab — badge still visible.
    await fireEvent.press(getByTestId("section-tab-notes"));
    expect(queryByTestId("unpriced-alloy-badge")).toBeTruthy();
  });
});

describe("RestorationsSection — live invoice totals", () => {
  const editableCase = { ...inProgressCase, organizationId: "org-1" };
  const invoiceBeforeEdit = {
    ...sampleInvoice,
    id: "inv-live-refresh",
    caseId: editableCase.id,
    invoiceNumber: "INV-LIVE-001",
    status: "draft",
    total: 500,
    balanceDue: 500,
  };
  const invoiceAfterEdit = {
    ...invoiceBeforeEdit,
    total: 625,
    balanceDue: 625,
  };

  beforeEach(() => {
    mockUpdateCaseRestorationMutateAsync.mockReset();
    mockUpdateCaseRestorationMutateAsync.mockResolvedValue(undefined);
    setMockSearchParams({ id: editableCase.id });
    setMockAppState({
      cases: [editableCase],
      invoices: [invoiceBeforeEdit],
      liveInvoiceQueries: true,
      meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
    });
  });

  async function renderWithLiveInvoiceQueries() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(queryClient, "invalidateQueries");
    const rendered = await render(
      <QueryClientProvider client={queryClient}>
        <CaseDetailScreen />
      </QueryClientProvider>,
    );
    return { ...rendered, queryClient };
  }

  it("updates the visible invoice total and balance after a successful restoration edit", async () => {
    mockUpdateCaseRestorationMutateAsync.mockImplementation(async () => {
      setMockAppState({ invoices: [invoiceAfterEdit] });
      return undefined;
    });

    const { getByTestId, getAllByText, queryClient } =
      await renderWithLiveInvoiceQueries();
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(getByTestId("section-tab-restorations"));
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Full Denture");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));
    await waitFor(() =>
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalled(),
    );
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$625.00").length).toBeGreaterThanOrEqual(2);
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("updates the visible invoice total and balance after a successful material edit", async () => {
    mockUpdateCaseRestorationMutateAsync.mockImplementation(async () => {
      setMockAppState({ invoices: [invoiceAfterEdit] });
      return undefined;
    });

    const { getByTestId, getAllByText, queryClient } =
      await renderWithLiveInvoiceQueries();
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(getByTestId("section-tab-restorations"));
    await fireEvent.press(getByTestId("edit-restoration-material-rest-1"));
    await fireEvent.changeText(
      getByTestId("edit-material-input-rest-1"),
      "E.max",
    );
    await fireEvent.press(getByTestId("save-restoration-material-rest-1"));
    await waitFor(() =>
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalled(),
    );
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$625.00").length).toBeGreaterThanOrEqual(2);
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("keeps the prior invoice total and balance when the restoration edit fails", async () => {
    mockUpdateCaseRestorationMutateAsync.mockRejectedValue(
      new Error("Network error"),
    );

    const { getByTestId, getAllByText, queryByText, queryClient } =
      await renderWithLiveInvoiceQueries();
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(getByTestId("section-tab-restorations"));
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Full Denture");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    await waitFor(() =>
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalled(),
    );
    await fireEvent.press(getByTestId("section-tab-invoice"));
    expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    expect(queryByText("$625.00")).toBeNull();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("keeps the prior invoice total and balance when the material edit fails", async () => {
    mockUpdateCaseRestorationMutateAsync.mockRejectedValue(
      new Error("Network error"),
    );

    const { getByTestId, getAllByText, queryByText, queryClient } =
      await renderWithLiveInvoiceQueries();
    await fireEvent.press(getByTestId("section-tab-invoice"));

    await waitFor(() => {
      expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(getByTestId("section-tab-restorations"));
    await fireEvent.press(getByTestId("edit-restoration-material-rest-1"));
    await fireEvent.changeText(
      getByTestId("edit-material-input-rest-1"),
      "E.max",
    );
    await fireEvent.press(getByTestId("save-restoration-material-rest-1"));

    await waitFor(() =>
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalled(),
    );
    await fireEvent.press(getByTestId("section-tab-invoice"));
    expect(getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    expect(queryByText("$625.00")).toBeNull();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });
});

// single-case detail refetch that onSaved() already performs.
//
// This test asserts the FULL invalidation set: both the detail refetch (via
// mockUpdateCaseRestorationMutateAsync being called) AND the list invalidation (via
// the captured invalidateQueries spy).  If a future refactor adds a separate
// restoration query key it will need to appear here too.
describe("RestorationsSection — restoration-type change invalidates ['cases'] list", () => {
  // A single shared spy so we can assert across all useQueryClient() call sites
  // inside the rendered tree (RestorationsSection, OverviewSection, etc.).
  const mockInvalidateQueries = vi.fn(async (_arg: { queryKey: unknown[] }) => undefined);

  const editableCase = { ...inProgressCase, organizationId: "org-1" };

  beforeEach(() => {
    mockInvalidateQueries.mockReset();
    mockUpdateCaseRestorationMutateAsync.mockReset();
    mockUpdateCaseRestorationMutateAsync.mockResolvedValue(undefined);

    // Make every useQueryClient() call in the tree return the SAME spy so we
    // can assert on it regardless of which sub-component holds the client.
    vi.mocked(useQueryClient).mockReturnValue({
      invalidateQueries: mockInvalidateQueries,
      setQueryData: vi.fn(),
      getQueryData: vi.fn(() => undefined),
    } as unknown as ReturnType<typeof useQueryClient>);

    setMockSearchParams({ id: editableCase.id });
    setMockAppState({
      cases: [editableCase],
      invoices: [],
      meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
    });
  });

  afterEach(async () => {
    await flushPendingReactUpdates();
    cleanup();
    resetMockAppState();
    resetMockFetchHandler();
    vi.clearAllMocks();
  });

  it("calls useUpdateCaseRestoration with the new type when the inline type editor is saved", async () => {
    const { getByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-restorations"));

    // Open the inline type editor for the first restoration (id "rest-1").
    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Full Denture");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    await waitFor(() => {
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledWith({
        caseId: editableCase.id,
        restorationId: "rest-1",
        data: expect.objectContaining({ restorationType: "Full Denture" }),
      });
    });
  });

  it("invalidates the ['cases'] list query after a successful restoration-type save", async () => {
    // This is the key regression guard: a restoration-type change re-derives the
    // case type, so the list cache must be invalidated — not just the detail refetched.
    const { getByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-restorations"));

    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Full Denture");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    await waitFor(() => {
      const keys = mockInvalidateQueries.mock.calls.map((c) => c[0]);
      expect(keys).toContainEqual({ queryKey: ["cases"] });
      expect(keys).toContainEqual({ queryKey: ["invoices"] });
    });
  });

  it("does NOT invalidate ['cases'] when the save fails", async () => {
    mockUpdateCaseRestorationMutateAsync.mockRejectedValue(
      new Error("Network error"),
    );

    const { getByTestId } = await render(<CaseDetailScreen />);
    await fireEvent.press(getByTestId("section-tab-restorations"));

    await fireEvent.press(getByTestId("edit-restoration-type-rest-1"));
    await fireEvent.changeText(getByTestId("edit-type-input-rest-1"), "Full Denture");
    await fireEvent.press(getByTestId("save-restoration-type-rest-1"));

    // Wait for the mutation to settle.
    await waitFor(() =>
      expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalled(),
    );
    // No cache invalidation on a failed save — stale data stays until a
    // successful write clears it.
    const keys = mockInvalidateQueries.mock.calls.map((c) => c[0]);
    expect(keys).not.toContainEqual({ queryKey: ["cases"] });
    expect(keys).not.toContainEqual({ queryKey: ["invoices"] });
  });
});

// ── Removable lab-slip Step + always-visible hierarchy rows (Task #3980) ─────
//
// The server gates `step`/`stepShade` on admin/owner of the case's lab, while
// the case hierarchy (type / subtype / material) only needs an editor role.
// These tests pin both gates, the option list, the save payload and the
// wax-setup-only shade rule.
describe("OverviewSection — removable Step row", () => {
  const adminMemberships = [
    { organizationId: "org-1", role: "owner", status: "active" },
  ];
  const nonAdminEditorMemberships = [
    { organizationId: "org-1", role: "billing", status: "active" },
  ];

  beforeEach(() => {
    mockUpdateCaseMutateAsync.mockReset();
    mockUpdateCaseMutateAsync.mockResolvedValue({ ok: true, data: null });
  });

  afterEach(async () => {
    await flushPendingReactUpdates();
    cleanup();
    setMockSearchParams({});
    resetMockAppState();
    resetMockFetchHandler();
    vi.clearAllMocks();
  });

  async function renderCase(
    caseFixture: Record<string, unknown>,
    memberships?: Array<Record<string, unknown>>,
  ) {
    setMockSearchParams({ id: caseFixture.id as string });
    setMockAppState({
      cases: [caseFixture],
      invoices: [],
      ...(memberships ? { meMemberships: memberships } : {}),
    });
    return await render(<CaseDetailScreen />);
  }

  it("shows an em dash for a case with no step", async () => {
    const { getByTestId } = await renderCase(removableCaseNoStep, adminMemberships);
    expect(within(getByTestId("step-select")).getByText("—")).toBeTruthy();
  });

  it("renders the step as a picker for an admin", async () => {
    const admin = await renderCase(removableCaseProcessStep, adminMemberships);
    expect(admin.getByTestId("step-select")).toBeTruthy();
    expect(within(admin.getByTestId("step-select")).getByText("Process")).toBeTruthy();
    expect(admin.queryByTestId("step-value")).toBeNull();
  });

  it("renders the step as plain text for a non-admin editor", async () => {
    // A billing-role editor may change the hierarchy but NOT the step — the
    // server rejects it, so mobile must not offer the control.
    const editor = await renderCase(removableCaseProcessStep, nonAdminEditorMemberships);
    expect(editor.queryByTestId("step-select")).toBeNull();
    expect(editor.getByTestId("step-value")).toHaveTextContent("Process");
  });

  it("offers the four desktop step options plus a clear choice", async () => {
    const { getByTestId } = await renderCase(removableCaseNoStep, adminMemberships);
    await fireEvent.press(getByTestId("step-select"));

    expect(getByTestId("step-option-custom_tray")).toHaveTextContent("Custom Tray");
    expect(getByTestId("step-option-rims_and_plates")).toHaveTextContent(
      "Rims and Plates",
    );
    expect(getByTestId("step-option-wax_setup")).toHaveTextContent("Wax Setup");
    expect(getByTestId("step-option-process")).toHaveTextContent("Process");
    expect(getByTestId("step-option-none")).toBeTruthy();
  });

  it("saves the chosen step through the canonical case update", async () => {
    const { getByTestId } = await renderCase(removableCaseNoStep, adminMemberships);
    await fireEvent.press(getByTestId("step-select"));
    await fireEvent.press(getByTestId("step-option-wax_setup"));

    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: removableCaseNoStep.id,
        data: { step: "wax_setup" },
      });
    });
  });

  it("clears the step with the 'no step' choice", async () => {
    const { getByTestId } = await renderCase(removableCaseProcessStep, adminMemberships);
    await fireEvent.press(getByTestId("step-select"));
    await fireEvent.press(getByTestId("step-option-none"));

    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: removableCaseProcessStep.id,
        data: { step: null },
      });
    });
  });

  it("surfaces an alert and leaves the row on the server value when the save fails", async () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockUpdateCaseMutateAsync.mockRejectedValue(new Error("Forbidden"));

    const { getByTestId } = await renderCase(removableCaseProcessStep, adminMemberships);
    await fireEvent.press(getByTestId("step-select"));
    await fireEvent.press(getByTestId("step-option-custom_tray"));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // The row keeps rendering the server's value rather than the failed choice.
    expect(within(getByTestId("step-select")).getByText("Process")).toBeTruthy();
    alertSpy.mockRestore();
  });

  it("shows an editable shade while the step is Wax Setup", async () => {
    const wax = await renderCase(removableCaseWaxSetup, adminMemberships);
    expect(wax.getByTestId("step-shade-input").props.value).toBe("A2");
  });

  it("drops the shade entirely once the step moves past Wax Setup", async () => {
    const process = await renderCase(removableCaseProcessStep, adminMemberships);
    expect(process.queryByTestId("step-shade-input")).toBeNull();
    expect(process.queryByTestId("step-shade-value")).toBeNull();
  });

  it("shows the wax-setup shade read-only for a non-admin viewer", async () => {
    const { queryByTestId, getByTestId } = await renderCase(
      removableCaseWaxSetup,
      nonAdminEditorMemberships,
    );
    expect(queryByTestId("step-shade-input")).toBeNull();
    expect(getByTestId("step-shade-value")).toHaveTextContent("Shade: A2");
  });

  it("saves the wax-setup shade through the case update", async () => {
    const { getByTestId } = await renderCase(removableCaseWaxSetup, adminMemberships);
    await fireEvent.changeText(getByTestId("step-shade-input"), "B1");
    await fireEvent(getByTestId("step-shade-input"), "blur");

    await waitFor(() => {
      expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
        caseId: removableCaseWaxSetup.id,
        data: { stepShade: "B1" },
      });
    });
  });

  it("saves the shade once when submitting also blurs the field", async () => {
    // A single-line TextInput fires onSubmitEditing AND onBlur for one submit,
    // in the same tick. Two PATCHes would write two step-shade history events
    // for one user edit, so the commit must be guarded while in flight.
    const { getByTestId } = await renderCase(removableCaseWaxSetup, adminMemberships);
    await fireEvent.changeText(getByTestId("step-shade-input"), "B1");
    // Dispatch both native callbacks in the same act scope. Awaiting the first
    // async event would let its mutation finish before the blur callback runs,
    // which is not the single-submit event sequence this regression covers.
    await act(async () => {
      fireEvent(getByTestId("step-shade-input"), "submitEditing");
      fireEvent(getByTestId("step-shade-input"), "blur");
      await Promise.resolve();
    });

    await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalled());
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("OverviewSection — hierarchy rows are always present", () => {
  beforeEach(() => {
    vi.mocked(useQueryClient).mockImplementation(sharedQueryClientImplementation);
    mockUpdateCaseRestorationMutateAsync.mockReset();
    mockUpdateCaseRestorationMutateAsync.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await flushPendingReactUpdates();
    cleanup();
    setMockSearchParams({});
    resetMockAppState();
    resetMockFetchHandler();
    vi.clearAllMocks();
  });

  async function renderCase(
    caseFixture: Record<string, unknown>,
    memberships?: Array<Record<string, unknown>>,
    organizations?: Array<Record<string, unknown>>,
  ) {
    setMockSearchParams({ id: caseFixture.id as string });
    setMockAppState({
      cases: [caseFixture],
      invoices: [],
      ...(memberships ? { meMemberships: memberships } : {}),
      ...(organizations ? { organizations } : {}),
    });
    return await render(<CaseDetailScreen />);
  }

  it("renders Case type, Subtype and Material type with placeholders when unset", async () => {
    const { getByTestId } = await renderCase(removableCaseNoHierarchy, [
      { organizationId: "org-1", role: "owner", status: "active" },
    ]);
    expect(getByTestId("hierarchy-casetype-value")).toHaveTextContent("—");
    expect(getByTestId("hierarchy-subtype-value")).toHaveTextContent("—");
    expect(getByTestId("hierarchy-material-value")).toHaveTextContent("—");
  });

  it("saves a type on an empty case directly in view mode and keeps the full editor separate", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    setMockFetchHandler((url, init) => {
      if (url.endsWith("/restorations/hierarchy")) {
        requests.push({ url, body: JSON.parse(init?.body as string) });
        return new Response(JSON.stringify({ data: {
          invoiceAction: "created", repricedCount: 0, manualPriceCount: 0, unpricedCount: 0,
        } }));
      }
      return new Response(JSON.stringify({ data: null }));
    });
    const view = await renderCase({ ...removableCaseNoHierarchy, restorations: [] }, [
      { organizationId: "org-1", role: "owner", status: "active" },
    ]);
    await fireEvent.press(view.getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(view.getByTestId("quick-type-restorative"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toEqual({
      restorationType: "Crown", restorationSubtype: null, material: null, toothNumbers: [],
    });
    expect(mockUpdateCaseRestorationMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoices"] }));
    // The save has already happened without opening the full editor.
    expect(view.queryByTestId("clinical-details-editor")).toBeNull();
    await fireEvent.press(view.getByTestId("overview-edit"));
    expect(view.queryByTestId("view-hierarchy-picker")).toBeNull();
    expect(view.getByTestId("clinical-details-editor")).toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it("shows practice, received date, ordered hierarchy, priority, and prescription notes", async () => {
    const caseNotes = "Keep the lingual contour light.";
    const detailCase = {
      ...removableCaseNoStep,
      providerOrganizationId: "practice-1",
      receivedAt: new Date(2026, 1, 18, 12).toISOString(),
      caseNotes,
      restorations: [
        {
          ...removableCaseNoStep.restorations[0],
          arch: "upper",
          shade: "A2",
        },
      ],
    };
    const { getByText, getByTestId } = await renderCase(
      detailCase,
      undefined,
      [
        {
          id: "practice-1",
          name: "Willow Dental",
          displayName: "Willow Dental",
        },
      ],
    );

    expect(getByText("Case Details")).toBeTruthy();
    await waitFor(() => expect(getByText("Willow Dental")).toBeTruthy());
    expect(getByText("Received Date")).toBeTruthy();
    expect(getByText("02/18/2026")).toBeTruthy();
    expect(getByTestId("hierarchy-casetype-value")).toBeTruthy();
    expect(getByTestId("hierarchy-subtype-value")).toBeTruthy();
    expect(getByTestId("hierarchy-material-value")).toBeTruthy();
    expect(getByTestId("hierarchy-arch-value")).toHaveTextContent("Upper");
    expect(getByTestId("overview-priority")).toHaveTextContent(/Standard/);
    expect(getByText("Rx Notes")).toBeTruthy();
    expect(getByText(caseNotes)).toBeTruthy();
  });

  it("shows Rush priority for a rush case", async () => {
    const rushCase = { ...removableCaseNoStep, priority: "rush" };
    const { getByTestId } = await renderCase(rushCase, [
      { organizationId: "org-1", role: "owner", status: "active" },
    ]);

    expect(getByTestId("overview-priority")).toHaveTextContent(/Rush/);
  });

  it("shows both arches for a removable case with upper and lower restorations", async () => {
    const firstRestoration = {
      ...removableCaseNoStep.restorations[0],
      arch: "upper",
    };
    const bothArchCase = {
      ...removableCaseNoStep,
      id: "case-both-arches",
      restorations: [
        firstRestoration,
        { ...firstRestoration, id: "rest-removable-lower", arch: "lower" },
      ],
    };
    const { getByTestId } = await renderCase(bothArchCase, [
      { organizationId: "org-1", role: "owner", status: "active" },
    ]);

    expect(getByTestId("hierarchy-arch-value")).toHaveTextContent(
      "Upper + Lower",
    );
  });

  it("retains the custom shade details only when Custom Shade is selected", async () => {
    const customShadeCase = {
      ...inProgressCase,
      id: "case-custom-shade",
      labOrganizationId: "org-1",
      isCustomShade: true,
      customShadeTechnician: "Jordan Lee",
      customShadePicturesAvailable: true,
      customShadeVideoAvailable: false,
    };
    const { getByDisplayValue, getByTestId, getByText } = await renderCase(
      customShadeCase,
      [{ organizationId: "org-1", role: "owner", status: "active" }],
    );

    expect(
      getByTestId("custom-shade-toggle").props.accessibilityState,
    ).toEqual({ checked: true });
    expect(getByText("Technician name")).toBeTruthy();
    expect(getByDisplayValue("Jordan Lee")).toBeTruthy();
    expect(getByText("Pictures available")).toBeTruthy();
    expect(getByText("Video available")).toBeTruthy();

    expect(
      within(getByTestId("tooth-shade-custom-shade")).getByTestId("custom-shade-toggle"),
    ).toBeTruthy();
  });

  it("keeps a single Custom Shade flag beside the tooth rows and hides its details when unselected", async () => {
    const ordinaryShadeCase = {
      ...inProgressCase,
      id: "case-standard-shade",
      labOrganizationId: "org-1",
      isCustomShade: false,
    };
    const { getByTestId, queryByText, getByText } = await renderCase(
      ordinaryShadeCase,
      [{ organizationId: "org-1", role: "owner", status: "active" }],
    );

    expect(
      getByTestId("custom-shade-toggle").props.accessibilityState,
    ).toEqual({ checked: false });
    const pairing = getByTestId("tooth-shade-custom-shade");
    expect(within(pairing).getByTestId("custom-shade-toggle")).toBeTruthy();
    expect(within(pairing).getByTestId("tooth-shade-label-rest-1")).toHaveTextContent("8");
    expect(within(pairing).getByTestId("tooth-shade-label-rest-2")).toHaveTextContent("9");
    expect(queryByText("Technician name")).toBeNull();
    expect(queryByText("Pictures available")).toBeNull();
    expect(queryByText("Video available")).toBeNull();
    expect(getByText("Custom Shade")).toBeTruthy();
  });

  it("exposes the type and matching subtype controls for an editor", async () => {
    const { getByTestId, queryByTestId } = await renderCase(removableCaseNoStep, [
      { organizationId: "org-1", role: "billing", status: "active" },
    ]);
    expect(getByTestId("hierarchy-edit-btn")).toBeTruthy();
    expect(getByTestId("hierarchy-edit-subtype-btn")).toBeTruthy();
    // Material becomes actionable only after a catalog subtype has materials.
    expect(queryByTestId("hierarchy-edit-material-btn")).toBeNull();
  });

  it("hides the hierarchy edit affordances from a read-only viewer", async () => {
    const { queryByTestId } = await renderCase(removableCaseNoStep);
    expect(queryByTestId("hierarchy-edit-btn")).toBeNull();
    expect(queryByTestId("hierarchy-edit-subtype-btn")).toBeNull();
    expect(queryByTestId("hierarchy-edit-material-btn")).toBeNull();
  });

  it("shows mixed hierarchy values and applies a case-level edit to every restoration", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    setMockFetchHandler((url, init) => {
      if (url.endsWith("/restorations/hierarchy")) {
        requests.push({ url, init });
        return new Response(JSON.stringify({ data: {
          invoiceAction: "updated", repricedCount: 2, manualPriceCount: 0, unpricedCount: 0,
        } }));
      }
      return new Response(JSON.stringify({ data: null }));
    });
    const multiRestorationCase = {
      ...removableCaseNoStep,
      id: "case-mixed-hierarchy",
      restorations: [
        removableCaseNoStep.restorations[0],
        {
          ...removableCaseNoStep.restorations[0],
          id: "rest-removable-2",
          restorationType: "Crown",
        },
      ],
    };
    const { getByTestId } = await renderCase(multiRestorationCase, [
      { organizationId: "org-1", role: "owner", status: "active" },
    ]);

    expect(getByTestId("hierarchy-casetype-value")).toHaveTextContent("Multiple");
    expect(getByTestId("hierarchy-subtype-value")).toHaveTextContent("Multiple");
    expect(getByTestId("hierarchy-material-value")).toHaveTextContent("Multiple");

    await fireEvent.press(getByTestId("hierarchy-edit-btn"));
    await fireEvent.press(getByTestId("quick-type-restorative"));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].url).toBe("/api/cases/case-mixed-hierarchy/restorations/hierarchy");
    expect(mockUpdateCaseRestorationMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoices"] }));
  });
});

describe("mobile Lab Slip refinement", () => {
  const owner = [{ organizationId: "org-1", role: "owner", status: "active" }];
  const detail = {
    ...inProgressCase,
    id: "mobile-slip",
    caseNumber: "26-777",
    labOrganizationId: "org-1",
    providerOrganizationId: "practice-linked",
    labLocationId: "loc-polish",
    labLocationName: "Polishing Bench",
    status: "qc",
    dueDate: "2026-10-04",
    dueTime: "14:30",
    caseNotes: "Deliver with light occlusal contacts.",
    restorations: [
      { ...inProgressCase.restorations[0], id: "shade-4", toothNumber: "4", shade: "A1" },
      { ...inProgressCase.restorations[1], id: "shade-29", toothNumber: "29", shade: "B1" },
    ],
    providerOrganizationContact: {
      name: "Linked Dental",
      addressLine1: "120 Main St",
      addressLine2: "Suite 4",
      city: "Austin",
      state: "TX",
      zip: "78701",
      phone: "5125550143",
    },
  };

  beforeEach(() => {
    vi.mocked(useQueryClient).mockImplementation(sharedQueryClientImplementation);
    resetMockAppState();
    mockUpdateCaseMutateAsync.mockReset();
    mockUpdateCaseMutateAsync.mockResolvedValue({ ok: true, data: null });
    mockUpdateCaseRestorationMutateAsync.mockReset();
    mockUpdateCaseRestorationMutateAsync.mockResolvedValue(undefined);
    setMockFetchHandler(locationsOnlyHandler());
    setMockSearchParams({ id: detail.id });
    setMockAppState({
      cases: [detail],
      invoices: [],
      meMemberships: owner,
      shadeVocabulary: ["A1", "A2", "B1"].map((value) => ({ value, kind: "shade", id: value })),
      organizations: [{
        id: "other-practice",
        name: "Wrong Dental",
        addressLine1: "999 Wrong Way",
        phone: "5559999999",
      }],
    });
  });

  afterEach(async () => {
    await flushPendingReactUpdates();
    await cleanup();
    resetMockAppState();
    resetMockFetchHandler();
    setMockSearchParams({});
    vi.restoreAllMocks();
  });

  it("edits blank clinical details and prescription notes together and reports invoice creation", async () => {
    setMockAppState({ cases: [{ ...detail, restorations: [], step: null, stepShade: null, gingivialShade: null }] });
    const requests: Array<Record<string, unknown>> = [];
    setMockFetchHandler((url, init) => {
      if (url.endsWith("/restorations/hierarchy")) {
        requests.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ data: {
          invoiceAction: "created", repricedCount: 2, manualPriceCount: 0, unpricedCount: 0,
        } }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("overview-edit"));
    expect(screen.getByTestId("overview-details-card")).toBeTruthy();
    expect(screen.getByText("Patient & Provider")).toBeTruthy();
    expect(screen.getByText("Schedule & Priority")).toBeTruthy();
    expect(screen.getByText("Restoration Details")).toBeTruthy();
    expect(screen.getByText("Rx Notes")).toBeTruthy();
    expect(screen.getByTestId("clinical-details-editor")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("clinical-case-type-removable"));
    await fireEvent.press(screen.getByTestId("clinical-subtype-dentures"));
    await fireEvent.press(screen.getByTestId("clinical-case-material-acrylic"));
    await fireEvent.press(screen.getByTestId("clinical-arch-both"));
    await fireEvent.press(screen.getByTestId("clinical-step-wax_setup"));
    await fireEvent.changeText(screen.getByTestId("clinical-stepShade"), "A2");
    await fireEvent.changeText(screen.getByTestId("clinical-shade"), "B1");
    await fireEvent.changeText(screen.getByTestId("clinical-teeth"), "8, 9");
    await fireEvent.changeText(screen.getByTestId("clinical-rx-notes"), "New prescription notes");
    await fireEvent.changeText(screen.getByTestId("clinical-gingival-shade"), "G2");
    await fireEvent.press(screen.getByTestId("overview-save"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      restorationType: "Dentures", material: "Acrylic", arch: "upper_lower", step: "wax_setup", stepShade: "A2",
      shade: "B1", toothNumbers: ["8", "9"],
    });
    expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: detail.id, data: { rxNotes: "New prescription notes", gingivialShade: "G2" },
    });
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Clinical details saved", expect.stringContaining("Invoice created."),
    ));
    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoice-for-case", detail.id] }));
    expect(screen.queryByTestId("clinical-details-editor")).toBeNull();
  });

  it("reports reviewed invoice protection and preserves unchanged per-tooth shades", async () => {
    const requests: Array<Record<string, unknown>> = [];
    setMockFetchHandler((url, init) => {
      if (url.endsWith("/restorations/hierarchy")) {
        requests.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ data: {
          invoiceAction: "needs_review", repricedCount: 1, manualPriceCount: 1, unpricedCount: 0,
        } }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("overview-edit"));
    await fireEvent.press(screen.getByTestId("clinical-case-type-ortho"));
    await fireEvent.press(screen.getByTestId("clinical-arch-upper"));
    await fireEvent.press(screen.getByTestId("overview-save"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).not.toHaveProperty("shade");
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Invoice review required", expect.stringContaining("flagged for review and left unchanged"),
    ));
  });

  it("keeps the editor open after a refused clinical save without refreshing financial data", async () => {
    setMockFetchHandler((url) => new Response(JSON.stringify(
      url.endsWith("/restorations/hierarchy") ? { message: "Clinical edit refused." } : { data: [] },
    ), { status: url.endsWith("/restorations/hierarchy") ? 409 : 200 }));
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<CaseDetailScreen />);
    await fireEvent.press(screen.getByTestId("overview-edit"));
    await fireEvent.changeText(screen.getByTestId("clinical-shade"), "A3");
    mockInvalidateQueries.mockClear();
    await fireEvent.press(screen.getByTestId("overview-save"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't save changes", "Clinical edit refused."));
    expect(screen.getByTestId("clinical-details-editor")).toBeTruthy();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("keeps routing in the header and orders schedule, practice and tooth controls without duplicate sections", async () => {
    const screen = await render(<CaseDetailScreen />);
    await waitFor(() => expect(screen.getByTestId("locate-select")).toBeTruthy());
    expect(screen.getByTestId("overview-date-created")).toHaveTextContent(/Date Created:/);
    expect(screen.getByTestId("overview-due-date")).toHaveTextContent(/2:30 PM/);
    expect(screen.getByTestId("overview-priority")).toHaveTextContent(/Standard/);
    expect(screen.getAllByTestId("locate-select")).toHaveLength(1);
    // The independently retained Rx Preview also has a case-number label.
    expect(within(screen.getByTestId("overview-details-card")).getAllByText("Case #")).toHaveLength(1);
    expect(screen.getAllByText("Rx Notes")).toHaveLength(1);
    // The retained station picker has one title; the redundant lower card is gone.
    expect(screen.getAllByText("Locate Case")).toHaveLength(1);
    expect(screen.queryByText("Prescription Notes")).toBeNull();
    expect(screen.queryByText("Tooth number(s)")).toBeNull();
    expect(screen.queryByTestId("overview-latest-note")).toBeNull();
    const ids = [
      "case-header-patient",
      "case-header-location",
      "overview-schedule",
      "overview-patient-doctor-practice",
      "overview-practice-contact",
      "overview-restoration-details",
      "tooth-shade-custom-shade",
      "overview-rx-notes",
    ];
    // Only serialize the host layout identity, not React elements/callbacks
    // stored in props (which carry circular Fiber ownership references).
    const tree = JSON.stringify(screen.toJSON(), (key, value) =>
      key === "props" ? { testID: value.testID } : value,
    );
    for (let i = 1; i < ids.length; i += 1) {
      expect(tree.indexOf(ids[i])).toBeGreaterThan(tree.indexOf(ids[i - 1]));
    }
    expect(StyleSheet.flatten(screen.getByTestId("overview-schedule").props.style).flexWrap).toBe("wrap");
    expect(StyleSheet.flatten(screen.getByTestId("overview-schedule").props.style).padding).toBeGreaterThan(0);
    expect(StyleSheet.flatten(screen.getByTestId("overview-restoration-details").props.style).borderWidth).toBeGreaterThan(0);
    expect(StyleSheet.flatten(screen.getByTestId("overview-patient-provider-grid").props.style)).toMatchObject({
      flexDirection: "row",
      flexWrap: "wrap",
      gap: expect.any(Number),
    });
    const patientField = screen.getByTestId("overview-patient-details");
    expect(StyleSheet.flatten(patientField.props.style)).toMatchObject({
      flexGrow: 1,
      minWidth: expect.any(Number),
    });
    expect(StyleSheet.flatten(screen.getByTestId("tooth-shade-custom-shade").props.style).flexWrap).toBe("wrap");
  });

  it("uses the case-authorized practice contact when the linked practice is absent from the list", async () => {
    const screen = await render(<CaseDetailScreen />);
    const practice = within(screen.getByTestId("overview-practice-contact"));
    expect(practice.getByText("Linked Dental")).toBeTruthy();
    expect(practice.getByText("120 Main St")).toBeTruthy();
    expect(practice.getByText("Suite 4")).toBeTruthy();
    expect(practice.getByText("Austin, TX 78701")).toBeTruthy();
    expect(practice.getByText("(512) 555-0143")).toBeTruthy();
    expect(screen.queryByText("999 Wrong Way")).toBeNull();
    expect(screen.queryByText("Wrong Dental")).toBeNull();
  });

  it("never carries the previous practice's contact over to a different linked identity", async () => {
    const screen = await render(<CaseDetailScreen />);
    setMockAppState({
      cases: [{ ...detail, providerOrganizationId: "practice-new", providerOrganizationContact: null }],
      organizations: [{ id: "practice-new", name: "New Dental" }],
    });
    await screen.rerender(<CaseDetailScreen />);
    const practice = within(screen.getByTestId("overview-practice-contact"));
    expect(practice.getByText("New Dental")).toBeTruthy();
    expect(screen.queryByText("120 Main St")).toBeNull();
    expect(screen.queryByText("(512) 555-0143")).toBeNull();
    expect(practice.getByText("No address or phone on file.")).toBeTruthy();
  });

  it("saves both AI-intake shades by restoration identity and retains them when reopened", async () => {
    const screen = await render(<CaseDetailScreen />);
    expect(screen.getByTestId("tooth-shade-select-shade-4")).toHaveTextContent("A1");
    expect(screen.getByTestId("tooth-shade-select-shade-29")).toHaveTextContent("B1");
    await fireEvent.press(screen.getByTestId("tooth-shade-select-shade-4"));
    await fireEvent.press(screen.getByTestId("tooth-shade-option-shade-4-A2"));
    await waitFor(() => expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByTestId("tooth-shade-select-shade-29"));
    await fireEvent.press(screen.getByTestId("tooth-shade-option-shade-29-A1"));
    await waitFor(() => expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenNthCalledWith(1, {
      caseId: detail.id, restorationId: "shade-4", data: { shade: "A2", syncLinkedArch: false },
    });
    expect(mockUpdateCaseRestorationMutateAsync).toHaveBeenNthCalledWith(2, {
      caseId: detail.id, restorationId: "shade-29", data: { shade: "A1", syncLinkedArch: false },
    });
    setMockAppState({ cases: [{
      ...detail,
      restorations: detail.restorations.map((row) => ({
        ...row, shade: row.id === "shade-4" ? "A2" : "A1",
      })),
    }] });
    await fireEvent.press(screen.getByTestId("section-tab-notes"));
    await fireEvent.press(screen.getByTestId("section-tab-overview"));
    expect(screen.getByTestId("tooth-shade-select-shade-4")).toHaveTextContent("A2");
    expect(screen.getByTestId("tooth-shade-select-shade-29")).toHaveTextContent("A1");
  });

  it("shows one case-level Custom Shade flag and preserves its metadata controls", async () => {
    setMockAppState({ cases: [{
      ...detail, isCustomShade: true, customShadeTechnician: "Alex",
      customShadePicturesAvailable: true, customShadeVideoAvailable: false,
    }] });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.getAllByTestId("custom-shade-toggle")).toHaveLength(1);
    expect(screen.getByTestId("custom-shade-technician-input").props.value).toBe("Alex");
    await fireEvent.press(screen.getByTestId("custom-shade-video-toggle"));
    await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: detail.id, data: { customShadeVideoAvailable: true },
    }));
    await fireEvent.press(screen.getByTestId("overview-edit"));
    expect(screen.getAllByTestId("custom-shade-toggle")).toHaveLength(1);
    expect(screen.getByTestId("tooth-shade-select-shade-4")).toBeTruthy();
  });

  it("hides Step for restorative and ortho cases, including overview editing", async () => {
    const screen = await render(<CaseDetailScreen />);
    expect(screen.queryByTestId("step-select")).toBeNull();
    await fireEvent.press(screen.getByTestId("overview-edit"));
    expect(screen.queryByTestId("step-select")).toBeNull();
    await fireEvent.press(screen.getByTestId("overview-cancel"));
    setMockAppState({ cases: [{
      ...detail, restorations: [{
        ...detail.restorations[0], restorationType: "Retainer", restorationSubtype: "ortho/retainer", arch: "upper",
      }],
    }] });
    await screen.rerender(<CaseDetailScreen />);
    expect(screen.queryByTestId("step-select")).toBeNull();
    expect(screen.queryByTestId("step-value")).toBeNull();
  });

  it("stages removable Step and Wax Setup shade in the same clinical form while editing", async () => {
    setMockSearchParams({ id: removableCaseWaxSetup.id });
    setMockAppState({ cases: [removableCaseWaxSetup] });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.getByTestId("step-select")).toBeTruthy();
    expect(screen.getByTestId("step-shade-input").props.value).toBe("A2");
    await fireEvent.press(screen.getByTestId("overview-edit"));
    expect(screen.queryByTestId("step-select")).toBeNull();
    expect(screen.getByTestId("clinical-case-type-removable")).toBeTruthy();
    expect(screen.getByTestId("clinical-step-wax_setup").props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId("clinical-stepShade").props.value).toBe("A2");
    await fireEvent.changeText(screen.getByTestId("clinical-stepShade"), "B1");
    expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
  });

  it("edits the prescription only, supports cancel and returns refused edits to confirmed text", async () => {
    const screen = await render(<CaseDetailScreen />);
    expect(screen.queryByTestId("case-edit-action-bar")).toBeNull();
    await fireEvent.press(screen.getByTestId("overview-rx-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy(),
    );
    const actionBar = screen.getByTestId("case-edit-action-bar");
    expect(within(actionBar).getByTestId("overview-rx-cancel")).toBeTruthy();
    expect(within(actionBar).getByTestId("overview-rx-save")).toBeTruthy();
    expect(screen.getByTestId("overview-rx-input").props.value).toBe(detail.caseNotes);
    await fireEvent.changeText(screen.getByTestId("overview-rx-input"), "Cancelled draft");
    await fireEvent.press(screen.getByTestId("overview-rx-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
    );
    expect(mockUpdateCaseMutateAsync).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("overview-rx-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy(),
    );
    await fireEvent.changeText(screen.getByTestId("overview-rx-input"), "Keep contact light.");
    await fireEvent.press(screen.getByTestId("overview-rx-save"));
    await waitFor(() => expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
      caseId: detail.id, data: { rxNotes: "Keep contact light." },
    }));
    await waitFor(() =>
      expect(screen.queryByTestId("case-edit-action-bar")).toBeNull(),
    );
    mockUpdateCaseMutateAsync.mockRejectedValueOnce(new Error("Prescription is locked."));
    await fireEvent.press(screen.getByTestId("overview-rx-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy(),
    );
    await fireEvent.changeText(screen.getByTestId("overview-rx-input"), "Refused draft");
    await fireEvent.press(screen.getByTestId("overview-rx-save"));
    await waitFor(() => expect(screen.getByTestId("overview-rx-error")).toHaveTextContent("Prescription is locked."));
    expect(screen.getByTestId("case-edit-action-bar")).toBeTruthy();
    expect(screen.getByTestId("overview-rx-input").props.value).toBe(detail.caseNotes);
    expect(mockAddCaseNoteMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps shade, Rx and overview editing read-only without lab edit permission", async () => {
    setMockAppState({ meMemberships: [{ organizationId: "org-1", role: "read_only", status: "active" }] });
    const screen = await render(<CaseDetailScreen />);
    expect(screen.queryByTestId("overview-edit")).toBeNull();
    expect(screen.queryByTestId("overview-rx-edit")).toBeNull();
    expect(screen.queryByTestId("tooth-shade-select-shade-4")).toBeNull();
    expect(screen.getByTestId("tooth-shade-value-shade-4")).toHaveTextContent("A1");
    expect(screen.queryByTestId("locate-select")).toBeNull();
  });
});
