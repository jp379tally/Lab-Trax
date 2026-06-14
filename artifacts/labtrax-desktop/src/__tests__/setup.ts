import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Block all real network calls by default. Every test that exercises the
// network layer must either rely on this safe response or override fetch in
// its own beforeEach. This beforeEach runs before each test in every file
// (setupFiles hooks fire first), so per-file beforeEach overrides take
// precedence and can return whatever shape their test requires.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
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

