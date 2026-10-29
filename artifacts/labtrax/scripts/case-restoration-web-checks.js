// Geometry comes from the actual exported Expo app, never React Native host stubs.
// All API traffic uses synthetic in-memory fixtures. This does not verify iOS/Android Dynamic Type.
const { strict: assert } = require("node:assert");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { expect } = require("@playwright/test");

const caseId = "restoration-browser-case";
const subtypeLabel = "Dentures with a long laboratory-specific description";
const materialLabel = "High impact multilayer acrylic with reinforced base";
const upperShade = "A2 custom layered incisal blend with translucent detail";
const detail = {
  id: caseId, caseNumber: "26-RESTORATION", patientFirstName: "Sample", patientLastName: "Patient",
  doctorName: "Dr. Sample", status: "in_progress", labOrganizationId: "browser-smoke-lab",
  organizationId: "browser-smoke-lab", priority: "normal",
  createdAt: "2026-01-15T10:00:00.000Z", updatedAt: "2026-01-15T10:00:00.000Z",
  dueDate: "2026-11-15", receivedAt: "2026-01-15", step: "wax_setup", stepShade: "A2",
  isCustomShade: true, customShadeTechnician: "Sample shade technician", customShadePicturesAvailable: true,
  gingivialShade: "Light Pink", bridgeConnectors: "Recorded connector information",
  caseNotes: "Keep these original prescription instructions.", casePanBarcode: "REST-123",
  restorations: [
    { id: "arch-upper", restorationType: "Full Denture", restorationSubtype: "removable/dentures/acrylic", material: materialLabel, arch: "upper", toothNumber: "", shade: upperShade },
    { id: "arch-lower", restorationType: "Full Denture", restorationSubtype: "removable/dentures/acrylic", material: materialLabel, arch: "lower", toothNumber: "", shade: "B1" },
  ],
  notes: [], events: [], attachments: [],
};
const catalog = { labOrganizationId: "browser-smoke-lab", caseTypes: [{
  key: "removable", label: "Removable", subtypes: [{
    key: "dentures", label: subtypeLabel, id: null, isCustom: false, isActive: true, sortOrder: 0,
    materials: [{ key: "acrylic", label: materialLabel, id: null, isCustom: false, isActive: true, sortOrder: 0 }],
  }],
}] };
const writes = [];
let refuseNextWrite = false;

function caseRestorationResponse(request) {
  const path = new URL(request.url()).pathname;
  const payload = request.method() === "PATCH" ? request.postDataJSON() : null;
  // The live-update subscription requests a short-lived websocket ticket on entry.
  // That POST authenticates a read stream; it cannot save case or invoice data.
  const subscriptionTicket = path === `/api/cases/${caseId}/ws-ticket` && request.method() === "POST";
  if (path.startsWith(`/api/cases/${caseId}`) && !["GET", "HEAD"].includes(request.method()) && !subscriptionTicket) {
    writes.push({ path, method: request.method(), payload });
    if (refuseNextWrite) {
      refuseNextWrite = false;
      return { status: 409, body: { error: "This case is locked. The saved selection has not changed." } };
    }
  }
  const ok = (data) => ({ status: 200, body: { ok: true, data } });
  if (path === `/api/cases/${caseId}/restorations/hierarchy`) {
    if (payload) for (const row of detail.restorations) {
      for (const key of ["restorationType", "restorationSubtype", "material", "shade"]) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) row[key] = payload[key];
      }
    }
    return ok({ invoiceAction: "updated", updatedCount: 2, createdCount: 0, deletedCount: 0, repricedCount: 0, unpricedCount: 0, manualPriceCount: 0 });
  }
  const row = detail.restorations.find((row) => path === `/api/cases/${caseId}/restorations/${row.id}`);
  if (row) {
    if (payload) Object.assign(row, payload);
    return ok(row);
  }
  if (path === `/api/cases/${caseId}`) {
    if (payload) Object.assign(detail, payload);
    return ok(detail);
  }
  if (path === "/api/catalog/tree") return ok(catalog);
  if (path === "/api/vocabulary") return ok([{ id: "shade-a2", kind: "shade", value: "A2" }]);
  if (path === "/api/cases") return ok([detail]);
  if (path === "/api/cases/worklist") return ok({ rows: [detail], total: 1, page: 1, pageSize: 10, hasMore: false });
  if (path.startsWith("/api/organizations/")) return ok({ id: "browser-smoke-lab", name: "Browser Smoke Lab", type: "lab" });
  return ok([]);
}

async function checkGeometry(page, editing, width, scale, screenshotsDir) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate((scale) => {
    const root = document.querySelector('[data-testid="overview-details-card"]');
    for (const element of root.querySelectorAll("*")) {
      if (!Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) &&
          !["INPUT", "TEXTAREA"].includes(element.tagName)) continue;
      const style = getComputedStyle(element);
      const size = Number(element.dataset.originalFontSize || parseFloat(style.fontSize));
      const line = Number(element.dataset.originalLineHeight || parseFloat(style.lineHeight) || size * 1.4);
      element.dataset.originalFontSize = String(size);
      element.dataset.originalLineHeight = String(line);
      element.style.fontSize = `${size * scale}px`;
      element.style.lineHeight = `${line * scale}px`;
    }
  }, scale);
  const ids = editing
    ? ["clinical-case-type-select", "clinical-subtype-select", "clinical-case-material-select", "clinical-arch-select", "clinical-step-select"]
    : ["hierarchy-edit-btn", "hierarchy-edit-subtype-btn", "hierarchy-edit-material-btn", "hierarchy-edit-arch-btn", "step-select"];
  ids.push(...(editing
    ? ["tooth-shade-value-arch-upper", "tooth-shade-value-arch-lower"]
    : ["tooth-shade-select-arch-upper", "tooth-shade-select-arch-lower"]));
  const geometry = await page.evaluate(({ ids, editing }) => {
    const el = (id) => document.querySelector(`[data-testid="${id}"]`);
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const contentBounds = (element, bounds) => {
      const parts = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        // RN-web uses pre-wrap. A line's hanging trailing space may extend past
        // its box even when every visible glyph fits; measure every visible word.
        for (const match of walker.currentNode.textContent.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(walker.currentNode, match.index);
          range.setEnd(walker.currentNode, match.index + match[0].length);
          parts.push(...Array.from(range.getClientRects()));
        }
      }
      parts.push(...Array.from(element.querySelectorAll("svg,img")).map((icon) => icon.getBoundingClientRect()));
      return parts.every((part) =>
        part.left >= bounds.left - 1 && part.right <= bounds.right + 1 &&
        part.top >= bounds.top - 1 && part.bottom <= bounds.bottom + 1);
    };
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      order: (editing ? ["priority-select", "overview-restoration-details", "overview-edit-patient-provider"] :
        ["overview-date-created", "overview-due-date", "overview-priority", "overview-restoration-details", "overview-patient-doctor-practice"])
        .map((id) => ({ id, ...box(el(id)) })),
      controls: ids.map((id) => {
        const control = el(id);
        const label = control.parentElement.firstElementChild;
        const bounds = box(control);
        const labelBounds = box(label);
        return { id, ...bounds, label: labelBounds, interactive: control.getAttribute("role") === "button",
          contentsFit: contentBounds(control, bounds),
          labelContentsFit: contentBounds(label, labelBounds),
          labelText: label.textContent,
          labelFontSize: parseFloat(getComputedStyle(label).fontSize),
          field: box(control.parentElement),
        };
      }),
    };
  }, { ids, editing });
  const context = `${editing ? "edit" : "view"} ${width}px text ${scale}x`;
  assert(!geometry.overflow, `Page overflows: ${context}`);
  for (let i = 1; i < geometry.order.length; i++) {
    assert(geometry.order[i - 1].bottom <= geometry.order[i].top + 1,
      `Incorrect field order: ${context} ${JSON.stringify(geometry.order)}`);
  }
  for (const c of geometry.controls) {
    if (c.interactive) assert(c.height >= 44, `${c.id} is below the touch-target minimum: ${context}`);
    assert(c.label.bottom <= c.top + 1, `${c.id} heading is not above its control: ${context}`);
    assert(c.width >= c.field.width - 2, `${c.id} is not full width: ${context}`);
    assert(c.contentsFit && c.labelContentsFit, `${c.id} clips its text/icon: ${context} ${JSON.stringify(c)}`);
    assert(c.left >= -1 && c.right <= width + 1, `${c.id} exceeds viewport: ${context}`);
    if (c.labelText === "Upper arch" || c.labelText === "Lower arch") {
      assert(c.label.height < c.labelFontSize * 3.1, `Arch heading is character-wrapped: ${context}`);
    }
  }
  await page.getByTestId(ids[0]).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshotsDir, `${editing ? "edit" : "view"}-${width}-${scale}.png`) });
  console.log(`✓ Actual Expo web restoration layout: ${context}, including heading/value/icon bounds`);
  return { context, ...geometry };
}

async function verifyCaseRestoration(page, baseUrl) {
  const screenshotsDir = join(__dirname, "../../../generated-artifacts/mobile-restoration");
  mkdirSync(screenshotsDir, { recursive: true });
  await page.getByTestId(`case-card-${caseId}`).click();
  await page.waitForURL(`${baseUrl}/case/${caseId}`);
  await page.getByTestId("section-tab-overview").click();
  await expect(page.getByTestId("hierarchy-subtype-value")).toHaveText(subtypeLabel);
  await expect(page.getByTestId("hierarchy-material-value")).toHaveText(materialLabel);
  await expect(page.getByTestId("tooth-shade-value-arch-upper")).toHaveText(upperShade);
  assert.equal(await page.getByTestId("overview-restoration-details").count(), 1);
  for (const id of ["hierarchy-edit-btn", "hierarchy-edit-subtype-btn", "hierarchy-edit-material-btn", "tooth-shade-select-arch-upper"]) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute("aria-expanded", "false");
  }
  assert.deepEqual(writes, [], "Opening/dismissing must not write or reprice");
  const measurements = [];
  for (const width of [320, 375, 430]) {
    for (const scale of [1, 1.8]) measurements.push(await checkGeometry(page, false, width, scale, screenshotsDir));
  }
  await page.getByTestId("overview-edit").click();
  assert.equal(await page.getByTestId("tooth-shade-select-arch-upper").count(), 0, "Edit must not offer an immediate upper-arch save");
  assert.equal(await page.getByTestId("tooth-shade-select-arch-lower").count(), 0, "Edit must not offer an immediate lower-arch save");
  for (const width of [320, 375]) {
    for (const scale of [1, 1.8]) measurements.push(await checkGeometry(page, true, width, scale, screenshotsDir));
  }
  await page.getByTestId("clinical-case-material-select").click();
  await page.getByTestId("clinical-case-material-").click();
  await expect(page.getByTestId("clinical-case-material-value")).toHaveText("—");
  assert.equal(writes.length, 0, "Edit choices must remain a draft");
  await page.getByTestId("overview-cancel").click();
  await expect(page.getByTestId("hierarchy-material-value")).toHaveText(materialLabel);
  assert.equal(writes.length, 0, "Cancel must not write");

  refuseNextWrite = true;
  await page.getByTestId("hierarchy-edit-material-btn").click();
  await page.getByTestId("quick-material-none").click();
  await expect(page.getByRole("alert")).toContainText("This case is locked");
  await expect(page.getByTestId("hierarchy-material-value")).toHaveText(materialLabel);
  assert.equal(writes.length, 1, "Refused quick edit must not write again");
  await page.getByTestId("tooth-shade-select-arch-upper").click();
  await page.getByTestId("tooth-shade-option-arch-upper-A2").click();
  await expect(page.getByTestId("tooth-shade-value-arch-upper")).toHaveText("A2");
  await expect(page.getByTestId("tooth-shade-value-arch-lower")).toHaveText("B1");
  await page.getByTestId("tooth-shade-select-arch-upper").click();
  await page.getByTestId("tooth-shade-option-clear-arch-upper").click();
  await expect(page.getByTestId("tooth-shade-value-arch-upper")).toContainText("No shade");
  await expect(page.getByTestId("tooth-shade-value-arch-lower")).toHaveText("B1");
  await page.getByTestId("section-tab-history").click();
  await page.getByTestId("section-tab-overview").click();
  await expect(page.getByTestId("tooth-shade-value-arch-upper")).toContainText("No shade");
  await expect(page.getByTestId("tooth-shade-value-arch-lower")).toHaveText("B1");
  assert.deepEqual(writes.slice(1).map((write) => ({ path: write.path, payload: write.payload })), [
    { path: `/api/cases/${caseId}/restorations/arch-upper`, payload: { shade: "A2", syncLinkedArch: false } },
    { path: `/api/cases/${caseId}/restorations/arch-upper`, payload: { shade: "", syncLinkedArch: false } },
  ]);
  writeFileSync(join(screenshotsDir, "geometry.json"), JSON.stringify(measurements, null, 2));
  console.log("✓ Expo web draft/cancel, refusal, refetch and independent same-appliance arch shades; only explicit selections wrote");
}

module.exports = { caseRestorationResponse, verifyCaseRestoration };
