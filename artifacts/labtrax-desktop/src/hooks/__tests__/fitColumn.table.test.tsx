/** @vitest-environment jsdom */
/**
 * Component-level regression guard for the double-click fit-to-content path.
 *
 * The real implementation (cases.tsx, finance/register.tsx) works like this:
 *
 *   onDoubleClick on a resize handle:
 *     1. Read the table ref.  If null → fall back to resetWidth / resetColumn.
 *     2. Query all [data-col-id="<id>"] cells (both <th> and <td>).
 *     3. Take the maximum scrollWidth across them.
 *     4. Call fitColumn(id, max + 8).
 *
 * This test guards three failure modes that would be invisible to users:
 *
 *  A. The table ref is null → double-click silently resets the column instead
 *     of fitting it.  Test proves the ref is wired properly.
 *
 *  B. [data-col-id] is missing from <th> or <td> → max stays 0 → column
 *     snaps to MIN_WIDTH.  Test verifies the attribute is present on BOTH
 *     header and body cells for every visible column.
 *
 *  C. fitColumn is never called at all → no-op.  Test confirms the width
 *     changes after a double-click.
 *
 * A minimal table component that mirrors the exact pattern used in the real
 * pages is rendered here so the test exercises the actual hook + attribute
 * plumbing without pulling in the full pages with their API / auth
 * dependencies.
 */

import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { useTableColumns, type ColumnDef } from "@/hooks/useTableColumns";
import { useColumnWidths } from "@/hooks/useColumnWidths";

// ---------------------------------------------------------------------------
// localStorage stub (keeps tests hermetic)
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.clear();
});

afterEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
});

// ---------------------------------------------------------------------------
// Minimal table using useTableColumns (mirrors cases.tsx)
// ---------------------------------------------------------------------------

type Row = { id: string; name: string; status: string };

const COL_DEFS: ColumnDef<Row>[] = [
  { id: "name",   label: "Name",   menuLabel: "Name",   defaultWidth: 120, render: (r) => r.name },
  { id: "status", label: "Status", menuLabel: "Status", defaultWidth: 80,  render: (r) => r.status },
];

const ROWS: Row[] = [
  { id: "1", name: "Alice",   status: "received"  },
  { id: "2", name: "Bob",     status: "complete"  },
];

/**
 * Minimal table that reproduces the double-click fit pattern from cases.tsx:
 *   - <th data-col-id={col.id}> for each visible column
 *   - <td data-col-id={col.id}> for each cell
 *   - resize handle div with onDoubleClick that queries [data-col-id], reads
 *     scrollWidth, and calls fitColumn (falls back to resetWidth if ref null)
 */
function MinimalCasesTable({ storageKey }: { storageKey: string }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const cols = useTableColumns(COL_DEFS, storageKey);

  return (
    <table ref={tableRef} data-testid="cases-table">
      <thead>
        <tr>
          {cols.visible.map((col) => (
            <th key={col.id} data-col-id={col.id} style={{ position: "relative" }}>
              {col.label}
              {/* resize handle — mirrors the exact onDoubleClick logic in cases.tsx */}
              <div
                data-testid={`resize-${col.id}`}
                onDoubleClick={() => {
                  const table = tableRef.current;
                  if (!table) { cols.resetWidth(col.id); return; }
                  const cells = table.querySelectorAll<HTMLElement>(
                    `[data-col-id="${col.id}"]`,
                  );
                  let max = 0;
                  cells.forEach((el) => { max = Math.max(max, el.scrollWidth); });
                  cols.fitColumn(col.id, max + 8);
                }}
                style={{ position: "absolute", top: 0, right: 0, width: 6, height: "100%", cursor: "col-resize" }}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.id}>
            {cols.visible.map((col) => (
              <td key={col.id} data-col-id={col.id}>
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {/* expose current widths for assertions */}
      <tfoot>
        {cols.visible.map((col) => (
          <tr key={col.id}>
            <td data-testid={`width-${col.id}`}>{cols.getWidth(col.id)}</td>
          </tr>
        ))}
      </tfoot>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Minimal table using useColumnWidths (mirrors finance/register.tsx)
// ---------------------------------------------------------------------------

const FINANCE_DEFAULTS = [90, 70, 160, 150, 100] as const;

function MinimalFinanceTable({ storageKey: _storageKey }: { storageKey: string }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { widths, fitColumn, resetColumn } = useColumnWidths(
    [...FINANCE_DEFAULTS],
    null,
  );

  return (
    <table ref={tableRef} data-testid="finance-table">
      <thead>
        <tr>
          {FINANCE_DEFAULTS.map((_, i) => (
            <th key={i} data-col-id={`col-${i}`} style={{ position: "relative" }}>
              Col {i}
              {/* resize handle — mirrors the exact onDoubleClick logic in register.tsx */}
              <div
                data-testid={`resize-col-${i}`}
                onDoubleClick={() => {
                  const table = tableRef.current;
                  if (!table) { resetColumn(i); return; }
                  const cells = table.querySelectorAll<HTMLElement>(
                    `[data-col-id="col-${i}"]`,
                  );
                  let max = 0;
                  cells.forEach((el) => { max = Math.max(max, el.scrollWidth); });
                  fitColumn(i, max + 8);
                }}
                style={{ position: "absolute", top: 0, right: 0, width: 6, height: "100%", cursor: "col-resize" }}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {FINANCE_DEFAULTS.map((_, i) => (
            <td key={i} data-col-id={`col-${i}`}>cell {i}</td>
          ))}
        </tr>
      </tbody>
      {/* expose current widths for assertions */}
      <tfoot>
        {widths.map((w, i) => (
          <tr key={i}>
            <td data-testid={`width-col-${i}`}>{w}</td>
          </tr>
        ))}
      </tfoot>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Tests — attribute presence
// ---------------------------------------------------------------------------

describe("data-col-id attribute presence", () => {
  describe("useTableColumns table (cases-style)", () => {
    it("renders [data-col-id] on every <th>", () => {
      render(<MinimalCasesTable storageKey="tc-attr-test" />);
      const ths = document.querySelectorAll("th[data-col-id]");
      expect(ths.length).toBe(COL_DEFS.length);
      COL_DEFS.forEach((col) => {
        expect(document.querySelector(`th[data-col-id="${col.id}"]`)).not.toBeNull();
      });
    });

    it("renders [data-col-id] on every <td>", () => {
      render(<MinimalCasesTable storageKey="tc-attr-test-td" />);
      // 2 rows × 2 cols = 4 body cells with the attribute
      const tds = document.querySelectorAll("tbody td[data-col-id]");
      expect(tds.length).toBe(ROWS.length * COL_DEFS.length);
    });

    it("each <th> data-col-id matches a corresponding <td> data-col-id", () => {
      render(<MinimalCasesTable storageKey="tc-attr-match" />);
      const thIds = Array.from(document.querySelectorAll("th[data-col-id]")).map(
        (el) => el.getAttribute("data-col-id"),
      );
      const tdIds = Array.from(
        new Set(
          Array.from(document.querySelectorAll("tbody td[data-col-id]")).map(
            (el) => el.getAttribute("data-col-id"),
          ),
        ),
      );
      // Every th id must appear in the td ids
      thIds.forEach((id) => expect(tdIds).toContain(id));
    });
  });

  describe("useColumnWidths table (finance register-style)", () => {
    it("renders [data-col-id] on every <th>", () => {
      render(<MinimalFinanceTable storageKey="cw-attr-test" />);
      const ths = document.querySelectorAll("th[data-col-id]");
      expect(ths.length).toBe(FINANCE_DEFAULTS.length);
    });

    it("renders [data-col-id] on every <td>", () => {
      render(<MinimalFinanceTable storageKey="cw-attr-test-td" />);
      const tds = document.querySelectorAll("tbody td[data-col-id]");
      expect(tds.length).toBe(FINANCE_DEFAULTS.length);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — double-click calls fitColumn, not resetWidth/resetColumn
// ---------------------------------------------------------------------------

describe("double-click on resize handle", () => {
  /**
   * jsdom always returns 0 for scrollWidth, so max = 0 and fitColumn is
   * called with 0 + 8 = 8, which gets clamped to MIN_WIDTH (48).
   *
   * This is DISTINCT from resetWidth/resetColumn (which restores the
   * defaultWidth: 120 for "name", or 90 for col-0), so the assertion
   * width === 48 confirms fitColumn was called, not the fallback.
   */
  describe("useTableColumns table (cases-style)", () => {
    it("calls fitColumn for the 'name' column — width changes to MIN_WIDTH (not default)", () => {
      render(<MinimalCasesTable storageKey="tc-dblclick-name" />);

      // Sanity: initial width should be the default (120).
      expect(screen.getByTestId("width-name").textContent).toBe("120");

      fireEvent.doubleClick(screen.getByTestId("resize-name"));

      // scrollWidth is 0 in jsdom → fitColumn(id, 0+8) → clamped to 48.
      // resetWidth would have produced 120. 48 ≠ 120 proves fitColumn ran.
      expect(screen.getByTestId("width-name").textContent).toBe("48");
    });

    it("calls fitColumn for the 'status' column — width changes to MIN_WIDTH (not default)", () => {
      render(<MinimalCasesTable storageKey="tc-dblclick-status" />);

      expect(screen.getByTestId("width-status").textContent).toBe("80");

      fireEvent.doubleClick(screen.getByTestId("resize-status"));

      // resetColumn would produce 80. MIN_WIDTH (48) < 80 proves fitColumn ran.
      expect(screen.getByTestId("width-status").textContent).toBe("48");
    });

    it("width after double-click is > 0 (fitColumn received a positive value)", () => {
      render(<MinimalCasesTable storageKey="tc-dblclick-nonzero" />);

      fireEvent.doubleClick(screen.getByTestId("resize-name"));

      const width = Number(screen.getByTestId("width-name").textContent);
      expect(width).toBeGreaterThan(0);
    });
  });

  describe("useColumnWidths table (finance register-style)", () => {
    it("calls fitColumn for col-0 — width changes to MIN_WIDTH (not default 90)", () => {
      render(<MinimalFinanceTable storageKey="cw-dblclick-col0" />);

      expect(screen.getByTestId("width-col-0").textContent).toBe("90");

      fireEvent.doubleClick(screen.getByTestId("resize-col-0"));

      // resetColumn(0) would restore 90; fitColumn produces 48. 48 ≠ 90.
      expect(screen.getByTestId("width-col-0").textContent).toBe("48");
    });

    it("calls fitColumn for col-2 — width changes to MIN_WIDTH (not default 160)", () => {
      render(<MinimalFinanceTable storageKey="cw-dblclick-col2" />);

      expect(screen.getByTestId("width-col-2").textContent).toBe("160");

      fireEvent.doubleClick(screen.getByTestId("resize-col-2"));

      expect(screen.getByTestId("width-col-2").textContent).toBe("48");
    });

    it("width after double-click is > 0", () => {
      render(<MinimalFinanceTable storageKey="cw-dblclick-nonzero" />);

      fireEvent.doubleClick(screen.getByTestId("resize-col-1"));

      const width = Number(screen.getByTestId("width-col-1").textContent);
      expect(width).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Guard: simulated scrollWidth > 0 produces a larger fit width
// ---------------------------------------------------------------------------

describe("scrollWidth forwarding", () => {
  it("fitColumn receives the measured scrollWidth (mocked to 200) + 8", () => {
    render(<MinimalCasesTable storageKey="tc-scroll-width" />);

    // Override scrollWidth on all [data-col-id="name"] elements so the
    // measurement path returns a real non-zero value.
    const cells = document.querySelectorAll<HTMLElement>('[data-col-id="name"]');
    cells.forEach((el) =>
      Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => 200 }),
    );

    fireEvent.doubleClick(screen.getByTestId("resize-name"));

    // fitColumn(id, 200 + 8) = 208 (> MIN_WIDTH, so no clamping)
    expect(screen.getByTestId("width-name").textContent).toBe("208");
  });
});
