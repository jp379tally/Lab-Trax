import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import * as DocumentPicker from "expo-document-picker";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setFocusEffectEnabled,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
} from "../../../vitest.setup";

import ScanScreen from "@/app/(tabs)/scan";
import { inProgressCase, sampleClient } from "./__fixtures__/cases";

// Long enough to skip the small-payload re-read fallbacks.
const LONG_B64 = "A".repeat(20000);
const FAKE_DATA_URI = `data:image/jpeg;base64,${LONG_B64}`;

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  setFocusEffectEnabled(true);
  vi.restoreAllMocks();
});

describe("ScanScreen (smoke)", () => {
  it("renders without throwing on a fresh focus", () => {
    expect(() => render(<ScanScreen />)).not.toThrow();
  });

  it("produces a non-empty rendered tree on mount", () => {
    const { toJSON } = render(<ScanScreen />);
    expect(toJSON()).not.toBeNull();
  });

  it("renders without throwing when real cases are present in state", () => {
    setMockAppState({
      cases: [inProgressCase],
      clients: [sampleClient],
    });
    expect(() => render(<ScanScreen />)).not.toThrow();
  });

  it("auto-assigns the on-file provider spelling when AI extracts a matching last name", async () => {
    // Disable the manual-entry focus effect so it doesn't reset
    // phase to camera mid-AI-flow under the test mock.
    setFocusEffectEnabled(false);
    setMockAppState({ clients: [sampleClient], cases: [] });

    (DocumentPicker.getDocumentAsync as any).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: FAKE_DATA_URI,
          mimeType: "image/jpeg",
          name: "rx.jpg",
          size: LONG_B64.length,
        },
      ],
    });

    setMockFetchHandler((url: string) => {
      if (url.includes("/api/crop-document")) {
        return new Response(
          JSON.stringify({
            croppedImageBase64: FAKE_DATA_URI,
            documentDetected: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/analyze-prescription")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { doctorName: "Smith", patientName: "Jane Q" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const screen = render(<ScanScreen />);

    const attachBtn = await waitFor(() =>
      screen.getByTestId("attach-files-btn"),
    );
    fireEvent.press(attachBtn);

    // After the AI flow completes (camera → scanning → review → form),
    // the doctor name should be the on-file spelling, not the raw "Smith".
    const doctorTrigger = await waitFor(
      () => screen.getByTestId("doctor-dropdown-trigger"),
      { timeout: 8000 },
    );
    await waitFor(
      () => {
        expect(doctorTrigger).toHaveTextContent("Dr. Smith");
        expect(doctorTrigger).not.toHaveTextContent("Select Doctor");
      },
      { timeout: 8000 },
    );
  }, 15000);

  it("shows the duplicate prompt when a local patient name already has an open case", async () => {
    setMockSearchParams({ mode: "manual", n: "dup-prompt-test-1" });
    setMockAppState({
      cases: [inProgressCase],
      clients: [sampleClient],
    });
    setMockFetchHandler((url: string) => {
      if (url.includes("/api/cases/patient-similarity")) {
        return new Response(JSON.stringify({ data: { matches: [] } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = render(<ScanScreen />);

    const doctorTrigger = await waitFor(() =>
      screen.getByTestId("doctor-dropdown-trigger"),
    );
    fireEvent.press(doctorTrigger);

    const doctorEntry = await waitFor(() => {
      const match = screen.getAllByText(sampleClient.practiceName);
      if (match.length === 0) throw new Error("provider entry not rendered");
      return match[0];
    });
    fireEvent.press(doctorEntry);

    const patientTrigger = screen.getByTestId("patient-dropdown-trigger");
    fireEvent.press(patientTrigger);

    const patientEntry = await waitFor(() => {
      const match = screen.getAllByText(inProgressCase.patientName!);
      if (match.length === 0) throw new Error("patient entry not rendered");
      return match[0];
    });
    fireEvent.press(patientEntry);

    fireEvent.press(screen.getByTestId("submit-case-btn"));

    await waitFor(() => {
      expect(
        screen.getByText(/Possible duplicate \/ remake\?/),
      ).toBeTruthy();
    });
    const expectedNumber = inProgressCase.caseNumber.replace("#", "");
    expect(
      screen.getAllByText(new RegExp(expectedNumber)).length,
    ).toBeGreaterThan(0);
  });
});
