import { useCallback, useEffect, useRef, useState } from "react";

export const INVOICE_PANEL_MIN_WIDTH = 480;
export const INVOICE_PANEL_DEFAULT_WIDTH = 768;

const PANEL_WIDTH_KEY = "labtrax_invoice_panel_width_v1";
const PANEL_MAXIMIZED_KEY = "labtrax_invoice_panel_maximized_v1";

function readStoredWidth(): number {
  try {
    const stored = Number.parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(stored) ? stored : INVOICE_PANEL_DEFAULT_WIDTH;
  } catch {
    return INVOICE_PANEL_DEFAULT_WIDTH;
  }
}

function readStoredMaximized(): boolean {
  try {
    return localStorage.getItem(PANEL_MAXIMIZED_KEY) === "true";
  } catch {
    return false;
  }
}

function clampPanelWidth(width: number, viewportWidth: number): number {
  return Math.min(
    Math.max(width, INVOICE_PANEL_MIN_WIDTH),
    Math.max(viewportWidth, INVOICE_PANEL_MIN_WIDTH),
  );
}

export function useInvoicePanelSize() {
  const [panelWidth, setPanelWidth] = useState(readStoredWidth);
  const [isMaximized, setIsMaximized] = useState(readStoredMaximized);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_MAXIMIZED_KEY, String(isMaximized));
    } catch {
      // The panel remains usable when browser storage is unavailable.
    }
  }, [isMaximized]);

  const toggleMaximized = useCallback(() => {
    setIsMaximized((current) => !current);
  }, []);

  const onResizeMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startWidth = isMaximized ? window.innerWidth : panelWidth;
      dragRef.current = { startX: event.clientX, startWidth };
      if (isMaximized) setIsMaximized(false);

      function onMove(moveEvent: MouseEvent) {
        if (!dragRef.current) return;
        const delta = dragRef.current.startX - moveEvent.clientX;
        const nextWidth = clampPanelWidth(
          dragRef.current.startWidth + delta,
          window.innerWidth,
        );
        panelWidthRef.current = nextWidth;
        setPanelWidth(nextWidth);
      }

      function onUp() {
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidthRef.current));
        } catch {
          // Ignore storage failures; the current width remains applied.
        }
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isMaximized, panelWidth],
  );

  return {
    panelWidth,
    isMaximized,
    toggleMaximized,
    onResizeMouseDown,
  };
}
