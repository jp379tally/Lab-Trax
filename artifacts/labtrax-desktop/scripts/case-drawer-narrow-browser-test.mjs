import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";

const appRoot = new URL("..", import.meta.url).pathname;
const timeout = 60_000;
const errors = [];
const screenshotDir = join(
  process.env["LABTRAX_BROWSER_ARTIFACT_DIR"] || "/tmp",
  "case-drawer-layout",
);

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Vite port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const testUrl = `${baseUrl}/desktop/browser-tests/case-drawer-narrow.html`;
const vite = spawn(
  "pnpm",
  ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: appRoot,
    env: { ...process.env, BASE_PATH: "/desktop/" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let browser;
try {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before the browser test started (${vite.exitCode})`);
    }
    try {
      const response = await fetch(testUrl);
      if (response.ok) break;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      "Chromium is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Chromium.",
    );
  }
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...process.env,
      LANG: "de_DE.UTF-8",
      LC_ALL: "de_DE.UTF-8",
    },
    timeout,
  });

  const page = await browser.newPage({
    locale: "de-DE",
    viewport: { width: 480, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(testUrl);
  await page.getByTestId("case-details-metadata").waitFor();
  const browserLocale = await page.evaluate(() => ({
    language: navigator.language,
    formattedDate: new Intl.DateTimeFormat(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(2026, 0, 16)),
  }));
  if (browserLocale.language !== "de-DE" || browserLocale.formattedDate !== "16.01.2026") {
    throw new Error(
      `Case drawer browser locale was not applied (${browserLocale.language}, ${browserLocale.formattedDate})`,
    );
  }

  async function readLocalizedDateControls() {
    const client = await page.context().newCDPSession(page);
    try {
      const { nodes } = await client.send("Accessibility.getFullAXTree");
      const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
      return nodes
        .filter((node) => node.role?.value === "Date")
        .map((date) => {
          const descendants = [];
          const pending = [...(date.childIds ?? [])];
          while (pending.length) {
            const child = nodesById.get(pending.shift());
            if (!child) continue;
            descendants.push(child);
            pending.push(...(child.childIds ?? []));
          }
          return {
            value: date.value?.value,
            segments: descendants
              .filter((node) => node.role?.value === "spinbutton")
              .map((node) => ({ name: node.name?.value, value: String(node.value?.value) })),
          };
        });
    } finally {
      await client.detach();
    }
  }

  async function checkLayout(width, query = "") {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${testUrl}${query}`);
    await page.getByTestId(query.includes("exception") ? "case-exception-open" : "case-exception-create").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const drawer = document.querySelector('[data-testid="case-drawer"]');
      const group = document.querySelector('[data-testid="case-header-actions"]');
      const location = document.querySelector('[data-testid="case-header-location"]');
      const patient = document.querySelector('[data-testid="case-header-patient"]');
      return {
        drawer: rect(drawer),
        actions: [...group.querySelectorAll("button")].map(rect),
        name: rect(document.querySelector('[data-testid="case-header-patient"] > span')),
        utilities: [...drawer.querySelectorAll('[data-testid="case-header-utilities"] button')].map(rect),
        patient: rect(patient),
        location: rect(location),
        tabs: rect(drawer.querySelector('[data-testid="case-detail-body"]').previousElementSibling),
        locatorControls: [...location.querySelectorAll("select,button")].map((element) => {
          const r = rect(element);
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return { ...r, reachable: hit === element || element.contains(hit) };
        }),
        singleLocation: document.querySelectorAll('[data-testid="locate-case-select"]').length === 1,
        inHeader: location.parentElement.tagName === "HEADER",
        bodyLocation: drawer.querySelector('[data-testid="case-detail-body"] [data-testid="locate-case-select"]') !== null,
        dividers: [...document.querySelectorAll('[data-testid="case-details-metadata-divider"]')].map(rect),
        metadata: rect(document.querySelector('[data-testid="case-details-metadata"]')),
        metadataFields: ["date-created", "due-date", "priority"].map((id) => rect(document.querySelector(`[data-testid="case-details-${id}"]`))),
        dates: rect(document.querySelector('[data-testid="case-details-dates"]')),
        dueDateCount: document.querySelectorAll('[data-testid="case-details-due-date"]').length,
        rush: rect(document.querySelector('[data-testid="case-details-rush-toggle"]')),
        overflow: drawer.scrollWidth > drawer.clientWidth + 1,
      };
    });
    const { actions, drawer, name, utilities } = geometry;
    if (actions.length !== 2 || Math.abs(actions[0].top - actions[1].top) > 1 || actions[0].right > actions[1].left) {
      throw new Error(`Remake and exception actions do not stay side by side in order at ${width}px`);
    }
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const r of [...actions, name, ...utilities, ...geometry.locatorControls]) {
      if (r.left < drawer.left || r.right > drawer.right) throw new Error(`Header clipped at ${width}px`);
    }
    for (const action of actions) {
      if (overlaps(action, name) || utilities.some((r) => overlaps(r, action))) {
        throw new Error(`Header actions overlap name or utility controls at ${width}px`);
      }
    }
    if (!geometry.singleLocation || !geometry.inHeader || geometry.bodyLocation ||
        geometry.patient.bottom > geometry.location.top || geometry.location.bottom > geometry.tabs.top ||
        geometry.locatorControls.some((r) => !r.reachable) ||
        geometry.locatorControls.some((r, index) => geometry.locatorControls.slice(index + 1).some((other) => overlaps(r, other))) ||
        [...actions, ...utilities].some((r) => overlaps(r, geometry.location))) {
      throw new Error(`Header locator is duplicated, misplaced, clipped or covered at ${width}px`);
    }
    if (geometry.overflow) throw new Error(`Drawer overflows at ${width}px`);
    const showDividers = geometry.metadata.width >= 640;
    if (geometry.dividers.length !== 1 || geometry.dividers.some((r) => showDividers ? r.height !== 16 || r.width !== 1 : r.width !== 0)) {
      throw new Error(`Metadata dividers are incorrect or detached at ${width}px`);
    }
    const [created, due, priority] = geometry.metadataFields;
    if (geometry.dueDateCount !== 1 || Math.abs(created.left - due.left) > 1 || created.bottom > due.top) {
      throw new Error(`Dates are duplicated or not vertically left-aligned at ${width}px`);
    }
    for (const field of [...geometry.metadataFields, geometry.rush]) {
      if (field.left < geometry.metadata.left || field.right > geometry.metadata.right ||
          field.top < geometry.metadata.top || field.bottom > geometry.metadata.bottom) {
        throw new Error(`Metadata field is clipped at ${width}px`);
      }
    }
    if (overlaps(geometry.dates, priority) || overlaps(geometry.dates, geometry.rush)) {
      throw new Error(`Priority or rush action overlaps the dates at ${width}px`);
    }
    if (showDividers && Math.abs(geometry.dates.top + geometry.dates.height / 2 - priority.top - priority.height / 2) > 1) {
      throw new Error(`A metadata divider is detached from its row at ${width}px`);
    }
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/${width}${query ? "-long-existing" : ""}.png` });
    console.log(`✓ Case drawer layout verified at ${width}px${query ? " with long name and existing exception" : ""}`);
  }

  async function checkTabWidths(width, query = "", expectedWidth) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${testUrl}${query}`);
    await page.getByTestId("case-detail-body").waitFor();
    await page.evaluate(() => document.fonts.ready);

    const tabLabels = ["Lab Slip", "Restorations", "Notes", "Files", "Invoice", "History"];
    const widths = [];
    for (const label of tabLabels) {
      await page.getByRole("tab", { name: new RegExp(`^${label}(?:\\s|$)`) }).click();
      const geometry = await page.evaluate(() => {
        const drawer = document.querySelector('[data-testid="case-drawer"]');
        const body = document.querySelector('[data-testid="case-detail-body"]');
        const rect = drawer.getBoundingClientRect();
        return {
          width: rect.width,
          left: rect.left,
          right: rect.right,
          overflow: drawer.scrollWidth > drawer.clientWidth + 1 ||
            body.scrollWidth > body.clientWidth + 1,
        };
      });
      if (geometry.overflow || geometry.left < -1 || geometry.right > width + 1) {
        throw new Error(`${label} tab overflows the ${width}px ${query.includes("docked") ? "docked " : ""}case drawer`);
      }
      widths.push(geometry.width);
    }

    if (widths.some((tabWidth) => Math.abs(tabWidth - widths[0]) > 1)) {
      throw new Error(`Case drawer width changes between tabs at ${width}px: ${widths.join(", ")}`);
    }
    if (expectedWidth != null && Math.abs(widths[0] - expectedWidth) > 1) {
      throw new Error(`Case drawer width at ${width}px was ${widths[0]}px; expected ${expectedWidth}px`);
    }
    await page.getByRole("tab", { name: /^Lab Slip(?:\s|$)/ }).click();
    console.log(`✓ Case drawer width is stable across all six tabs at ${width}px${query.includes("docked") ? " docked" : ""}`);
  }

  async function checkTabKeyboardNavigation() {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(testUrl);
    const tabs = page.getByRole("tab");
    const labels = ["Lab Slip", "Restorations", "Notes", "Files", "Invoice", "History"];
    const tablist = page.getByRole("tablist", { name: "Case details" });
    const panel = page.getByRole("tabpanel");
    if (await tabs.count() !== labels.length) {
      throw new Error(`Expected ${labels.length} case tabs, found ${await tabs.count()}`);
    }
    await page.getByRole("tab", { name: /^Lab Slip(?:\s|$)/ }).focus();
    for (let index = 0; index < labels.length; index += 1) {
      const selected = tabs.nth(index);
      await selected.press("ArrowRight");
      const nextIndex = (index + 1) % labels.length;
      const next = tabs.nth(nextIndex);
      await next.waitFor({ state: "visible" });
      const isSelected = await next.getAttribute("aria-selected");
      const tabIndex = await next.getAttribute("tabindex");
      const isFocused = await next.evaluate((element) => element === document.activeElement);
      if (isSelected !== "true" || tabIndex !== "0" || !isFocused) {
        throw new Error(`ArrowRight did not focus and select ${labels[nextIndex]}`);
      }
      if (await panel.getAttribute("aria-labelledby") !== await next.getAttribute("id")) {
        throw new Error(`The ${labels[nextIndex]} tab is not connected to its panel`);
      }
    }
    await tabs.nth(0).press("ArrowLeft");
    if (await tabs.nth(labels.length - 1).getAttribute("aria-selected") !== "true") {
      throw new Error("ArrowLeft did not wrap from the first tab to History");
    }
    await tabs.nth(labels.length - 1).press("Home");
    if (await tabs.nth(0).getAttribute("aria-selected") !== "true") {
      throw new Error("Home did not activate the first case tab");
    }
    await tabs.nth(0).press("End");
    if (await tabs.nth(labels.length - 1).getAttribute("aria-selected") !== "true") {
      throw new Error("End did not activate the last case tab");
    }
    await page.getByRole("tab", { name: /^Lab Slip(?:\s|$)/ }).click();
    await tablist.waitFor({ state: "visible" });
    console.log("✓ Case tabs expose tab semantics and support automatic keyboard navigation");
  }

  async function checkCaseSectionKeyboardActions() {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(`${testUrl}?accessibility=1`);
    await page.getByTestId("case-detail-body").waitFor();

    async function activateTab(label) {
      const tab = page.getByRole("tab", { name: new RegExp(`^${label}(?:\\s|$)`) });
      await tab.focus();
      if (await tab.getAttribute("aria-selected") !== "true") {
        await tab.press("Enter");
      }
    }

    await activateTab("Lab Slip");
    const editCaseNumber = page.getByRole("button", { name: "Edit case number", exact: true });
    await editCaseNumber.focus();
    await editCaseNumber.press("Enter");
    const caseNumberInput = page.getByRole("textbox", { name: "Case number", exact: true });
    await caseNumberInput.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Save case number", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Cancel case number edit", exact: true }).waitFor({ state: "visible" });
    await caseNumberInput.press("Escape");
    await editCaseNumber.waitFor({ state: "visible" });

    const editBarcode = page.getByRole("button", { name: "Edit barcode", exact: true });
    await editBarcode.focus();
    await editBarcode.press("Enter");
    const barcodeInput = page.getByRole("textbox", { name: "Case pan barcode", exact: true });
    await barcodeInput.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Save barcode", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Cancel barcode edit", exact: true }).waitFor({ state: "visible" });
    await barcodeInput.press("Escape");
    await editBarcode.waitFor({ state: "visible" });

    await activateTab("Restorations");
    const editRestorationPrice = page.getByRole("button", {
      name: "Edit price for Crown, tooth 8",
      exact: true,
    });
    await editRestorationPrice.focus();
    await editRestorationPrice.press("Enter");
    const priceInput = page.getByRole("spinbutton", {
      name: "Override unit price for Crown, tooth 8",
      exact: true,
    });
    await priceInput.waitFor({ state: "visible" });
    await priceInput.press("Escape");
    await editRestorationPrice.waitFor({ state: "visible" });

    await activateTab("Notes");
    await page.getByRole("textbox", { name: "Case note", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Dictate note", exact: true }).waitFor({ state: "visible" });

    await activateTab("Files");
    const expandFiles = page.getByRole("button", { name: "Expand all", exact: true });
    await expandFiles.focus();
    await expandFiles.press("Enter");
    await page.getByRole("button", { name: "Collapse all", exact: true }).waitFor({ state: "visible" });
    const shareAttachment = page.getByRole("button", {
      name: "Share case-note.pdf with provider",
      exact: true,
    });
    await shareAttachment.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Delete attachment case-note.pdf", exact: true }).waitFor({ state: "visible" });

    await activateTab("Invoice");
    const generateInvoice = page.getByRole("button", { name: "Generate Invoice", exact: true });
    await generateInvoice.waitFor({ state: "visible" });
    if (!(await generateInvoice.isEnabled())) {
      throw new Error("The keyboard-accessible invoice action is unexpectedly disabled");
    }

    await activateTab("History");
    const sortHistory = page.getByRole("button", { name: "Newest first", exact: true });
    await sortHistory.focus();
    await sortHistory.press("Enter");
    await page.getByRole("button", { name: "Oldest first", exact: true }).waitFor({ state: "visible" });

    await activateTab("Lab Slip");
    console.log("✓ Case section actions have clear names and respond to keyboard activation");
  }

  async function checkEditFieldWidths(width, query = "") {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${testUrl}${query}`);
    await page.getByTestId("case-details-edit").click();
    await page.getByRole("button", { name: "Save changes" }).waitFor();
    const localizedDateControls = await readLocalizedDateControls();
    const expectedDateControls = [
      {
        value: "2026-01-16",
        segments: [
          { name: "Tag", value: "16" },
          { name: "Monat", value: "1" },
          { name: "Jahr", value: "2026" },
        ],
      },
      {
        value: "2026-01-19",
        segments: [
          { name: "Tag", value: "19" },
          { name: "Monat", value: "1" },
          { name: "Jahr", value: "2026" },
        ],
      },
    ];
    if (localizedDateControls.length !== expectedDateControls.length ||
        localizedDateControls.some((control, index) => {
          const expected = expectedDateControls[index];
          return control.value !== expected.value ||
            JSON.stringify(control.segments) !== JSON.stringify(expected.segments);
        })) {
      throw new Error(
        `Case edit date fields did not render their German day-month-year segments at ${width}px: ${JSON.stringify(localizedDateControls)}`,
      );
    }
    const widths = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="case-drawer"]');
      const labels = [...drawer.querySelectorAll("label")];
      const doctorLabel = labels.find((label) => label.textContent.trim() === "Doctor name");
      const doctorButton = doctorLabel?.parentElement?.querySelector("button");
      const dateInputs = [...drawer.querySelectorAll('input[type="date"]')];
      const widthOf = (element) => element.getBoundingClientRect().width;
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      return {
        drawerWidth: widthOf(drawer),
        drawerRect: rectOf(drawer),
        overflow: drawer.scrollWidth > drawer.clientWidth + 1,
        doctorAvailableWidth: widthOf(doctorLabel.parentElement),
        doctorTriggerWidth: widthOf(doctorButton),
        dateWidths: dateInputs.map(widthOf),
        dateAvailableWidths: dateInputs.map((input) => widthOf(input.parentElement)),
        dateValues: dateInputs.map((input) => input.value),
        dateFields: dateInputs.map((input) => {
          const field = input.parentElement?.parentElement;
          const wrapper = input.parentElement;
          const style = getComputedStyle(input);
          const picker = getComputedStyle(input, "::-webkit-calendar-picker-indicator");
          return {
            label: field?.querySelector("label")?.textContent.trim(),
            rect: rectOf(input),
            wrapperRect: rectOf(wrapper),
            visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0,
            inputOverflow: input.scrollWidth > input.clientWidth + 1,
            wrapperOverflow: wrapper.scrollWidth > wrapper.clientWidth + 1,
            calendarPickerVisible:
              picker.display !== "none" &&
              picker.visibility !== "hidden" &&
              Number(picker.opacity) > 0 &&
              picker.getPropertyValue("-webkit-appearance") !== "none",
          };
        }),
      };
    });
    if (widths.dateWidths.length !== 2 ||
        widths.dateValues[0] !== "2026-01-16" ||
        widths.dateValues[1] !== "2026-01-19") {
      throw new Error(`Case edit date fields are missing or changed at ${width}px`);
    }
    const expectedDateLabels = ["Date Received", "Due Date"];
    for (let index = 0; index < widths.dateFields.length; index += 1) {
      const field = widths.dateFields[index];
      if (field.label !== expectedDateLabels[index] || !field.visible || !field.calendarPickerVisible) {
        throw new Error(`${expectedDateLabels[index]} or its calendar icon is not visible at ${width}px`);
      }
      if (field.rect.left < widths.drawerRect.left ||
          field.rect.right > widths.drawerRect.right ||
          field.rect.left < field.wrapperRect.left ||
          field.rect.right > field.wrapperRect.right ||
          field.inputOverflow ||
          field.wrapperOverflow) {
        throw new Error(`${expectedDateLabels[index]} is clipped or overflows its field at ${width}px`);
      }
    }
    for (let index = 0; index < widths.dateWidths.length; index += 1) {
      const dateWidth = widths.dateWidths[index];
      const expectedDateWidth = Math.min(144, widths.dateAvailableWidths[index]);
      if (Math.abs(dateWidth - expectedDateWidth) > 1 || dateWidth > widths.drawerWidth) {
        throw new Error(`Case edit date input is oversized at ${width}px (${dateWidth}px)`);
      }
    }
    const expectedDoctorWidth = Math.min(384, widths.doctorAvailableWidth);
    if (Math.abs(widths.doctorTriggerWidth - expectedDoctorWidth) > 1 || widths.overflow) {
      throw new Error(`Case edit doctor picker does not fit its drawer at ${width}px`);
    }

    const doctorButton = page.locator('[data-testid="case-drawer"] label')
      .filter({ hasText: /^Doctor name$/ })
      .locator("..")
      .getByRole("button")
      .first();
    await doctorButton.click();
    const menuWidth = await doctorButton.evaluate((button) => {
      const menu = button.parentElement?.querySelector(":scope > div.absolute");
      return menu?.getBoundingClientRect().width ?? -1;
    });
    const triggerWidth = await doctorButton.evaluate((button) => button.getBoundingClientRect().width);
    if (Math.abs(menuWidth - triggerWidth) > 1) {
      throw new Error(`Case edit doctor menu width differs from its trigger at ${width}px`);
    }
    await doctorButton.click();
    await page.screenshot({
      path: join(screenshotDir, `edit-fields-${width}${query.includes("docked") ? "-docked" : ""}-de-DE.png`),
    });
    console.log(`✓ Case edit date fields and widths verified at ${width}px${query.includes("docked") ? " in docked mode" : ""} (de-DE)`);
  }

  async function checkPinnedEditActions(width, query = "") {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`${testUrl}${query}`);
    await page.getByTestId("case-details-edit").waitFor();
    if (await page.getByTestId("case-edit-action-bar").count()) {
      throw new Error("Case action bar appeared without an open editor");
    }
    const body = page.getByTestId("case-detail-body");
    const fullHeight = await body.evaluate((element) => element.clientHeight);
    await page.getByTestId("case-details-edit").click();
    const bar = page.getByTestId("case-edit-action-bar");
    await bar.waitFor();
    // Wait for the existing barcode auto-focus before measuring scroll geometry.
    await page.waitForTimeout(100);
    async function geometry() {
      return page.evaluate(() => {
        const body = document.querySelector('[data-testid="case-detail-body"]');
        const bar = document.querySelector('[data-testid="case-edit-action-bar"]');
        const pane = document.querySelector('[data-testid="case-drawer"]');
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        };
        return {
          body: rect(body), bar: rect(bar), pane: rect(pane),
          siblings: body.nextElementSibling === bar,
          scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight,
          buttons: [...bar.querySelectorAll("button")].map((button) => {
            const r = rect(button);
            const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return { ...r, reachable: hit === button || button.contains(hit) };
          }),
        };
      });
    }
    await body.evaluate((element) => { element.scrollTop = 0; });
    const before = await geometry();
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await geometry();
    if (!after.siblings || after.body.bottom > after.bar.top + 1 ||
        Math.abs(after.bar.bottom - after.pane.bottom) > 2 ||
        after.maxScroll <= 0 || after.scrollTop <= before.scrollTop ||
        Math.abs(before.bar.top - after.bar.top) > 1 ||
        after.buttons.length !== 2 || after.buttons.some((button) => !button.reachable)) {
      throw new Error(`Case edit footer moves, overlays, or has unreachable buttons at ${width}px${query}`);
    }
    const lastField = page.getByPlaceholder("e.g. Light Pink");
    await lastField.scrollIntoViewIfNeeded();
    const lastRect = await lastField.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    if (lastRect.top < after.body.top || lastRect.bottom > after.body.bottom) {
      throw new Error(`The last case field is hidden behind the edit footer at ${width}px`);
    }
    await page.getByPlaceholder("Prescription notes…").fill("Footer Rx note draft");
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: join(screenshotDir, `edit-footer-${width}${query ? "-docked" : ""}.png`) });
    await page.getByTestId("case-details-edit-cancel").click();
    if (await bar.count() || await body.evaluate((element) => element.clientHeight) !== fullHeight) {
      throw new Error(`Cancel does not restore the case pane height at ${width}px`);
    }
    await page.getByTestId("case-details-edit").click();
    await page.getByTestId("case-details-edit-save").click();
    // Save commits in one press and closes the editor; there is no staged
    // "Unsaved changes" step left to confirm or discard.
    await bar.waitFor({ state: "detached" });
    if (await page.getByTestId("case-pending-actions").count()) {
      throw new Error(`Saving left a staged pending-changes footer open at ${width}px${query}`);
    }
    await page.getByRole("tab", { name: "Lab Slip", exact: true }).click();
    await page.getByTestId("case-details-edit").click();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    if (await bar.count()) throw new Error("Leaving Lab Slip left the editor footer open");
    console.log(`✓ Pinned case edit actions, last-field access and closure verified at ${width}px${query}`);
  }

   await checkLayout(1280);
   await checkLayout(700);
  await checkLayout(700, "?longName=1&exception=1");
  await checkLayout(480, "?longName=1&exception=1");
  await checkLayout(360, "?longName=1&exception=1");
  await checkLayout(360);
  await checkLayout(480);
   await checkLayout(320, "?longName=1&exception=1");
   await checkLayout(1024, "?docked=1&longName=1&exception=1");
   await checkLayout(480);
  await checkTabWidths(1440, "", 1280);
  await checkTabWidths(360);
  await checkTabWidths(1024, "?docked=1");
  await checkTabKeyboardNavigation();
  await checkCaseSectionKeyboardActions();

  const metadata = page.getByTestId("case-details-metadata");
  const metadataFields = [
    page.getByTestId("case-details-date-created"),
    page.getByTestId("case-details-due-date"),
    page.getByTestId("case-details-priority"),
  ];
  const labels = ["Date Created:", "Due Date:", "Priority:"];
  const expectedValues = ["01/15/2026", "01/19/2026 at 1:30 PM", "Standard"];
  for (let index = 0; index < metadataFields.length; index += 1) {
    const field = metadataFields[index];
    await field.waitFor({ state: "visible" });
    const text = await field.innerText();
    if (!text.includes(labels[index]) || !text.includes(expectedValues[index])) {
      throw new Error(`Narrow drawer hid or clipped ${labels[index]} metadata`);
    }
    const inBounds = await field.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.closest('[data-testid="case-drawer"]')?.getBoundingClientRect();
      return Boolean(parent && rect.left >= parent.left && rect.right <= parent.right);
    });
    if (!inBounds) throw new Error(`${labels[index]} metadata is clipped by the case drawer`);
  }
  const hasHorizontalOverflow = await metadata.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  if (hasHorizontalOverflow) throw new Error("Case metadata overflows horizontally");

  const fieldRects = await Promise.all(
    metadataFields.map((field) =>
      field.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    ),
  );
  if (new Set(fieldRects.map((rect) => Math.round(rect.top))).size < 2) {
    throw new Error("Case metadata did not wrap at the narrow desktop width");
  }
  for (let i = 0; i < fieldRects.length; i += 1) {
    for (let j = i + 1; j < fieldRects.length; j += 1) {
      const a = fieldRects[i];
      const b = fieldRects[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        throw new Error("Case metadata fields overlap at the narrow desktop width");
      }
    }
  }

  const actionButtons = [
    page.getByTestId("case-details-rush-toggle"),
    page.getByTestId("case-details-layout"),
    page.getByTestId("case-details-print"),
    page.getByTestId("case-details-edit"),
  ];
  const actionRects = [];
  for (const button of actionButtons) {
    await button.waitFor({ state: "visible" });
    if (!(await button.isEnabled())) throw new Error("A case action is disabled");
    const hitTarget = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    });
    if (!hitTarget) throw new Error(`Case action is covered: ${await button.innerText()}`);
    actionRects.push(
      await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    );
  }
  for (let i = 0; i < actionRects.length; i += 1) {
    for (let j = i + 1; j < actionRects.length; j += 1) {
      const a = actionRects[i];
      const b = actionRects[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        throw new Error("Case drawer actions overlap at the narrow desktop width");
      }
    }
  }

  await page.getByTestId("case-details-layout").click();
  await page.getByRole("dialog", { name: "Print Layout Editor" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const [printPage] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByTestId("case-details-print").click(),
  ]);
  await printPage.locator("body").waitFor();
  if (!(await printPage.locator("body").innerText()).includes("Case 26-99")) {
    throw new Error("Print action did not open the case slip");
  }
  await printPage.close();

  await page.getByTestId("case-details-edit").click();
  await page.getByRole("button", { name: "Save changes" }).waitFor();
  if (await page.getByTestId("locate-case-select").count() !== 1 ||
      !(await page.getByTestId("locate-case-select").isVisible())) {
    throw new Error("Location control was duplicated or hidden in edit mode");
  }

  await page.getByTestId("case-details-rush-toggle").click();
  await page.getByRole("button", { name: "Clear rush" }).waitFor();

  await checkEditFieldWidths(1024, "?docked=1");
  await checkEditFieldWidths(320);
  await checkPinnedEditActions(700);
  await checkPinnedEditActions(320);
  await checkPinnedEditActions(1440, "?docked=1");
  await checkEditFieldWidths(320, "?docked=1");

  if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
  console.log("✓ Narrow case drawer keeps metadata readable and actions usable without overlap");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
