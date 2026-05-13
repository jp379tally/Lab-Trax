import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";

// The real ReviewAndEditScreen renders an interactive editor (EditingCanvas,
// gesture handlers, etc.) that infinite-loops under the lightweight RN stub
// and blows the test heap. For the AI-flow smoke tests we only care that
// onFinish gets called with the captured pages, so a minimal stub is enough.
vi.mock("@/components/scan/ReviewAndEditScreen", () => {
  const { Pressable, Text } = require("react-native");
  return {
    ReviewAndEditScreen: (props: {
      visible: boolean;
      initialPhotos: string[];
      onFinish: (uris: string[]) => void;
    }) => {
      if (!props.visible) return null;
      return React.createElement(
        Pressable,
        {
          testID: "review-finish-btn",
          onPress: () => props.onFinish(props.initialPhotos),
        },
        React.createElement(Text, null, "Finish"),
      );
    },
  };
});
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import * as DocumentPicker from "expo-document-picker";
import { Alert } from "react-native";
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
  vi.mocked(Alert.alert).mockClear();
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
            data: {
              doctorName: "Smith",
              patientName: "Jane Q",
              caseType: "Restorative",
            },
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

    // The Attach flow lands the user in the review screen. Tap Finish to
    // hand the captured pages to the AI extractor.
    const finishBtn = await waitFor(
      () => screen.getByTestId("review-finish-btn"),
      { timeout: 8000 },
    );
    fireEvent.press(finishBtn);

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

    // The rest of the AI-extracted fields should also have been written
    // onto the form state — a regression in the AI-response → setState
    // wiring would surface here.
    const patientTrigger = screen.getByTestId("patient-dropdown-trigger");
    expect(patientTrigger).toHaveTextContent("Jane Q");
    expect(patientTrigger).not.toHaveTextContent("Select Patient");
    expect(screen.getAllByText("Restorative").length).toBeGreaterThan(0);
  }, 15000);

  it("prompts the user when AI extracts a similar (but not exact) provider name", async () => {
    setFocusEffectEnabled(false);
    // Provider on file is "Dr. Smith"; AI returns "Smyth" — distance 1
    // from the on-file last name → falls into the "similar" branch and
    // must NOT silently auto-assign.
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
            data: { doctorName: "Smyth", patientName: "Jane Q" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const alertSpy = vi.mocked(Alert.alert);
    alertSpy.mockClear();

    const screen = render(<ScanScreen />);

    const attachBtn = await waitFor(() =>
      screen.getByTestId("attach-files-btn"),
    );
    fireEvent.press(attachBtn);

    const finishBtn = await waitFor(
      () => screen.getByTestId("review-finish-btn"),
      { timeout: 8000 },
    );
    fireEvent.press(finishBtn);

    // Wait for the form phase, which means the AI flow finished and the
    // similar-provider Alert was scheduled.
    await waitFor(
      () => screen.getByTestId("doctor-dropdown-trigger"),
      { timeout: 8000 },
    );

    await waitFor(
      () => {
        const titles = alertSpy.mock.calls.map((c) => String(c[0] ?? ""));
        expect(titles.some((t) => t === "Similar Provider Found")).toBe(true);
      },
      { timeout: 8000 },
    );

    // The similar-provider Alert message should mention both the scanned
    // and the on-file spelling so the user can decide.
    const similarCall = alertSpy.mock.calls.find(
      (c) => String(c[0] ?? "") === "Similar Provider Found",
    )!;
    const message = String(similarCall[1] ?? "");
    expect(message).toContain("Smyth");
    expect(message).toContain("Smith");

    // The Alert exposes a "Yes — assign" button; firing it should align
    // the form to the on-file provider spelling.
    const buttons = (similarCall[2] ?? []) as Array<{
      text?: string;
      onPress?: () => void;
    }>;
    const yes = buttons.find((b) => /Yes/.test(b.text ?? ""));
    expect(yes).toBeDefined();
    yes!.onPress?.();

    const doctorTrigger = screen.getByTestId("doctor-dropdown-trigger");
    await waitFor(() => {
      expect(doctorTrigger).toHaveTextContent("Dr. Smith");
    });
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
