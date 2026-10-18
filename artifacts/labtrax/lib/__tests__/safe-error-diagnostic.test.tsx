import React from "react";
import {
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorFallback } from "@/components/ErrorFallback";

const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(async (_text: string) => undefined),
}));

vi.mock("expo-clipboard", () => clipboard);
vi.mock("expo", () => ({ reloadAppAsync: vi.fn() }));

import { createSafeErrorDiagnostic } from "../safe-error-diagnostic";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createSafeErrorDiagnostic", () => {
  it("includes the allow-listed error type, failure pattern, and component names", () => {
    const diagnostic = createSafeErrorDiagnostic(
      "TypeError",
      "\n    in LoginScreen (created by AuthGate)\n    in AuthGate\n    in RootLayoutNav",
      "Cannot read properties of undefined (reading 'sessionToken')",
    );

    expect(diagnostic).toBe(
      [
        "LabTrax error diagnostic",
        "Error type: TypeError",
        "Failure pattern: null_or_undefined_access",
        "Component path: LoginScreen > AuthGate > RootLayoutNav",
      ].join("\n"),
    );
  });

  it("never includes exception text, stack locations, or unrecognized error names", () => {
    const patientDetail = "Patient Jane Example case 12345";
    const diagnostic = createSafeErrorDiagnostic(
      patientDetail,
      `\n    in Dashboard (created by ${patientDetail})\n    at Dashboard (/private/${patientDetail}.bundle:1:42)`,
      `Cannot read properties of undefined (reading '${patientDetail}')`,
    );

    expect(diagnostic).toContain("Error type: Error");
    expect(diagnostic).toContain("Failure pattern: unclassified");
    expect(diagnostic).toContain("Component path: Dashboard > Dashboard");
    expect(diagnostic).not.toContain(patientDetail);
    expect(diagnostic).not.toContain("/private/");
    expect(diagnostic).not.toContain("bundle");
  });

  it("limits component-path length and handles missing stacks", () => {
    const manyComponents = Array.from(
      { length: 12 },
      (_, index) => `    in Screen${index}`,
    ).join("\n");
    const diagnostic = createSafeErrorDiagnostic("TypeError", manyComponents);

    expect(diagnostic).toContain(
      "Failure pattern: unclassified",
    );
    expect(diagnostic).toContain(
      "Component path: Screen0 > Screen1 > Screen2 > Screen3 > Screen4 > Screen5 > Screen6 > Screen7",
    );
    expect(diagnostic).not.toContain("Screen8");
    expect(createSafeErrorDiagnostic("TypeError")).toContain(
      "Component path: unavailable",
    );
  });

  it("includes only safe function names and bundle coordinates from the JS stack", () => {
    const privateDetails = "Jane Example case 12345";
    const diagnostic = createSafeErrorDiagnostic(
      "TypeError",
      "    in DashboardScreen",
      "caseRecords.filter is not a function",
      [
        "TypeError: " + privateDetails,
        "    at sortDueTomorrowCases (address at https://private.example/" +
          privateDetails +
          ".bundle:1:123456)",
        "    at DashboardScreen (/Users/" + privateDetails + "/main.jsbundle:1:234567)",
      ].join("\n"),
    );

    expect(diagnostic).toContain(
      "JavaScript frames: sortDueTomorrowCases@1:123456 > DashboardScreen@1:234567",
    );
    expect(diagnostic).not.toContain(privateDetails);
    expect(diagnostic).not.toContain("https://");
    expect(diagnostic).not.toContain("/Users/");
    expect(diagnostic).not.toContain("caseRecords");
  });

  it("reports only a safe allow-listed call method, never the object name", () => {
    const diagnostic = createSafeErrorDiagnostic(
      "TypeError",
      "    in DashboardScreen",
      "caseRecords.filter is not a function",
    );

    expect(diagnostic).toContain("Failure detail: member_method:filter");
    expect(diagnostic).not.toContain("caseRecords");
  });

  it("does not expose unrecognized names from a member call", () => {
    const privateDetail = "Patient Jane Example";
    const diagnostic = createSafeErrorDiagnostic(
      "TypeError",
      "    in DashboardScreen",
      `${privateDetail}.medicalRecord is not a function`,
    );

    expect(diagnostic).toContain("Failure detail: member_call");
    expect(diagnostic).not.toContain(privateDetail);
    expect(diagnostic).not.toContain("medicalRecord");
  });

  it("retains a bounded set of additional bundle frames", () => {
    const stack = Array.from(
      { length: 14 },
      (_, index) =>
        `    at Screen${index} (index.ios.bundle:1:${index + 1})`,
    ).join("\n");
    const diagnostic = createSafeErrorDiagnostic(
      "TypeError",
      "    in DashboardScreen",
      "undefined is not a function",
      stack,
    );

    expect(diagnostic).toContain("Failure detail: direct_or_unknown_call");
    expect(diagnostic).toContain("Screen11@1:12");
    expect(diagnostic).not.toContain("Screen12@");
  });
});

describe("ErrorFallback diagnostic copy", () => {
  it("copies the sanitized diagnostic without the exception message", async () => {
    const screen = await render(
      <ErrorFallback
        error={new Error("Patient Jane Example case 12345")}
        componentStack={["", "    in LoginScreen", "    in AuthGate"].join("\n")}
        resetError={vi.fn()}
      />,
    );

    await fireEvent.press(
      screen.getByLabelText("Copy safe error diagnostic"),
    );

    await waitFor(() => {
      expect(clipboard.setStringAsync).toHaveBeenCalledWith(
        [
          "LabTrax error diagnostic",
          "Error type: Error",
          "Failure pattern: unclassified",
          "Component path: LoginScreen > AuthGate",
        ].join("\n"),
      );
      expect(screen.getByText("Diagnostic copied")).toBeTruthy();
    });
    expect(String(clipboard.setStringAsync.mock.calls[0]?.[0])).not.toContain(
      "Patient Jane Example",
    );
  });

  it("copies only a fixed pattern label for TypeErrors", async () => {
    const screen = await render(
      <ErrorFallback
        error={new TypeError("caseRecords.filter is not a function")}
        componentStack="    in DashboardScreen"
        resetError={vi.fn()}
      />,
    );

    await fireEvent.press(
      screen.getByLabelText("Copy safe error diagnostic"),
    );

    await waitFor(() => {
      expect(clipboard.setStringAsync).toHaveBeenCalledWith(
        [
          "LabTrax error diagnostic",
          "Error type: TypeError",
          "Failure pattern: called_non_function",
          "Component path: DashboardScreen",
          "Failure detail: member_method:filter",
        ].join("\n"),
      );
    });
    expect(String(clipboard.setStringAsync.mock.calls[0]?.[0])).not.toContain(
      "caseRecords",
    );
  });

  it("passes a sanitized JavaScript callsite into the copied diagnostic", async () => {
    const error = new TypeError("caseRecords.filter is not a function");
    error.stack = [
      "TypeError: caseRecords.filter is not a function",
      "    at sortDueTomorrowCases (address at index.ios.bundle:1:123456)",
      "    at DashboardScreen (address at index.ios.bundle:1:234567)",
    ].join("\n");
    const screen = await render(
      <ErrorFallback
        error={error}
        componentStack="    in DashboardScreen"
        resetError={vi.fn()}
      />,
    );

    await fireEvent.press(
      screen.getByLabelText("Copy safe error diagnostic"),
    );

    await waitFor(() => {
      expect(clipboard.setStringAsync).toHaveBeenCalledWith(
        expect.stringContaining(
          "JavaScript frames: sortDueTomorrowCases@1:123456 > DashboardScreen@1:234567",
        ),
      );
    });
    expect(String(clipboard.setStringAsync.mock.calls[0]?.[0])).not.toContain(
      "caseRecords",
    );
  });
});
