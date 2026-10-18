// Realistic `GET /api/locations` payloads for the mobile locate surfaces.
//
// Locate used to substitute the built-in CASE_STATIONS list whenever the
// locations fetch was still in flight or came back empty, so tests could get
// away with an empty (or default `{ data: null }`) response and still see a
// full station list. That shortcut is gone — every locate surface now renders
// exactly what the lab returns — so tests must serve a realistic list.
//
// The list deliberately includes:
//   • a distinctly-named custom location ("Polishing Bench") that is not in
//     the built-in list, so a test can prove real lab data is shown;
//   • a second custom location mapped to the SAME workflow status
//     ("Glaze Oven" → qc), which must stay independently selectable;
//   • an inactive location, which an `activeOnly=true` request must not return.

export interface LabLocationFixture {
  id: string;
  name: string;
  code: string;
  status: string;
  isActive: boolean;
  sortOrder: number;
}

export const LAB_LOCATIONS: LabLocationFixture[] = [
  { id: "loc-received", name: "Received", code: "RECV", status: "received", isActive: true, sortOrder: 1 },
  { id: "loc-in-design", name: "In Design", code: "DSGN", status: "in_design", isActive: true, sortOrder: 2 },
  { id: "loc-polish", name: "Polishing Bench", code: "POLISH", status: "qc", isActive: true, sortOrder: 3 },
  { id: "loc-glaze", name: "Glaze Oven", code: "GLAZE", status: "qc", isActive: true, sortOrder: 4 },
  { id: "loc-complete", name: "Complete", code: "DONE", status: "complete", isActive: true, sortOrder: 5 },
  { id: "loc-retired", name: "Retired Bench", code: "OLD", status: "on_hold", isActive: false, sortOrder: 6 },
];

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * A `GET /api/locations` response that honors `activeOnly=true` the way the
 * server does — so a test asserting an inactive location is absent is really
 * asserting the client asked for active locations only.
 */
export function locationsResponse(
  url: string,
  rows: LabLocationFixture[] = LAB_LOCATIONS,
): Response {
  const activeOnly = url.includes("activeOnly=true");
  const data = rows.filter((r) => !activeOnly || r.isActive);
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
}

/** Wraps a fetch handler so `/api/locations` is served from `rows`. */
export function withLocations(
  handler: FetchHandler,
  rows: LabLocationFixture[] = LAB_LOCATIONS,
): FetchHandler {
  return (url, init) =>
    String(url).includes("/api/locations")
      ? locationsResponse(String(url), rows)
      : handler(url, init);
}

/** A handler that serves locations and answers everything else with `{ data: null }`. */
export function locationsOnlyHandler(
  rows: LabLocationFixture[] = LAB_LOCATIONS,
): FetchHandler {
  return withLocations(
    () => new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }),
    rows,
  );
}
