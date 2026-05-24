import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY_BASE = "labtrax_invoice_col_widths_v1";
const MIN_WIDTH = 48;

function storageKey(userId?: string | number | null): string {
  return userId != null ? `${STORAGE_KEY_BASE}_${userId}` : STORAGE_KEY_BASE;
}

export type UseColumnWidths = {
  widths: number[];
  totalWidth: number;
  startResize: (colIdx: number, e: React.MouseEvent) => void;
  resetColumn: (colIdx: number) => void;
};

export function useColumnWidths(
  defaults: number[],
  userId?: string | number | null,
): UseColumnWidths {
  const key = storageKey(userId);

  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const stored = localStorage.getItem(key);
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

  const keyRef = useRef(key);
  keyRef.current = key;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((next: number[]) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(keyRef.current, JSON.stringify(next));
      } catch {
        // ignore
      }
    }, 150);
  }, []);

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
