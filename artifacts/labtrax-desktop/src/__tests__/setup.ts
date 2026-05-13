import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement matchMedia, ResizeObserver, or IntersectionObserver
// — Radix UI primitives used across the desktop renderer (dropdowns, dialogs,
// scroll areas) read all three on mount, so a missing polyfill turns a smoke
// render into an unrelated TypeError.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
      MockResizeObserver;
  }

  class MockIntersectionObserver {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  if (!("IntersectionObserver" in window)) {
    (
      window as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
    ).IntersectionObserver = MockIntersectionObserver;
  }

  // Stub electronAPI so settings.tsx feature-detects iTero / platform-admin
  // bridges as absent (the smoke test renders the non-Electron code path).
  if (!(window as { electronAPI?: unknown }).electronAPI) {
    Object.defineProperty(window, "electronAPI", {
      writable: true,
      value: {},
    });
  }
}

// Intentionally no global fetch stub here — that would mask real regressions
// in tests that exercise the network layer. Renderer smoke tests stub fetch
// per-suite via vi.stubGlobal("fetch", ...) in a beforeEach.
