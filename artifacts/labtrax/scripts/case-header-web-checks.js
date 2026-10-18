// Real Expo-web geometry and state checks; called by the shared export runner.
const { strict: assert } = require("node:assert");
const { mkdirSync } = require("node:fs");

const caseId = "header-locator-browser-case";
const detail = {
  id: caseId,
  caseNumber: "26-LOCATOR",
  patientFirstName: "Alexandria-Catherine",
  patientLastName: "Montgomery-Worthington-Smythe",
  doctorName: "Dr. Header",
  status: "qc",
  labLocationId: "station-polish",
  labLocationName: "Polishing Bench",
  organizationId: "browser-smoke-lab",
  labOrganizationId: "browser-smoke-lab",
  priority: "normal",
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  restorations: [],
  notes: [],
  events: [],
  attachments: [],
};
const locations = [
  { id: "station-polish", name: "Polishing Bench", code: "POLISH", status: "qc", isActive: true, sortOrder: 1 },
  { id: "station-glaze", name: "Glaze Oven With A Long Custom Station Name", code: "GLAZE", status: "qc", isActive: true, sortOrder: 2 },
  { id: "station-complete", name: "Complete", code: "COMPLETE", status: "complete", isActive: true, sortOrder: 3 },
];

function caseHeaderResponse(request) {
  const path = new URL(request.url()).pathname;
  if (path === `/api/cases/${caseId}`) {
    if (request.method() === "PATCH") {
      Object.assign(detail, request.postDataJSON());
      detail.labLocationName = locations.find((s) => s.id === detail.labLocationId)?.name;
    }
    return { ok: true, data: detail };
  }
  if (path === "/api/locations") return { ok: true, data: locations };
  if (path === "/api/catalog/tree") return { ok: true, data: { caseTypes: [] } };
  if (path === "/api/cases") return { ok: true, data: [detail] };
  if (path === "/api/cases/worklist") {
    return { ok: true, data: { rows: [detail], total: 1, page: 1, pageSize: 10, hasMore: false } };
  }
  if (path.startsWith("/api/organizations/")) {
    return { ok: true, data: { id: "browser-smoke-lab", name: "Browser Smoke Lab", type: "lab" } };
  }
  return { ok: true, data: [] };
}

async function verifyCaseHeader(page, baseUrl) {
  const patches = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/cases/${caseId}` && request.method() === "PATCH") {
      patches.push(request.postDataJSON());
    }
  });
  // A full document reload intentionally locks the secure workspace.
  // Open through the app's real navigation rather than bypassing that boundary.
  await page.getByTestId(`case-card-${caseId}`).click();
  await page.waitForURL(`${baseUrl}/case/${caseId}`);
  try {
    await page.getByTestId("locate-select").waitFor();
  } catch (error) {
    mkdirSync("/tmp/case-header-expo-web", { recursive: true });
    await page.screenshot({ path: "/tmp/case-header-expo-web/startup-failure.png" });
    throw new Error(`Header locator did not load at ${page.url()}:\n${await page.locator("body").innerText()}`, { cause: error });
  }
  const select = page.getByTestId("locate-select");
  await select.click();
  assert.equal(await page.getByTestId("option-station-polish").count(), 0);
  await page.getByTestId("option-station-glaze").click();

  for (const tab of ["history", "notes", "files", "restorations", "overview"]) {
    await page.getByTestId(`section-tab-${tab}`).click();
    await select.waitFor();
    assert.equal(await select.count(), 1, `One locator required on ${tab}`);
    assert.match(await select.innerText(), /Glaze Oven/);
    assert.equal(await page.getByTestId("case-detail-body").getByTestId("locate-select").count(), 0);
  }
  await page.getByTestId("overview-edit").click();
  await select.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("case-header-location").count(), 1);
  await page.getByTestId("overview-cancel").click();
  await select.waitFor();
  assert.match(await select.innerText(), /Glaze Oven/);

  mkdirSync("/tmp/case-header-expo-web", { recursive: true });
  for (const width of [320, 375, 430, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const el = (id) => document.querySelector(`[data-testid="${id}"]`);
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const header = el("case-top-header");
      const locator = el("case-header-location");
      const controls = ["locate-select", "locate-confirm", "case-back", "case-ask-maynard-btn", "case-remake-btn", "case-delete-btn", "case-print"];
      return {
        patient: rect(el("case-header-patient")),
        location: rect(locator),
        tabs: rect(el("section-tab-overview")),
        header: rect(header),
        inHeader: header.contains(locator),
        singleLocator: document.querySelectorAll('[data-testid="locate-select"]').length === 1,
        controls: controls.map((id) => {
          const element = el(id);
          const r = rect(element);
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          const range = document.createRange();
          range.selectNodeContents(element);
          const contentsFit = Array.from(range.getClientRects()).every((part) =>
            part.left >= r.left - 1 && part.right <= r.right + 1 &&
            part.top >= r.top - 1 && part.bottom <= r.bottom + 1);
          return { id, ...r, contentsFit, reachable: hit === element || element.contains(hit) };
        }),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    assert(geometry.inHeader && geometry.singleLocator, `One header locator required at ${width}px`);
    assert(geometry.patient.bottom <= geometry.location.top, `Locator must be below patient at ${width}px`);
    assert(geometry.location.bottom <= geometry.tabs.top, `Locator must be above tabs at ${width}px`);
    assert(!geometry.overflow, `Page overflow at ${width}px`);
    for (const control of geometry.controls) {
      assert(control.left >= geometry.header.left && control.right <= geometry.header.right, `${control.id} clipped at ${width}px`);
      assert(control.reachable, `${control.id} covered at ${width}px`);
      assert(control.contentsFit, `${control.id} text/icon clipped at ${width}px: ${JSON.stringify(control)}`);
    }
    for (let i = 0; i < geometry.controls.length; i++) {
      const a = geometry.controls[i];
      for (const b of geometry.controls.slice(i + 1)) {
        assert(!(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom),
          `${a.id} overlaps ${b.id} at ${width}px`);
      }
    }
    await page.screenshot({ path: `/tmp/case-header-expo-web/${width}.png` });
    console.log(`✓ Expo web header locator geometry and controls verified at ${width}px`);
  }
  await page.getByTestId("section-tab-history").click();
  await page.getByTestId("locate-confirm").click();
  await page.getByTestId("locate-success").waitFor();
  assert.deepEqual(patches, [{ status: "qc", labLocationId: "station-glaze" }]);
  await page.getByTestId("overview-current-location").getByText(locations[1].name, { exact: true }).waitFor();
  await select.click();
  assert.equal(await page.getByTestId("option-station-glaze").count(), 0);
  await page.getByTestId("option-station-polish").waitFor();
  console.log("✓ Expo web header locator retains selection across tabs/edits and routes same-status stations by exact id");
}

module.exports = { caseHeaderResponse, verifyCaseHeader };
