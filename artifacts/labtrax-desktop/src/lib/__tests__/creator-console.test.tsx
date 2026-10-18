/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api";
import { CreatorGate, PinSetup, watchCreatorExpiry } from "@/lib/creator";
import { SubscriptionsPanel } from "@/pages/settings-subscriptions";
import { NAV, SECONDARY } from "@/components/AppLayout";
import { makeAuthWrapper, makeQueryClient } from "../../__tests__/test-utils";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mocked = vi.mocked(apiFetch);
type Access = { isCreator: boolean; pinConfigured: boolean; unlocked: boolean; expiresAt: string | null };
let access: Access;
let unlockImpl: () => Promise<unknown>;

function route(path: string, _init?: RequestInit): Promise<unknown> {
  if (path === "/creator/access") return Promise.resolve(access);
  if (path === "/creator/unlock") return unlockImpl();
  if (path === "/creator/pin") return Promise.resolve({ ok: true });
  if (path.startsWith("/admin/provider-subscriptions")) return Promise.resolve({ ok: true, items: [], total: 0, limit: 100, offset: 0, plans: [] });
  return Promise.resolve({});
}
const calls = (p: string) => mocked.mock.calls.filter((c) => c[0] === p);
const Wrap = () => makeAuthWrapper("/", { user: { id: "u1" } as never });

beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(route as never);
  access = { isCreator: true, pinConfigured: true, unlocked: false, expiresAt: null };
  unlockImpl = () => Promise.resolve({ ok: true });
});
afterEach(cleanup);

describe("Creator gate", () => {
  it("hides content from non-creators", async () => {
    access = { ...access, isCreator: false };
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    await waitFor(() => expect(calls("/creator/access").length).toBe(1));
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.queryByTestId("input-creator-pin")).toBeNull();
  });

  it("unprovisioned PIN shows secure setup message and no setup form", async () => {
    access = { ...access, pinConfigured: false };
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    expect(await screen.findByTestId("creator-pin-unprovisioned")).toBeTruthy();
    expect(screen.queryByTestId("input-pin-newPin")).toBeNull();
    expect(screen.queryByTestId("input-creator-pin")).toBeNull();
  });

  it("pasted PIN verifies exactly once and unlocks", async () => {
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    const input = await screen.findByTestId("input-creator-pin");
    unlockImpl = () => { access = { ...access, unlocked: true }; return Promise.resolve({ ok: true }); };
    fireEvent.change(input, { target: { value: "123 4567" } });
    expect(await screen.findByText("secret")).toBeTruthy();
    expect(calls("/creator/unlock")).toHaveLength(1);
    expect(JSON.parse((calls("/creator/unlock")[0][1] as RequestInit).body as string)).toEqual({ pin: "1234567" });
  });

  it("failed attempt fires once, shows error, no retry loop; rate limit is clear", async () => {
    unlockImpl = () => Promise.reject(new ApiError("Incorrect PIN", 401));
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    const input = await screen.findByTestId("input-creator-pin");
    fireEvent.change(input, { target: { value: "1111111" } });
    expect((await screen.findByTestId("text-creator-pin-error")).textContent).toContain("Incorrect PIN");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls("/creator/unlock")).toHaveLength(1);
    const limited = new ApiError("limited", 429); limited.retryAfter = 120;
    unlockImpl = () => Promise.reject(limited);
    fireEvent.change(input, { target: { value: "111111" } });
    fireEvent.change(input, { target: { value: "2222222" } });
    await waitFor(() => expect(screen.getByTestId("text-creator-pin-error").textContent).toContain("Too many attempts"));
    expect(screen.getByTestId("text-creator-pin-error").textContent).toContain("2 min");
    expect(calls("/creator/unlock")).toHaveLength(2);
  });
});

describe("Subscriptions deep link", () => {
  it("SubscriptionsPanel never loads the directory while locked", async () => {
    const W = Wrap();
    render(<W><SubscriptionsPanel /></W>);
    expect(await screen.findByTestId("creator-gate")).toBeTruthy();
    expect(calls("/admin/provider-subscriptions")).toHaveLength(0);
    expect(mocked.mock.calls.some((c) => String(c[0]).startsWith("/admin/provider-subscriptions"))).toBe(false);
  });
  it("renders directory with summary once unlocked", async () => {
    access = { ...access, unlocked: true };
    const W = Wrap();
    render(<W><SubscriptionsPanel /></W>);
    await waitFor(() => expect(mocked.mock.calls.some((c) => String(c[0]).startsWith("/admin/provider-subscriptions"))).toBe(true));
  });
});

describe("PIN rotation", () => {
  it("sends current/new/confirm and re-reads capability", async () => {
    const W = Wrap();
    render(<W><PinSetup /></W>);
    fireEvent.change(screen.getByTestId("input-pin-currentPin"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByTestId("input-pin-newPin"), { target: { value: "7654321" } });
    fireEvent.change(screen.getByTestId("input-pin-confirmPin"), { target: { value: "7654321" } });
    fireEvent.click(screen.getByText("Save PIN"));
    await waitFor(() => expect(calls("/creator/pin")).toHaveLength(1));
    expect(JSON.parse((calls("/creator/pin")[0][1] as RequestInit).body as string)).toEqual({ currentPin: "1234567", newPin: "7654321", confirmPin: "7654321" });
  });
  it("mismatched confirm keeps Save disabled", () => {
    const W = Wrap();
    render(<W><PinSetup /></W>);
    fireEvent.change(screen.getByTestId("input-pin-currentPin"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByTestId("input-pin-newPin"), { target: { value: "7654321" } });
    fireEvent.change(screen.getByTestId("input-pin-confirmPin"), { target: { value: "7654322" } });
    expect((screen.getByText("Save PIN") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Unlock expiry", () => {
  it("a 403 on a creator query re-reads capability immediately", async () => {
    const qc: QueryClient = makeQueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const off = watchCreatorExpiry(qc);
    await qc.fetchQuery({ queryKey: ["creator", "revenue"], queryFn: () => Promise.reject(new ApiError("locked", 403)) }).catch(() => {});
    expect(spy).toHaveBeenCalledWith({ queryKey: ["creator", "access"] });
    off();
  });
  it("ignores non-creator 403s", async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const off = watchCreatorExpiry(qc);
    await qc.fetchQuery({ queryKey: ["cases"], queryFn: () => Promise.reject(new ApiError("no", 403)) }).catch(() => {});
    expect(spy).not.toHaveBeenCalled();
    off();
  });
});

describe("Navigation", () => {
  it("has a Creator group, no Owner group, and owner capabilities live inside it", () => {
    const groups = [...NAV, ...SECONDARY].filter((n): n is Extract<typeof n, { children: unknown[] }> => "children" in n);
    expect(groups.find((g) => g.label === "Owner")).toBeUndefined();
    const creator = groups.find((g) => g.label === "Creator")!;
    expect(creator.creatorOnly).toBe(true);
    const labels = creator.children.map((c) => c.label);
    for (const l of ["Revenue", "Feedback inbox", "Subscriptions", "Lab Profile", "Team & Roles", "Danger Zone"]) expect(labels).toContain(l);
  });
});

describe("PIN masking, immediate unlock and idle expiry", () => {
  it("PIN field is a masked password input without one-time-code autofill", async () => {
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    const input = (await screen.findByTestId("input-creator-pin")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).not.toBe("one-time-code");
  });

  it("re-locks visibly when the unlock deadline passes while idle", async () => {
    access = { ...access, unlocked: true, expiresAt: new Date(Date.now() + 400).toISOString() };
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    expect(await screen.findByText("secret")).toBeTruthy();
    // Server now reports locked on the refetch triggered by the timer.
    setTimeout(() => { access = { ...access, unlocked: false, expiresAt: null }; }, 300);
    await waitFor(() => expect(screen.queryByText("secret")).toBeNull(), { timeout: 3000 });
    expect(await screen.findByTestId("input-creator-pin")).toBeTruthy();
  });

  it("re-locks at the deadline even if the refetch still says unlocked", async () => {
    access = { ...access, unlocked: true, expiresAt: new Date(Date.now() + 300).toISOString() };
    const W = Wrap();
    render(<W><CreatorGate><div>secret</div></CreatorGate></W>);
    expect(await screen.findByText("secret")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("secret")).toBeNull(), { timeout: 3000 });
  });
});

describe("minor unit formatting", () => {
  it("uses currency-specific digits", async () => {
    const { formatMinor, minorToMajor } = await import("@/lib/creator");
    expect(minorToMajor(1234, "JPY")).toBe(1234);
    expect(minorToMajor(1234, "USD")).toBe(12.34);
    expect(minorToMajor(1234, "KWD")).toBe(1.234);
    expect(formatMinor(1234, "JPY")).toBe("¥1,234");
    expect(formatMinor(1234, "KWD")).toContain("1.234");
  });
});
