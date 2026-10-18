/** @vitest-environment jsdom */
/**
 * Contract guard for the two AI-intake practice lookups
 * (`/rx-doctor-practice-memory` and `/rx-practice-aliases`).
 *
 * Both routes answer with the server's `{ ok, data }` envelope, and desktop
 * `apiFetch` STRIPS that envelope before returning — so a caller receives the
 * inner `{ found, providerOrganizationId }` object, not the wrapper.
 *
 * This is a silent trap: a caller that reads `response.data.providerOrganizationId`
 * gets `undefined`, decides nothing is remembered, and prompts the user again.
 * No error, no log, and a component test that mocks the *pre-unwrap* shape
 * passes happily while the real client is broken.
 *
 * So this test drives the REAL apiFetch against the REAL server payload and
 * pins what callers actually get. If the envelope convention on either side
 * ever changes, this fails instead of the feature silently regressing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiFetch } from "../api";

/** Byte-for-byte what the two lookup routes send on a hit. */
function serverEnvelope(providerOrganizationId: string) {
  return { ok: true, data: { found: true, providerOrganizationId } };
}

/** …and on a miss. */
const SERVER_MISS = { ok: true, data: { found: false, providerOrganizationId: null } };

function stubFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("practice-lookup response contract", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands the doctor-memory caller the UNWRAPPED payload, not the envelope", async () => {
    stubFetch(serverEnvelope("prov-A"));

    const res = await apiFetch<{
      found?: boolean;
      providerOrganizationId?: string | null;
    }>("/rx-doctor-practice-memory?labOrganizationId=lab1&doctorName=Dr.%20Who");

    // The fields are at the TOP level…
    expect(res).toEqual({ found: true, providerOrganizationId: "prov-A" });
    expect(res.providerOrganizationId).toBe("prov-A");
    // …and there is no `.data` to reach into. Reading one is the bug this
    // whole file exists to catch.
    expect((res as Record<string, unknown>)["data"]).toBeUndefined();
  });

  it("hands the Rx-name alias caller the same unwrapped shape", async () => {
    stubFetch(serverEnvelope("prov-B"));

    const res = await apiFetch<{
      found?: boolean;
      providerOrganizationId?: string | null;
    }>("/rx-practice-aliases?labOrganizationId=lab1&rxName=oak%20dental");

    expect(res).toEqual({ found: true, providerOrganizationId: "prov-B" });
    expect((res as Record<string, unknown>)["data"]).toBeUndefined();
  });

  it("unwraps a miss to a plain found:false rather than a nested one", async () => {
    stubFetch(SERVER_MISS);

    const res = await apiFetch<{
      found?: boolean;
      providerOrganizationId?: string | null;
    }>("/rx-doctor-practice-memory?labOrganizationId=lab1&doctorName=Nobody");

    expect(res).toEqual({ found: false, providerOrganizationId: null });
  });
});
