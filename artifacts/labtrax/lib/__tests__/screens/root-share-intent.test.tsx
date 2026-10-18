import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react-native/pure";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert } from "react-native";
import { router } from "expo-router";
import { peekSharedFiles } from "@/lib/shared-file-inbox";
import { setMockAppState, setMockSearchParams, resetMockAppState, flushPendingReactUpdates } from "../../../vitest.setup";
import { inProgressCase } from "./__fixtures__/cases";

const nativeShare = vi.hoisted(() => ({
  payload: null as { files: Array<{ path: string }> } | null,
  resets: vi.fn(),
}));

// Root layout imports an error fallback that offers clipboard diagnostics.
// Clipboard behavior is not under test here; stub it so Vitest does not load
// Expo's JSX-bearing native paste-button module.
vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => undefined),
  getStringAsync: vi.fn(async () => ""),
  isPasteButtonAvailable: false,
  ClipboardPasteButton: () => null,
}));

// Each invocation returns a new reset function, as the real hook does.
vi.mock("expo-share-intent", () => ({
  useShareIntent: () => ({
    hasShareIntent: nativeShare.payload !== null,
    shareIntent: nativeShare.payload,
    resetShareIntent: () => nativeShare.resets(),
  }),
}));

vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("expo-linking", () => ({
  addEventListener: () => ({ remove: () => {} }),
  getInitialURL: async () => null,
  parse: () => ({ queryParams: {} }),
}));
vi.mock("expo-location", () => ({}));
vi.mock("expo", () => ({ reloadAppAsync: vi.fn() }));
vi.mock("@/components/LoginScreen", () => ({ default: () => null }));
vi.mock("@/components/LockScreen", () => ({ default: () => null }));
vi.mock("@/components/EntitlementDecisionGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/provider-portal", () => ({ useProviderPortalDecision: () => "lab" }));

// The root's intake effects run before fonts have loaded; leave the expensive
// authenticated navigator unmounted while testing the real root effect.
vi.mock("@expo-google-fonts/inter", () => ({
  useFonts: () => [false, null],
  Inter_400Regular: 1,
  Inter_500Medium: 1,
  Inter_600SemiBold: 1,
  Inter_700Bold: 1,
}));

import RootLayout from "@/app/_layout";
import CaseDetailScreen from "@/app/case/[id]";

const urls = async () => (await peekSharedFiles()).map((entry) => entry.url);
const firstBatch = ["file:///shared-a.pdf", "file:///shared-b.png"];

beforeEach(async () => {
  await AsyncStorage.clear();
  nativeShare.payload = null;
  nativeShare.resets.mockClear();
  setMockSearchParams({ id: inProgressCase.id });
  setMockAppState({
    cases: [{ ...inProgressCase, organizationId: "org-1" }],
    invoices: [],
    meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
  });
});

afterEach(async () => {
  await cleanup();
  resetMockAppState();
  setMockSearchParams({});
  nativeShare.payload = null;
  await AsyncStorage.clear();
  vi.restoreAllMocks();
});

describe("root native share intake", () => {
  it("stores every file once across rerenders, then accepts a distinct share of the same file", async () => {
    const write = AsyncStorage.setItem.bind(AsyncStorage);
    let releaseWrite!: () => void;
    const writeSpy = vi.spyOn(AsyncStorage, "setItem").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      return write(...args);
    });
    nativeShare.payload = { files: firstBatch.map((path) => ({ path })) };
    const root = await render(<RootLayout />);
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    // Rerender while the native value is still active and the first write is
    // still in flight. Neither the new callback nor a second effect may replay it.
    await root.rerender(<RootLayout />);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    releaseWrite();
    await waitFor(async () => expect(await urls()).toEqual(firstBatch));
    await waitFor(() => expect(nativeShare.resets).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith("/(tabs)");

    await root.rerender(<RootLayout />);
    await root.rerender(<RootLayout />);
    expect(await urls()).toEqual(firstBatch);
    expect(nativeShare.resets).toHaveBeenCalledTimes(1);

    // The native hook clears its old value before a later share action.
    nativeShare.payload = null;
    await root.rerender(<RootLayout />);
    nativeShare.payload = { files: [{ path: firstBatch[0] }] };
    await root.rerender(<RootLayout />);
    await waitFor(async () => expect(await urls()).toEqual([...firstBatch, firstBatch[0]]));
    expect(nativeShare.resets).toHaveBeenCalledTimes(2);
  });

  it("does not restore a confirmed discard while the accepted native payload is still active", async () => {
    nativeShare.payload = { files: firstBatch.map((path) => ({ path })) };
    const root = await render(<RootLayout />);
    await waitFor(async () => expect(await urls()).toEqual(firstBatch));
    await waitFor(() => expect(nativeShare.resets).toHaveBeenCalledTimes(1));

    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const firstCase = await render(<CaseDetailScreen />);
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Attach shared files?", expect.any(String), expect.any(Array)),
    );
    const prompt = alertSpy.mock.calls.find((call) => call[0] === "Attach shared files?")?.[2];
    await act(async () => { await prompt?.find((button) => button.text === "Discard")?.onPress?.(); });
    const confirm = alertSpy.mock.calls.find((call) => call[0] === "Discard shared files?")?.[2];
    await act(async () => { await confirm?.find((button) => button.text === "Discard")?.onPress?.(); });
    await waitFor(async () => expect(await urls()).toEqual([]));

    await root.rerender(<RootLayout />);
    await root.rerender(<RootLayout />);
    await firstCase.unmount();
    alertSpy.mockClear();
    await render(<CaseDetailScreen />);
    await flushPendingReactUpdates();
    expect(await urls()).toEqual([]);
    expect(alertSpy.mock.calls.some((call) => call[0] === "Attach shared files?")).toBe(false);
    expect(nativeShare.resets).toHaveBeenCalledTimes(1);
  });
});