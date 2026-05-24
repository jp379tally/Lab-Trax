import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY_BASE = "labtrax_invoice_col_widths_v1";
const MIN_WIDTH = 30;

function storageKey(userId?: string | null): string {
  return userId != null && userId !== ""
    ? `${STORAGE_KEY_BASE}_${userId}`
    : STORAGE_KEY_BASE;
}

export type UseColumnWidths = {
  widths: number[];
  setWidth: (colIdx: number, width: number) => void;
  resetColumn: (colIdx: number) => void;
};

export function useColumnWidths(
  defaults: number[],
  userId?: string | null,
): UseColumnWidths {
  const key = storageKey(userId);
  const keyRef = useRef(key);
  keyRef.current = key;

  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const [widths, setWidths] = useState<number[]>(defaults);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(key).then((stored) => {
      if (cancelled) return;
      if (!stored) {
        setWidths([...defaultsRef.current]);
        return;
      }
      try {
        const parsed = JSON.parse(stored) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length === defaultsRef.current.length &&
          parsed.every((v) => typeof v === "number" && v >= MIN_WIDTH)
        ) {
          setWidths(parsed as number[]);
          return;
        }
      } catch {
        // ignore
      }
      setWidths([...defaultsRef.current]);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((next: number[]) => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      AsyncStorage.setItem(keyRef.current, JSON.stringify(next)).catch(() => {});
    }, 150);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  const setWidth = useCallback(
    (colIdx: number, width: number) => {
      setWidths((prev) => {
        const updated = [...prev];
        updated[colIdx] = Math.max(MIN_WIDTH, width);
        persist(updated);
        return updated;
      });
    },
    [persist],
  );

  const resetColumn = useCallback(
    (colIdx: number) => {
      setWidths((prev) => {
        const updated = [...prev];
        updated[colIdx] = defaultsRef.current[colIdx];
        persist(updated);
        return updated;
      });
    },
    [persist],
  );

  return { widths, setWidth, resetColumn };
}
