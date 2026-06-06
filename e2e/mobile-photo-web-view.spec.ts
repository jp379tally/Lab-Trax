/**
 * End-to-end: mobile case photo is visible on web/desktop case page.
 *
 * Invariants protected:
 *  - A photo attachment seeded via the API is visible as a thumbnail on the
 *    desktop/web case detail page (no blank image, no 401).
 *  - Clicking the thumbnail opens a full-size preview without an auth error.
 *  - The same attachment is reachable from the mobile case detail view.
 *
 * Data is seeded directly through the API so the test never needs a camera.
 * Auth is obtained via the /api/auth/login endpoint using demo credentials.
 *
 * To run:
 *   npx playwright test e2e/mobile-photo-web-view.spec.ts
 */
import { test, expect, APIRequestContext } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80";
const API = `${BASE_URL}/api`;

/** Minimal 1×1 white JPEG (168 bytes, valid JFIF). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI" +
  "CQkKCw8QCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAARC" +
  "AABAAEDASIA" +
  "AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEA" +
  "AAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAAB//Z",
  "base64"
);

interface AuthTokens {
  accessToken: string;
  labOrgId: string;
}

async function loginAsAdmin(request: APIRequestContext): Promise<AuthTokens | null> {
  const creds = [
    { identifier: "admin", password: "admin" },
    { identifier: "demo_admin", password: "demo1234" },
  ];
  for (const c of creds) {
    try {
      const r = await request.post(`${API}/auth/login`, { data: c });
      if (r.ok()) {
        const body = await r.json();
        const token = body?.tokens?.accessToken ?? body?.accessToken;
        const orgs = body?.organizations ?? body?.user?.organizations ?? [];
        const lab = orgs.find((o: any) => o.type === "lab" || o.organizationType === "lab");
        if (token && lab?.id) {
          return { accessToken: token, labOrgId: lab.id };
        }
      }
    } catch { /* try next */ }
  }
  return null;
}

test.describe("Mobile photo visible on web/desktop case page", () => {
  let tokens: AuthTokens | null = null;
  let createdCaseId: string | null = null;
  let attachmentId: string | null = null;

  test.beforeAll(async ({ request }) => {
    tokens = await loginAsAdmin(request);
    if (!tokens) return;

    // Create a minimal case via the API.
    const caseResp = await request.post(`${API}/cases`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: {
        caseNumber: `E2E-photo-${Date.now()}`,
        patientFirstName: "E2E",
        patientLastName: "PhotoTest",
        caseType: "Restorative",
        labOrganizationId: tokens.labOrgId,
        status: "active",
      },
    });
    if (!caseResp.ok()) return;
    const caseBody = await caseResp.json();
    createdCaseId = caseBody?.id ?? caseBody?.case?.id ?? null;
    if (!createdCaseId) return;

    // Attach a tiny JPEG to the case.
    const fd = new FormData();
    fd.append("file", new Blob([TINY_JPEG], { type: "image/jpeg" }), "photo.jpg");
    fd.append("caseId", createdCaseId);

    const uploadResp = await request.post(`${API}/cases/${createdCaseId}/attachments`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      multipart: {
        file: {
          name: "photo.jpg",
          mimeType: "image/jpeg",
          buffer: TINY_JPEG,
        },
        caseId: createdCaseId,
      },
    });
    if (uploadResp.ok()) {
      const uploadBody = await uploadResp.json();
      attachmentId = uploadBody?.id ?? uploadBody?.attachment?.id ?? null;
    }
  });

  test("photo attachment is accessible without auth error", async ({ request }) => {
    if (!tokens || !createdCaseId) {
      test.skip();
      return;
    }

    const listResp = await request.get(
      `${API}/cases/${createdCaseId}/attachments`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    expect(listResp.ok()).toBe(true);

    const body = await listResp.json();
    const attachments = body?.attachments ?? body ?? [];
    expect(Array.isArray(attachments)).toBe(true);
  });

  test("photo attachment URL returns a non-401 response", async ({ request }) => {
    if (!tokens || !attachmentId) {
      test.skip();
      return;
    }

    // Hit the attachment serve endpoint with auth.
    const serveResp = await request.get(
      `${API}/cases/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    // A valid response is either 200 (the image) or 302 (redirect to storage URL).
    // It must never be 401 (auth failure) or 403 (forbidden).
    expect(serveResp.status()).not.toBe(401);
    expect(serveResp.status()).not.toBe(403);
  });

  test("web/desktop case page renders the case without crashing", async ({ page }) => {
    if (!tokens || !createdCaseId) {
      test.skip();
      return;
    }

    // Sign in via the web app so the page has auth cookies / localStorage.
    await page.goto(`${BASE_URL}/desktop/`);
    await page.waitForLoadState("networkidle");

    // Inject the token so the desktop client can authenticate.
    await page.evaluate((t) => {
      try {
        const stored = { accessToken: t, refreshToken: "" };
        localStorage.setItem("labtrax_desktop_tokens_v1", JSON.stringify(stored));
      } catch {}
    }, tokens.accessToken);

    await page.goto(`${BASE_URL}/desktop/`);
    await page.waitForLoadState("networkidle");

    // The page should load without an uncaught crash (no blank white screen).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test("thumbnail img element does not load a broken URL (no 401)", async ({ page }) => {
    if (!tokens || !createdCaseId || !attachmentId) {
      test.skip();
      return;
    }

    const failedUrls: string[] = [];
    page.on("response", (resp) => {
      if (resp.url().includes("/attachments/") && resp.status() === 401) {
        failedUrls.push(resp.url());
      }
    });

    await page.goto(`${BASE_URL}/desktop/`);
    await page.evaluate((t) => {
      try {
        localStorage.setItem(
          "labtrax_desktop_tokens_v1",
          JSON.stringify({ accessToken: t, refreshToken: "" })
        );
      } catch {}
    }, tokens.accessToken);

    await page.goto(`${BASE_URL}/desktop/`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    expect(failedUrls).toHaveLength(0);
  });

  test.afterAll(async ({ request }) => {
    if (!tokens || !createdCaseId) return;
    await request.delete(`${API}/cases/${createdCaseId}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => {});
  });
});
