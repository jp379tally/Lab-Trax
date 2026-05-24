import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_STORAGE_KEY = "labtrax_invoice_col_widths_v1";
const MIN_WIDTH = 48;

export type UseColumnWidths = {
  widths: number[];
  totalWidth: number;
  startResize: (colIdx: number, e: React.MouseEvent) => void;
  resetColumn: (colIdx: number) => void;
};

export function useColumnWidths(
  defaults: number[],
  storageKey: string = DEFAULT_STORAGE_KEY,
): UseColumnWidths {
  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length === defaults.length &&
          parsed.every((v) => typeof v === "number" && v >= MIN_WIDTH)
        ) {
          return parsed as number[];
        }
      }
    } catch {
      // ignore
    }
    return defaults;
  });

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (next: number[]) => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // ignore
        }
      }, 150);
    },
    [storageKey],
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  const startResize = useCallback(
    (colIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widths[colIdx];

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.max(MIN_WIDTH, startWidth + delta);
        setWidths((prev) => {
          const updated = [...prev];
          updated[colIdx] = next;
          persist(updated);
          return updated;
        });
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [widths, persist],
  );

  const resetColumn = useCallback(
    (colIdx: number) => {
      setWidths((prev) => {
        const updated = [...prev];
        updated[colIdx] = defaults[colIdx];
        persist(updated);
        return updated;
      });
    },
    [defaults, persist],
  );

  const totalWidth = widths.reduce((a, b) => a + b, 0);

  return { widths, totalWidth, startResize, resetColumn };
}
