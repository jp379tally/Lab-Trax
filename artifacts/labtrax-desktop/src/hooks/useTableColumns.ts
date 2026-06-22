import { useCallback, useEffect, useRef, useState } from "react";

const MIN_WIDTH = 48;

export interface ColumnDef<T> {
  id: string;
  label: React.ReactNode;
  menuLabel: string;
  align?: "left" | "right" | "center";
  defaultWidth?: number;
  hidden?: boolean;
  render: (row: T) => React.ReactNode;
}

export interface ColumnState {
  order: string[];       // ordered list of visible column ids
  hidden: string[];      // ids of hidden columns
  widths: Record<string, number>;
}

function buildState(defs: Array<{ id: string; defaultWidth?: number; hidden?: boolean }>): ColumnState {
  const order = defs.filter((d) => !d.hidden).map((d) => d.id);
  const hidden = defs.filter((d) => d.hidden).map((d) => d.id);
  const widths: Record<string, number> = {};
  for (const d of defs) {
    widths[d.id] = d.defaultWidth ?? 120;
  }
  return { order, hidden, widths };
}

function loadState(key: string, defaults: ColumnState): ColumnState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ColumnState>;
    const order = Array.isArray(parsed.order) ? parsed.order : defaults.order;
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden : defaults.hidden;
    const widths: Record<string, number> = { ...defaults.widths };
    if (parsed.widths && typeof parsed.widths === "object") {
      for (const k of Object.keys(parsed.widths)) {
        const v = (parsed.widths as Record<string, unknown>)[k];
        if (typeof v === "number" && v >= MIN_WIDTH) widths[k] = v;
      }
    }
    // Validate order only contains known ids
    const known = new Set([...defaults.order, ...defaults.hidden]);
    const validOrder = order.filter((id) => known.has(id));
    const validHidden = hidden.filter((id) => known.has(id));
    // Any ids not in order or hidden should be appended (new columns)
    const placed = new Set([...validOrder, ...validHidden]);
    for (const id of defaults.order) {
      if (!placed.has(id)) validOrder.push(id);
    }
    return { order: validOrder, hidden: validHidden, widths };
  } catch {
    return defaults;
  }
}

function persistState(key: string, state: ColumnState) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export interface UseTableColumnsResult<T> {
  defs: ColumnDef<T>[];
  visible: ColumnDef<T>[];
  state: ColumnState;
  resizingId: string | null;
  startResize: (id: string, e: React.MouseEvent) => void;
  resetWidth: (id: string) => void;
  resetAll: () => void;
  moveColumn: (id: string, direction: "left" | "right") => void;
  setColumnOrder: (order: string[]) => void;
  toggleColumn: (id: string) => void;
  setColumnHidden: (id: string, hidden: boolean) => void;
  getWidth: (id: string) => number;
}

export function useTableColumns<T>(
  defs: ColumnDef<T>[],
  storageKey: string,
): UseTableColumnsResult<T> {
  const defaults = useRef(buildState(defs)).current;
  const [state, setState] = useState<ColumnState>(() =>
    loadState(storageKey, defaults),
  );
  const [resizingId, setResizingId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePersist = useCallback((next: ColumnState) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      persistState(storageKey, next);
    }, 150);
  }, [storageKey]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const startResize = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = state.widths[id] ?? defaults.widths[id] ?? 120;
      setResizingId(id);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.max(MIN_WIDTH, startWidth + delta);
        setState((prev) => {
          const updated = {
            ...prev,
            widths: { ...prev.widths, [id]: next },
          };
          schedulePersist(updated);
          return updated;
        });
      };

      const onMouseUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizingId(null);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [state.widths, defaults.widths, schedulePersist],
  );

  const resetWidth = useCallback(
    (id: string) => {
      const defaultWidth = defaults.widths[id] ?? 120;
      setState((prev) => {
        const updated = {
          ...prev,
          widths: { ...prev.widths, [id]: defaultWidth },
        };
        schedulePersist(updated);
        return updated;
      });
    },
    [defaults.widths, schedulePersist],
  );

  const resetAll = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setState({ ...defaults });
  }, [defaults, storageKey]);

  const moveColumn = useCallback(
    (id: string, direction: "left" | "right") => {
      setState((prev) => {
        const idx = prev.order.indexOf(id);
        if (idx === -1) return prev;
        const newIdx = direction === "left" ? idx - 1 : idx + 1;
        if (newIdx < 0 || newIdx >= prev.order.length) return prev;
        const next = [...prev.order];
        [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
        const updated = { ...prev, order: next };
        schedulePersist(updated);
        return updated;
      });
    },
    [schedulePersist],
  );

  const setColumnOrder = useCallback(
    (order: string[]) => {
      setState((prev) => {
        const updated = { ...prev, order };
        schedulePersist(updated);
        return updated;
      });
    },
    [schedulePersist],
  );

  const toggleColumn = useCallback(
    (id: string) => {
      setState((prev) => {
        const isHidden = prev.hidden.includes(id);
        let next: ColumnState;
        if (isHidden) {
          // Show: remove from hidden, append to order
          next = {
            ...prev,
            hidden: prev.hidden.filter((h) => h !== id),
            order: [...prev.order, id],
          };
        } else {
          // Hide: remove from order, add to hidden
          next = {
            ...prev,
            order: prev.order.filter((o) => o !== id),
            hidden: [...prev.hidden, id],
          };
        }
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  const setColumnHidden = useCallback(
    (id: string, hidden: boolean) => {
      setState((prev) => {
        const currentlyHidden = prev.hidden.includes(id);
        if (currentlyHidden === hidden) return prev;
        let next: ColumnState;
        if (hidden) {
          next = {
            ...prev,
            order: prev.order.filter((o) => o !== id),
            hidden: [...prev.hidden, id],
          };
        } else {
          next = {
            ...prev,
            hidden: prev.hidden.filter((h) => h !== id),
            order: [...prev.order, id],
          };
        }
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  const getWidth = useCallback(
    (id: string) => state.widths[id] ?? defaults.widths[id] ?? 120,
    [state.widths, defaults.widths],
  );

  const visible = state.order
    .map((id) => defs.find((d) => d.id === id))
    .filter(Boolean) as ColumnDef<T>[];

  return {
    defs,
    visible,
    state,
    resizingId,
    startResize,
    resetWidth,
    resetAll,
    moveColumn,
    setColumnOrder,
    toggleColumn,
    setColumnHidden,
    getWidth,
  };
}
