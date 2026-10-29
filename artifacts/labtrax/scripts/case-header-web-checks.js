// Real Expo-web geometry and state checks; called by the shared export runner.
const { strict: assert } = require("node:assert");
const { mkdirSync } = require("node:fs");
const { expect } = require("@playwright/test");

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
  await page.getByTestId("locate-success").waitFor();
  await expect(page.getByTestId("overview-current-location")).toHaveText(locations[1].name);
  assert.deepEqual(patches, [{ status: "qc", labLocationId: "station-glaze" }]);
  assert.equal(await page.getByTestId("locate-confirm").count(), 0);

  for (const tab of ["history", "notes", "files", "restorations", "overview"]) {
    await page.getByTestId(`section-tab-${tab}`).click();
    await select.waitFor();
    assert.equal(await select.count(), 1, `One locator required on ${tab}`);
    await expect(page.getByTestId("overview-current-location")).toHaveText(locations[1].name);
    assert.equal(await page.getByTestId("case-detail-body").getByTestId("locate-select").count(), 0);
  }
  await page.getByTestId("overview-edit").click();
  await select.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("case-header-location").count(), 1);
  await page.getByTestId("overview-cancel").click();
  await select.waitFor();
  await expect(page.getByTestId("overview-current-location")).toHaveText(locations[1].name);
  await select.click();
  assert.equal(await page.getByTestId("option-station-glaze").count(), 0);
  await page.getByTestId("option-station-polish").click();
  await expect(page.getByTestId("overview-current-location")).toHaveText(locations[0].name);
  assert.deepEqual(patches, [
    { status: "qc", labLocationId: "station-glaze" },
    { status: "qc", labLocationId: "station-polish" },
  ]);
  console.log("✓ Expo web header retains location across tabs/edits and routes same-status stations by exact id");

  mkdirSync("/tmp/case-header-expo-web", { recursive: true });
  for (const name of [
    { label: "short", first: "Jane", last: "Doe" },
    { label: "long", first: "Alexandria Catherine", last: "Montgomery Worthington Smythe" },
    { label: "unbroken", first: "AlexandriaCatherineMontgomeryWorthingtonSmythe", last: "" },
  ]) {
    // Exercise the real name source and component, not a replacement DOM fixture.
    await page.getByTestId("case-back").click();
    await page.getByTestId(`case-card-${caseId}`).waitFor();
    detail.patientFirstName = name.first;
    detail.patientLastName = name.last;
    await page.getByTestId(`case-card-${caseId}`).click();
    await expect(page.getByTestId("case-header-patient")).toHaveText(`${name.first} ${name.last}`.trim());
    await page.getByTestId("section-tab-overview").click();
    await page.getByTestId("locate-select").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const scenarios = name.label === "short"
      ? [{ width: 375, fontScale: 1 }]
      : [
        { width: 320, fontScale: 1 },
        { width: 375, fontScale: 1 },
        { width: 430, fontScale: 1 },
        { width: 1024, fontScale: 1 },
        { width: 320, fontScale: 2 },
        { width: 375, fontScale: 1.8 },
      ];
    for (const scenario of scenarios) {
      await verifyHeaderGeometry(page, name.label, scenario);
    }
  }
  await page.getByTestId("case-back").click();
  await page.getByTestId(`case-card-${caseId}`).waitFor();
  console.log("✓ Real case back navigation retained");
}

async function verifyHeaderGeometry(page, name, { width, fontScale }) {
    await page.setViewportSize({ width, height: 720 });
    // RN Web does not implement native Dynamic Type. Enlarge the actual header's
    // text and line heights (not the icons) to measure a text-only scaling proxy.
    // Native allowFontScaling/no-cap contracts are covered by the screen tests.
    await page.getByTestId("case-top-header").evaluate((header, scale) => {
      for (const element of header.querySelectorAll("*")) {
        const hasText = Array.from(element.childNodes).some((node) =>
          node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const style = getComputedStyle(element);
        if (!hasText || /ionicons/i.test(style.fontFamily)) continue;
        element.dataset.headerBaseFontSize ??= style.fontSize;
        element.dataset.headerBaseLineHeight ??= style.lineHeight;
        element.style.fontSize = `${parseFloat(element.dataset.headerBaseFontSize) * scale}px`;
        const lineHeight = parseFloat(element.dataset.headerBaseLineHeight);
        if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * scale}px`;
      }
    }, fontScale);
    const geometry = await page.evaluate(() => {
      const el = (id) => document.querySelector(`[data-testid="${id}"]`);
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const header = el("case-top-header");
      const locator = el("case-header-location");
      const patient = el("case-header-patient");
      const patientStyle = getComputedStyle(patient);
      // RN Web uses pre-wrap: a trailing space may legally hang outside its
      // line. Measure visible glyphs, not that non-painted whitespace rectangle.
      const patientGlyphs = [];
      const walker = document.createTreeWalker(patient, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let offset = 0; offset < node.textContent.length; offset++) {
          if (/\s/.test(node.textContent[offset])) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const r = range.getBoundingClientRect();
          patientGlyphs.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        }
      }
      const controls = ["locate-select", "case-back", "case-ask-maynard-btn", "case-remake-btn", "case-delete-btn", "case-print"];
      return {
        patient: rect(patient),
        patientGlyphs,
        patientStyle: {
          fontSize: parseFloat(patientStyle.fontSize),
          lineHeight: parseFloat(patientStyle.lineHeight),
          fontFamily: patientStyle.fontFamily,
          fontLoaded: document.fonts.check(`18px ${patientStyle.fontFamily}`),
        },
        patientColumn: rect(patient.parentElement),
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
    const context = `${name}, ${width}px, ${fontScale}x text`;
    assert.equal(geometry.patientStyle.fontSize, 18 * fontScale, context);
    assert.equal(geometry.patientStyle.lineHeight, 24 * fontScale, context);
    assert.match(geometry.patientStyle.fontFamily, /Inter_700Bold/, context);
    assert(geometry.patientStyle.fontLoaded, `Bold font not loaded: ${context}`);
    assert(geometry.inHeader && geometry.singleLocator, `One header locator required: ${context}`);
    assert(geometry.patient.bottom <= geometry.location.top, `Locator must be below patient: ${context}`);
    assert(geometry.location.bottom <= geometry.tabs.top, `Locator must be above tabs: ${context}`);
    assert(!geometry.overflow, `Page overflow: ${context}`);
    assert(geometry.patientGlyphs.length > 0, `Missing rendered name: ${context}`);
    if (name !== "short" && width <= 430) {
      assert(geometry.patient.height > geometry.patientStyle.lineHeight + 1, `Long name must wrap: ${context}`);
    }
    for (const glyph of geometry.patientGlyphs) {
      assert(glyph.left >= geometry.patientColumn.left - 1 && glyph.right <= geometry.patientColumn.right + 1,
        `Patient text overflows its column: ${context}: ${JSON.stringify(glyph)}`);
      assert(glyph.top >= geometry.patient.top - 1 && glyph.bottom <= geometry.patient.bottom + 1,
        `Patient text clipped vertically: ${context}`);
    }
    for (const control of geometry.controls) {
      assert(control.left >= geometry.header.left && control.right <= geometry.header.right, `${control.id} clipped: ${context}`);
      assert(control.reachable, `${control.id} covered: ${context}`);
      assert(control.contentsFit, `${control.id} text/icon clipped: ${context}: ${JSON.stringify(control)}`);
      assert(!overlaps(geometry.patient, control), `Patient name overlaps ${control.id}: ${context}`);
    }
    for (let i = 0; i < geometry.controls.length; i++) {
      const a = geometry.controls[i];
      for (const b of geometry.controls.slice(i + 1)) {
        assert(!overlaps(a, b), `${a.id} overlaps ${b.id}: ${context}`);
      }
    }
    await page.screenshot({ path: `/tmp/case-header-expo-web/${name}-${width}-${fontScale}x.png` });
    console.log(`✓ Rendered Expo web name, wrapping, no overlap/overflow, and controls verified: ${context}`);
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

module.exports = { caseHeaderResponse, verifyCaseHeader };
