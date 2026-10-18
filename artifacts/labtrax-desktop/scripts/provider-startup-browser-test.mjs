import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

// Persisted fresh-account session, with only network responses substituted.
// No customer records, credentials, billing actions, or database writes.
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const path = execFileSync("which", [name], { encoding: "utf8", timeout: 3000 }).trim();
      if (existsSync(path)) return path;
    } catch { /* Try the next common executable; never traverse the entire Nix store. */ }
  }
  throw new Error("Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium executable.");
}
const executablePath = findChromium();
async function run() {
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const baseline = process.argv.includes("--reproduce");
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let organizations = [];
  let cases = [];
  let failOrganizations = false;
  const requests = [];
  await page.addInitScript(() => {
    localStorage.setItem("labtrax_desktop_tokens_v1", JSON.stringify({
      accessToken: "synthetic-browser-fixture", refreshToken: "synthetic-browser-fixture",
    }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, "");
    requests.push({ path, method: route.request().method(),
      practice: route.request().headers()["x-provider-organization-id"] ?? null });
    let data = null;
    if (path === "/auth/me") data = { user: {
      id: "provider-browser-fixture", username: "Portal fixture", userType: "provider",
    }, memberships: organizations.map((org) => ({
      organizationId: org.id, role: "owner", status: "active",
    })) };
    else if (path === "/provider/organizations") data = organizations;
    else if (path === "/provider/selection") data = { ok: true };
    else if (path === "/billing/subscription") {
      return route.fulfill({ json: { entitlement: {
        status: "trialing", accessLevel: "full", planType: null,
        subjectType: "provider_user", subjectId: "provider-browser-fixture",
      } } });
    } else if (path === "/billing/plans") return route.fulfill({ json: { plans: [] } });
    else if (path === "/notifications") data = [];
    else if (path === "/cases/provider") data = cases;
    else if (path === "/provider-messenger/unread-count") data = { total: 0 };
    else if (path === "/provider/dashboard") data = { cases: [], labs: [], summary: {} };
    else data = {};
    if (path === "/provider/organizations" && failOrganizations) {
      return route.fulfill({ status: 503, json: { message: "Practice service unavailable" } });
    }
    return route.fulfill({ json: { ok: true, data } });
  });
  const origin = process.env.PROVIDER_BROWSER_URL || "http://localhost:80";
  await page.goto(`${origin}/desktop/settings`);
  await page.getByRole("button", { name: /Dashboard/ }).waitFor({ timeout: 20000 })
    .catch(async (error) => { console.log({ body: await page.locator("body").innerText(), errors, requests }); throw error; });
  const skip = page.getByRole("button", { name: /skip for now/i });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole("button", { name: /Dashboard/ }).click();
  await page.waitForTimeout(300);
  if (baseline) {
    for (const label of ["My Account", "View and Pay My Bill", "Message My Lab", "Stats"]) {
      await page.getByRole("button", { name: new RegExp(label) }).click();
      assert.equal((await page.locator("main").innerText()).trim(), "");
    }
    const blocked = await page.getByRole("button", { name: "Settings", exact: true })
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) !== element &&
          !element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await page.getByText("No new alerts").waitFor();
    console.log(JSON.stringify({ reproduced: "empty main after real navigation clicks",
      pointerIntercepted: blocked, requests, errors }, null, 2));
    assert.equal(blocked, false);
    return;
  }
  await page.getByText("No active practice yet").waitFor();
  for (const label of ["Dashboard", "My Account", "View and Pay My Bill", "Message My Lab", "Stats"]) {
    await page.getByRole("button", { name: new RegExp(label) }).click();
    assert.ok((await page.locator("main").innerText()).trim().length > 0);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Notification Settings").waitFor();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByText("No new alerts").waitFor();
  await page.getByRole("button", { name: "Close notifications" }).click();
  failOrganizations = true;
  await page.reload();
  await page.getByRole("button", { name: /Dashboard/ }).click();
  await page.getByText("Practice service unavailable", { exact: false }).first().waitFor();
  failOrganizations = false;
  organizations = [{ id: "fixture-practice", name: "Fixture practice", role: "owner" }];
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("You have no assigned cases yet.").waitFor()
    .catch(async (error) => { console.log({ main: await page.locator("main").innerText(), requests, errors }); throw error; });
  assert.ok(requests.filter((r) => r.path === "/cases/provider").every((r) => r.practice === "fixture-practice"));
  assert.ok(requests.some((r) => r.path === "/cases/provider"));
  cases = [{ id: "fixture-case", caseNumber: "Portal fixture case", patientName: "Fixture Patient",
    status: "in_progress", dueDate: null, labOrganizationId: "fixture-lab", labName: "Fixture lab",
    createdAt: "2026-10-07T12:00:00Z" }];
  await page.reload();
  await page.getByText("Portal fixture case", { exact: true }).waitFor();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.ok(await page.getByText("Notification Settings").isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: /sign in/i }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log("Provider persisted startup, navigation, request recovery, tenant scope and narrow layouts passed.");
} finally {
  await browser.close();
}
}
await run();
