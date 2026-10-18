import { expect, test, type Page } from "@playwright/test";

type Surface = "desktop" | "expo";
type Viewport = { width: number; height: number };

const labs = Array.from({ length: 25 }, (_, index) => ({
  id: `geometry-renewed-${index + 1}`,
  selectionKey: `geometry-stable-${index + 1}`,
  displayName:
    index === 0
      ? "SDR1"
      : index === 1
        ? "Lab Two"
        : `Sample Lab ${index + 1}`,
  practiceName:
    index === 0
      ? "SDR1"
      : index === 1
        ? "Lab Two"
        : `Sample Lab ${index + 1}`,
  city: "Denver",
  state: "CO",
}));

async function installSafeSignupRoutes(page: Page) {
  let unexpectedApiPosts = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes("/api/")) {
      let body: Record<string, unknown> = {
        ok: true,
        available: true,
        data: { available: true },
        matches: [],
        labs: [],
        plans: [],
        groups: [],
        users: [],
      };
      if (url.pathname.endsWith("/auth/register")) {
        unexpectedApiPosts += 1;
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Registration blocked in geometry test." }),
        });
        return;
      }
      if (url.pathname.endsWith("/labs/lookup")) {
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        body = {
          labs: labs.filter((lab) =>
            lab.displayName.toLowerCase().includes(query),
          ),
        };
      } else if (url.pathname.endsWith("/send-email-code")) {
        body = { success: true, demoCode: "123456" };
      } else if (url.pathname.endsWith("/verify-email-code")) {
        body = { success: true, verified: true };
      } else if (url.pathname.endsWith("/billing/plans")) {
        body = { ok: true, plans: [] };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    if (request.method() === "POST") {
      await route.abort();
      return;
    }
    await route.continue();
  });
  return () => unexpectedApiPosts;
}

async function reachDesktopPartnership(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByRole("button", { name: "Get Started →" }).click();
  await page.locator('input[autocomplete="username"]').fill("geomdesk1");
  await page.locator('input[autocomplete="email"]').fill("geomdesk1@example.test");
  const passwords = page.locator('input[autocomplete="new-password"]');
  await passwords.nth(0).fill("TestPass9!");
  await passwords.nth(1).fill("TestPass9!");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Dental provider/ }).click();
  await page.getByRole("button", { name: /Create a new practice/ }).click();
  await page.getByRole("textbox").fill("DDS7654");
  await page.getByRole("button", { name: "Continue" }).click();
  const practice = page.getByRole("textbox");
  const values = [
    "Geometry Dental",
    "Dr Geometry",
    "100 Viewport Way",
    "Denver",
    "CO",
    "80204",
    "3035550107",
  ];
  for (let i = 0; i < values.length; i += 1) {
    await practice.nth(i).fill(values[i]);
  }
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox").nth(0).fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("button", { name: "No thanks" }).click();
  await page.getByRole("button", { name: /User Standard/ }).click();
  await page.getByTestId("partnership-action-bar").waitFor();
}

async function reachExpoPartnership(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId("switch-mode-btn").click();
  await page.getByText("Get Started →").click();
  await page.getByTestId("signup-username").fill("geomexpo1");
  await page.getByTestId("signup-email").fill("geomexpo1@example.test");
  await page.getByTestId("signup-password").fill("TestPass9!");
  await page.getByTestId("signup-confirm-password").fill("TestPass9!");
  await page.getByTestId("signup-next-btn").click();
  await page.getByTestId("user-type-provider").click();
  await page.getByTestId("provider-intent-create").click();
  await page.getByTestId("license-number").fill("DDS9988");
  await page.getByTestId("license-next-btn").click();
  const fields: Array<[string, string]> = [
    ["practice-name", "Geometry Expo Dental"],
    ["doctor-name", "Dr Geometry Expo"],
    ["street-address", "200 Viewport Ave"],
    ["city", "Denver"],
    ["state", "CO"],
    ["zip-code", "80205"],
    ["practice-phone", "3035550106"],
  ];
  for (const [id, value] of fields) await page.getByTestId(id).fill(value);
  await page.getByTestId("practice-info-next-btn").click();
  for (let i = 0; i < 6; i += 1) {
    await page.getByTestId(`email-code-${i}`).fill(String(i + 1));
  }
  await page.getByText("Verify", { exact: true }).click();
  await page.getByText("No thanks", { exact: true }).click();
  await page.getByTestId("role-user").click();
  await page.getByTestId("partnership-action-bar").waitFor();
}

async function waitForPartnershipViewport(page: Page, surface: Surface) {
  await page.waitForFunction(
    (kind) => {
      const visualHeight = window.visualViewport?.height;
      const bar = document.querySelector(
        '[data-testid="partnership-action-bar"]',
      );
      const root =
        kind === "expo"
          ? document.querySelector(
              '[data-testid="signup-screen-keyboard-dismiss"]',
            )
          : bar?.parentElement?.parentElement;
      return (
        visualHeight !== undefined &&
        !!root &&
        Math.abs(root.getBoundingClientRect().height - visualHeight) <= 1
      );
    },
    surface,
    { polling: 50, timeout: 8000 },
  );
}

async function scrollAndMeasure(page: Page, surface: Surface) {
  const search =
    surface === "expo"
      ? page.getByTestId("partner-lab-search")
      : page.locator('input[placeholder="Search labs…"]');
  await search.fill("Lab");
  const finalLab = page.getByRole("checkbox", {
    name: "Sample Lab 25",
    exact: true,
  });
  await expect(finalLab).toBeVisible();
  const scrolls = await finalLab.evaluate((row) => {
    const containers: HTMLElement[] = [];
    let node = row.parentElement;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 1) containers.push(node);
      node = node.parentElement;
    }
    const moved = containers.map((container) => {
      container.scrollTop = container.scrollHeight;
      return {
        className: String(container.className),
        scrollTop: container.scrollTop,
        maxScrollTop: container.scrollHeight - container.clientHeight,
      };
    });
    row.scrollIntoView({ block: "end", inline: "nearest" });
    window.scrollTo(0, document.documentElement.scrollHeight);
    return moved;
  });
  // Attempt a real page-level scroll after the result/signup containers.
  await page.mouse.move(12, 12);
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(100);
  const bounds = await page.evaluate((kind) => {
    const bar = document.querySelector(
      '[data-testid="partnership-action-bar"]',
    );
    const barRect = bar!.getBoundingClientRect();
    const last = Array.from(document.querySelectorAll('[role="checkbox"]')).find(
      (element) => element.textContent?.includes("Sample Lab 25"),
    )!;
    const rowRect = last.getBoundingClientRect();
    const root =
      kind === "expo"
        ? document.querySelector('[data-testid="signup-screen-keyboard-dismiss"]')
        : bar!.parentElement!.parentElement!;
    return {
      viewportHeight: window.visualViewport?.height ?? 0,
      wrapperHeight: root?.getBoundingClientRect().height ?? 0,
      footerTop: barRect.top,
      footerBottom: barRect.bottom,
      rowTop: rowRect.top,
      rowBottom: rowRect.bottom,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
    };
  }, surface);
  return { surface, bounds, scrolls };
}

async function verifyViewport(
  page: Page,
  surface: Surface,
  viewport: Viewport,
) {
  await page.setViewportSize(viewport);
  await waitForPartnershipViewport(page, surface);
  // Filling the search focuses it for the short Expo viewport and refreshes
  // all 24 Lab-matching rows from the deterministic 25-lab fixture.
  const result = await scrollAndMeasure(page, surface);
  expect(result.bounds.wrapperHeight).toBeCloseTo(
    result.bounds.viewportHeight,
    0,
  );
  expect(result.bounds.footerBottom).toBeLessThanOrEqual(
    result.bounds.viewportHeight + 1,
  );
  expect(result.bounds.rowBottom).toBeLessThanOrEqual(
    result.bounds.footerTop + 1,
  );
  await expect(
    page.getByRole("button", { name: "Submit partnership request" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
  return result;
}

function desktopBaseUrl() {
  return (process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80").replace(
    /\/$/,
    "",
  );
}

function expoBaseUrl() {
  const configured =
    process.env["EXPO_BASE_URL"] ??
    process.env["PLAYWRIGHT_EXPO_BASE_URL"] ??
    (process.env["REPLIT_EXPO_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_EXPO_DEV_DOMAIN"]}`
      : "http://localhost:8081");
  return configured.replace(/\/$/, "");
}

test.describe("route-stubbed signup partnership viewport geometry", () => {
  test("desktop: 1000x500 then 390x650", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1000, height: 500 });
    const registerCount = await installSafeSignupRoutes(page);
    await reachDesktopPartnership(page, `${desktopBaseUrl()}/desktop/`);
    const regular = await verifyViewport(page, "desktop", {
      width: 1000,
      height: 500,
    });
    const narrow = await verifyViewport(page, "desktop", {
      width: 390,
      height: 650,
    });
    expect(registerCount()).toBe(0);
    console.log({ regular, narrow });
  });

  test("Expo web: 390x650 then 390x360", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 650 });
    const registerCount = await installSafeSignupRoutes(page);
    await reachExpoPartnership(page, expoBaseUrl());
    const regular = await verifyViewport(page, "expo", {
      width: 390,
      height: 650,
    });
    const short = await verifyViewport(page, "expo", {
      width: 390,
      height: 360,
    });
    expect(registerCount()).toBe(0);
    console.log({ regular, short });
  });
});
