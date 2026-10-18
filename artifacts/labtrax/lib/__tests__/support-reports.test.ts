import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUPPORT_REPORT_MAX_FILE_SIZE,
  submitSupportReport,
  validateSupportReportAttachment,
  type SupportReportAttachment,
} from "@/lib/support-reports";

const auth = vi.hoisted(() => ({
  token: "mobile-token",
  csrf: null as string | null,
  loadTokens: vi.fn(async () => undefined),
  refresh: vi.fn(async () => "refreshed-token"),
}));

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "https://labtrax.test/",
  getAccessToken: () => auth.token,
  getCsrfToken: () => auth.csrf,
  loadTokens: auth.loadTokens,
  refreshAndGetAccessToken: auth.refresh,
}));

const file = (overrides: Partial<SupportReportAttachment> = {}): SupportReportAttachment => ({
  uri: "file:///tmp/screenshot.jpg",
  name: "screenshot.jpg",
  mimeType: "image/jpeg",
  size: 1024,
  ...overrides,
});

class MockXHR {
  static responses: Array<{ status: number; body: unknown }> = [];
  static instances: MockXHR[] = [];
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  body: RecordingFormData | null = null;
  withCredentials = false;

  constructor() { MockXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: FormData) {
    this.body = body as unknown as RecordingFormData;
    const response = MockXHR.responses.shift() ?? { status: 200, body: { ok: true, copySent: true } };
    this.status = response.status;
    this.responseText = JSON.stringify(response.body);
    queueMicrotask(() => this.onload?.());
  }
}

class RecordingFormData {
  fields: Array<[string, unknown, string | undefined]> = [];
  append(name: string, value: unknown, filename?: string) {
    this.fields.push([name, value, filename]);
  }
}

describe("mobile support reports", () => {
  beforeEach(() => {
    auth.loadTokens.mockClear();
    auth.refresh.mockClear();
    auth.csrf = null;
    MockXHR.responses = [];
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    vi.stubGlobal("FormData", RecordingFormData);
  });

  it("matches the server attachment limits and supported types", async () => {
    expect(validateSupportReportAttachment([], file())).toBeNull();
    expect(validateSupportReportAttachment([], file({ mimeType: "application/zip", name: "logs.zip" }))).toContain("not a supported");
    expect(validateSupportReportAttachment([], file({ size: SUPPORT_REPORT_MAX_FILE_SIZE + 1 }))).toContain("larger than 5 MiB");
    expect(validateSupportReportAttachment(Array.from({ length: 5 }, () => file()), file())).toContain("up to 5 files");
    expect(validateSupportReportAttachment([file({ size: 6 * 1024 * 1024 })], file({ size: 5 * 1024 * 1024 }))).toContain("10 MiB");
  });

  it("hydrates auth, uses the existing lab endpoint, and sends attachment fields", async () => {
    await expect(submitSupportReport("Broken timeline", [file()], { portal: "lab" })).resolves.toEqual({ ok: true, copySent: true });
    expect(auth.loadTokens).toHaveBeenCalledOnce();
    expect(MockXHR.instances[0]?.method).toBe("POST");
    expect(MockXHR.instances[0]?.url).toBe("https://labtrax.test/api/support-reports?portal=lab");
    expect(MockXHR.instances[0]?.headers.Authorization).toBe("Bearer mobile-token");
    const fields = MockXHR.instances[0]!.body!.fields;
    expect(fields[0]).toEqual(["description", "Broken timeline", undefined]);
    expect(fields[1]?.[0]).toBe("attachments");
    if (Platform.OS !== "web") {
      expect(fields[1]?.[1]).toMatchObject({
        uri: "file:///tmp/screenshot.jpg",
        name: "screenshot.jpg",
        type: "image/jpeg",
      });
    }
  });

  it("surfaces server authorization failures and retries once after a 401", async () => {
    MockXHR.responses = [
      { status: 401, body: { error: "Unauthorized" } },
      { status: 403, body: { error: "Support reports require lab administrator access." } },
    ];
    await expect(submitSupportReport("Issue", [], { portal: "lab" })).rejects.toThrow("Support reports require lab administrator access.");
    expect(auth.refresh).toHaveBeenCalledOnce();
    expect(MockXHR.instances[1]?.headers.Authorization).toBe("Bearer refreshed-token");
  });

  it("uses the selected-organization header for provider administrators", async () => {
    await submitSupportReport("Provider issue", [], {
      portal: "provider",
      providerOrganizationId: "provider-1",
    });
    expect(MockXHR.instances[0]?.url).toBe("https://labtrax.test/api/support-reports?portal=provider");
    expect(MockXHR.instances[0]?.headers["x-provider-organization-id"]).toBe("provider-1");
  });

  it("materializes web attachments as Blobs and sends cookie and CSRF credentials", async () => {
    const platform = vi.spyOn(Platform, "OS", "get").mockReturnValue("web");
    const blob = new Blob(["image"], { type: "image/jpeg" });
    const fetchMock = vi.fn(async () => new Response(blob));
    vi.stubGlobal("fetch", fetchMock);
    auth.csrf = "csrf-token";

    await submitSupportReport("Web issue", [file({ uri: "blob:web-image" })], { portal: "lab" });

    expect(fetchMock).toHaveBeenCalledWith("blob:web-image");
    expect(MockXHR.instances[0]?.body?.fields[1]).toEqual(["attachments", blob, "screenshot.jpg"]);
    expect(MockXHR.instances[0]?.withCredentials).toBe(true);
    expect(MockXHR.instances[0]?.headers["x-csrf-token"]).toBe("csrf-token");
    platform.mockRestore();
  });
});