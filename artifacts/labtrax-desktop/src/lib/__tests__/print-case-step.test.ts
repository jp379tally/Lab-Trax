// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatPrintableStep,
  formatScanCondition,
  formatScanRange,
  printAttachmentsList,
  printCaseCardAdvanced,
  printCaseOverview,
} from "@/lib/print";
import { DEFAULT_CASE_PRINT_TEMPLATE } from "@/lib/case-print-template";
import { formatProviderPreferences } from "@/lib/provider-preferences";
import type { CaseAttachment, CaseRestoration, LabCase } from "@/lib/types";

const waxSetupCase: LabCase = {
  id: "case-1",
  caseNumber: "LAB-100",
  labOrganizationId: "lab-1",
  providerOrganizationId: "provider-1",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  doctorName: "Dr. Patel",
  status: "received",
  priority: "normal",
  dueDate: "2026-08-20",
  createdAt: "2026-08-01T12:00:00.000Z",
  step: "wax_setup",
  stepShade: "A2",
};

const pairedRestorations: CaseRestoration[] = [
  {
    id: "restoration-14",
    caseId: "case-1",
    toothNumber: "14",
    restorationType: "Crown",
    shade: "A2",
    quantity: 1,
    unitPrice: 0,
  },
  {
    id: "restoration-15",
    caseId: "case-1",
    toothNumber: "15",
    restorationType: "Crown",
    shade: "B1",
    quantity: 1,
    unitPrice: 0,
  },
];

function installPrintWindow() {
  const write = vi.fn();
  vi.spyOn(window, "open").mockReturnValue({
    document: { open: vi.fn(), write, close: vi.fn() },
    focus: vi.fn(),
    print: vi.fn(),
  } as unknown as Window);
  return write;
}

describe("case-print Step rendering", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("formats a Wax Setup shade adjacent to its Step", () => {
    expect(formatPrintableStep(waxSetupCase)).toBe("Wax Setup · Shade: A2");
    expect(
      formatPrintableStep({ ...waxSetupCase, step: "process", stepShade: "A3" }),
    ).toBe("Process");
  });

  it("includes the Step and Wax Setup shade in the default Lab Slip", () => {
    const write = installPrintWindow();

    printCaseOverview(waxSetupCase);

    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain("Step");
    expect(html).toContain("Wax Setup · Shade: A2");
  });

  it("prints Rx history in order on a readable continuation page", () => {
    const document = printCaseOverview({
      ...waxSetupCase,
      caseNotes: "Latest compatibility text",
      rxNoteEntries: [
        {
          id: "legacy",
          caseId: waxSetupCase.id,
          noteText: "Original line one\nOriginal line two",
          scannedAt: null,
          provenance: "legacy",
        },
        {
          id: "scan-1",
          caseId: waxSetupCase.id,
          noteText: "Accepted scan",
          scannedAt: "2026-02-03T22:00:00.000Z",
          provenance: "ai_reader",
        },
      ],
    }, {}, undefined, true);

    expect(document).toBeDefined();
    expect(document!.body).toContain("See Rx Notes continuation");
    expect(document!.body).toContain("lt-rx-history-continuation");
    expect(document!.body).toContain("Date unknown");
    expect(document!.body).toContain("02/03/2026");
    expect(document!.body).toContain("Original line one\nOriginal line two");
    expect(document!.body.indexOf("Original line one")).toBeLessThan(
      document!.body.indexOf("Accepted scan"),
    );
  });

  it("includes the Step and Wax Setup shade in advanced case-export templates", async () => {
    const write = installPrintWindow();

    await printCaseCardAdvanced(
      waxSetupCase,
      { restorations: [] },
      DEFAULT_CASE_PRINT_TEMPLATE,
    );

    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain("Step");
    expect(html).toContain("Wax Setup · Shade: A2");
  });

  it("uses the same paired tooth and shade text in basic and advanced Lab Slips", async () => {
    const write = installPrintWindow();

    printCaseOverview(waxSetupCase, { restorations: pairedRestorations });

    const basicHtml = write.mock.calls[0]?.[0] as string;
    expect(basicHtml).toContain("14 — A2, 15 — B1");

    await printCaseCardAdvanced(
      waxSetupCase,
      { restorations: pairedRestorations },
      DEFAULT_CASE_PRINT_TEMPLATE,
    );

    const advancedHtml = write.mock.calls[1]?.[0] as string;
    expect(advancedHtml).toContain("14 — A2, 15 — B1");
  });

  it("prints verified scan condition and measured range in case exports", async () => {
    const write = installPrintWindow();
    const scan: CaseAttachment = {
      id: "scan-1",
      caseId: "case-1",
      uploadedByUserId: "user-1",
      uploadedByOrganizationId: "lab-1",
      fileName: "scan.stl",
      storageKey: "scan.stl",
      fileType: "model/stl",
      scanAccuracy: {
        objectCondition: "dental-complex",
        estimatedErrorRangeMm: { min: 0.12, max: 0.35 },
      },
    };

    expect(formatScanCondition(scan.scanAccuracy)).toBe("Complex dental surface");
    expect(formatScanRange(scan.scanAccuracy)).toBe("Measured: 0.12–0.35 mm");

    const filesHtml = printAttachmentsList([scan]);
    expect(filesHtml).toContain("Scan condition");
    expect(filesHtml).toContain("Complex dental surface");
    expect(filesHtml).toContain("Measured: 0.12–0.35 mm");

    printCaseOverview(waxSetupCase, { attachments: [scan] });
    const overviewHtml = write.mock.calls[0]?.[0] as string;
    expect(overviewHtml).toContain("Scan Qualification");
    expect(overviewHtml).toContain("Measured: 0.12–0.35 mm");

    await printCaseCardAdvanced(
      waxSetupCase,
      { attachments: [scan], restorations: [] },
      DEFAULT_CASE_PRINT_TEMPLATE,
    );
    const advancedHtml = write.mock.calls[1]?.[0] as string;
    expect(advancedHtml).toContain("Scan Qualification");
    expect(advancedHtml).toContain("Complex dental surface");
  });

  it("labels scans without a measured range as unmeasured/conservative", () => {
    const scan: CaseAttachment = {
      id: "scan-2",
      caseId: "case-1",
      uploadedByUserId: "user-1",
      uploadedByOrganizationId: "lab-1",
      fileName: "reflective.stl",
      storageKey: "reflective.stl",
      fileType: "model/stl",
      scanAccuracy: {
        objectCondition: "reflective-or-translucent",
        estimatedErrorRangeMm: null,
      },
    };

    expect(formatScanCondition(scan.scanAccuracy)).toBe(
      "Reflective / translucent",
    );
    expect(formatScanRange(scan.scanAccuracy)).toBe(
      "Unmeasured / conservative",
    );
    expect(printAttachmentsList([scan])).toContain(
      "Unmeasured / conservative",
    );
  });

  it("does not fabricate scan metadata for legacy attachments", () => {
    const legacyScan: CaseAttachment = {
      id: "legacy-scan",
      caseId: "case-1",
      uploadedByUserId: "user-1",
      uploadedByOrganizationId: "lab-1",
      fileName: "legacy.stl",
      storageKey: "legacy.stl",
      fileType: "model/stl",
    };

    expect(formatScanCondition(undefined)).toBe("Not available");
    expect(formatScanRange(undefined)).toBe("Not available");
    const html = printAttachmentsList([legacyScan]);
    expect(html).toContain("Not available");
    expect(html).not.toContain("Measured:");
    expect(html).not.toContain("Unmeasured / conservative");
  });

  it("prints meaningful structured provider preferences only when enabled", () => {
    const write = installPrintWindow();
    const withPreferences: LabCase = {
      ...waxSetupCase,
      printProviderPreferencesOnLabSlips: true,
      providerDoctorPreferences: {
        caseQuestionContactMethod: "email",
        caseQuestionContactValue: " doctor@example.com ",
        occlusionAmount: 0.2,
        occlusionUnit: "mm",
        proximalContactAmount: 40,
        proximalContactUnit: "microns",
      },
    };

    printCaseOverview(withPreferences);
    const enabledHtml = write.mock.calls[0]?.[0] as string;
    expect(enabledHtml).toContain("Provider Preferences");
    expect(enabledHtml).toContain("Occlusion: 0.2 mm\nProximal contact: 40 microns\nCase questions: Email: doctor@example.com");

    printCaseOverview({
      ...withPreferences,
      printProviderPreferencesOnLabSlips: false,
    });
    const disabledHtml = write.mock.calls[1]?.[0] as string;
    expect(disabledHtml).not.toContain("Provider Preferences");

    printCaseOverview({
      ...withPreferences,
      providerDoctorPreferences: { anatomyPreference: "other", anatomyOther: "  " },
    });
    const emptyHtml = write.mock.calls[2]?.[0] as string;
    expect(emptyHtml).not.toContain("Provider Preferences");
  });

  it("uses a fixed preference order and advanced templates require a visible preference element", async () => {
    expect(
      formatProviderPreferences({
        caseQuestionContactMethod: "phone_call",
        caseQuestionContactValue: "(555) 555-5555",
        anatomyPreference: "primary_and_secondary",
        proximalContactAmount: 40,
        proximalContactUnit: "microns",
        occlusionAmount: 0.5,
        occlusionUnit: "mm",
      }),
    ).toBe("Occlusion: 0.5 mm\nProximal contact: 40 microns\nAnatomy: Primary and secondary\nCase questions: Phone call: (555) 555-5555");

    const write = installPrintWindow();
    const labCase: LabCase = {
      ...waxSetupCase,
      printProviderPreferencesOnLabSlips: true,
      providerDoctorPreferences: {
        proximalContactAmount: 40,
        proximalContactUnit: "microns",
      },
    };
    await printCaseCardAdvanced(labCase, { restorations: [] }, {
      ...DEFAULT_CASE_PRINT_TEMPLATE,
      elements: [
        ...DEFAULT_CASE_PRINT_TEMPLATE.elements,
        {
          id: "provider-preferences",
          kind: "providerPreferences",
          x: 40,
          y: 40,
          w: 200,
          h: 80,
          visible: false,
        },
      ],
    });
    expect(write.mock.calls[0]?.[0]).not.toContain("Provider Preferences");

    await printCaseCardAdvanced(labCase, { restorations: [] }, {
      ...DEFAULT_CASE_PRINT_TEMPLATE,
      elements: [
        ...DEFAULT_CASE_PRINT_TEMPLATE.elements,
        {
          id: "provider-preferences",
          kind: "providerPreferences",
          x: 40,
          y: 40,
          w: 200,
          h: 80,
          visible: true,
        },
      ],
    });
    expect(write.mock.calls[1]?.[0]).toContain("Provider Preferences");
    expect(write.mock.calls[1]?.[0]).toContain("Proximal contact: 40 microns");
  });
});

// Note timestamps are genuine instants, so the printed day is the local day the
// note was entered. Fixtures are built with the local-time Date constructor and
// serialized via toISOString() so assertions hold in any host timezone.
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
): string {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).toISOString();
}

const labSlipNotes = [
  {
    noteText: "Confirmed with Dr. Byrne that we are going to TIW.",
    visibility: "shared_with_provider",
    authorName: "Casey Lab",
    createdAt: localIso(2026, 8, 15),
  },
  {
    noteText: "Model poured",
    visibility: "internal_lab_only",
    authorName: "Robin Tech",
    createdAt: localIso(2026, 0, 5),
  },
];

describe("printed lab slip notes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes each printed note with the day it was entered", () => {
    const write = installPrintWindow();

    printCaseOverview(waxSetupCase, { notes: labSlipNotes });

    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain(
      `<div class="lt-ov-note-text">09/15 Confirmed with Dr. Byrne that we are going to TIW.</div>`,
    );
    expect(html).toContain(`<div class="lt-ov-note-text">01/05 Model poured</div>`);
    // Visibility label, author, and the existing full timestamp stay on the
    // meta line above the text.
    expect(html).toContain("Shared · Casey Lab · ");
    expect(html).toContain("Lab only · Robin Tech · ");
  });

  it("prints a note with no usable timestamp as its text alone", () => {
    const write = installPrintWindow();

    printCaseOverview(waxSetupCase, {
      notes: [
        { noteText: "Legacy note", visibility: "shared_with_provider", createdAt: null },
        { noteText: "Unreadable stamp", visibility: "shared_with_provider", createdAt: "not-a-date" },
      ],
    });

    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain(`<div class="lt-ov-note-text">Legacy note</div>`);
    expect(html).toContain(`<div class="lt-ov-note-text">Unreadable stamp</div>`);
  });

  it("leaves the rest of the lab slip untouched", () => {
    const write = installPrintWindow();

    printCaseOverview(
      { ...waxSetupCase, casePanBarcode: "PAN-100" },
      { restorations: pairedRestorations, notes: labSlipNotes },
    );
    printCaseOverview(
      { ...waxSetupCase, casePanBarcode: "PAN-100" },
      { restorations: pairedRestorations, notes: [] },
    );

    const beforeNotes = (html: string) =>
      html.slice(0, html.indexOf(`<div class="lt-ov-section">Notes</div>`));
    const dated = write.mock.calls[0]?.[0] as string;
    const empty = write.mock.calls[1]?.[0] as string;

    // Everything printed above the Notes block is byte-identical with and
    // without notes — the dated prefix touches only the note text.
    expect(beforeNotes(dated)).toBe(beforeNotes(empty));
    expect(dated).toContain("Case Details");
    expect(dated).toContain("Rx Summary");
    expect(dated).toContain("Wax Setup · Shade: A2");
    expect(dated).toContain("14 — A2, 15 — B1");
    expect(dated).toContain("PAN-100");
    expect(empty).toContain(`<div class="lt-ov-notes-empty">No notes yet.</div>`);
  });
});