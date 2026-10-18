// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/lib/auth-context";
import { MOCK_AUTH_DEFAULTS } from "./test-utils";
import { AppLayout } from "@/components/AppLayout";
import { ProfilePhotoControl } from "@/components/ProfilePhotoControl";
import type { SessionUser } from "@/lib/api";

const fetchMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: fetchMock,
  apiUploadWithProgress: uploadMock,
  apiFetchArrayBuffer: vi.fn(),
  serverAssetUrl: (path: string) => new URL(path, "https://api.example.test/").href,
}));
vi.mock("@/lib/uploads-context", () => ({
  useUploads: () => ({ entries: [], activeCount: 0, removeEntry: vi.fn(), cancelEntry: vi.fn() }),
}));
vi.mock("@/components/AiChatPanel", () => ({ AiChatPanel: () => null }));
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("@/components/ReportIssueDialog", () => ({
  canReportIssueRole: () => false,
  ReportIssueAction: () => null,
  FeedbackAction: () => null,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetDoctorDuplicateClusters: () => ({ data: null }),
  getGetDoctorDuplicateClustersQueryKey: () => ["clusters"],
}));
vi.mock("@/lib/local-backup-scheduler", () => ({ startLocalBackupScheduler: vi.fn() }));

const alice: SessionUser = {
  id: "alice", username: "alice", firstName: "Alice", lastName: "Smith",
  profilePhotoUrl: "/uploads/profile-photos/alice.png", role: "user",
};
const bob: SessionUser = {
  id: "bob", username: "bob", firstName: "Bob", lastName: "Jones",
  profilePhotoUrl: null, role: "user",
};

// Radix preloads images using window.Image before it renders its img element.
class TestImage extends EventTarget {
  static fail = false;
  complete = true;
  naturalWidth = 100;
  private value = "";
  get src() { return this.value; }
  set src(value: string) {
    this.value = value;
    this.naturalWidth = TestImage.fail ? 0 : 100;
    queueMicrotask(() => this.dispatchEvent(new Event(TestImage.fail ? "error" : "load")));
  }
}

const originalImage = window.Image;
beforeEach(() => {
  vi.stubGlobal("Image", TestImage);
  TestImage.fail = false;
  fetchMock.mockReset();
  uploadMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return { user: alice, memberships: [] };
    if (path === "/notifications") return [];
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.stubGlobal("Image", originalImage);
});

function mount(user: SessionUser = alice, showControl = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const { hook } = memoryLocation({ path: "/" });
  const view = (current: SessionUser) => (
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <AuthContext.Provider value={{ ...MOCK_AUTH_DEFAULTS, user: current, status: "authed" }}>
           <AppLayout>{showControl ? <ProfilePhotoControl /> : <div>Content</div>}</AppLayout>
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>
  );
  const result = render(view(user));
  return { ...result, switchUser: (current: SessionUser) => result.rerender(view(current)), queryClient };
}

describe("desktop header profile avatar", () => {
  it("uploads and replaces a personal photo for an ordinary member and updates the header immediately", async () => {
    let saved = { ...bob };
    fetchMock.mockImplementation(async (path: string) => path === "/auth/me" ? { user: saved, memberships: [] } : []);
    uploadMock.mockImplementation(async () => {
      saved = { ...saved, profilePhotoUrl: `/uploads/profile-photos/${uploadMock.mock.calls.length}.jpg` };
      return { profilePhotoUrl: saved.profilePhotoUrl };
    });
    mount(bob, true);
    await screen.findByText("Add photo");
    const picker = screen.getByLabelText("Choose profile photo");
    fireEvent.change(picker, { target: { files: [new File(["one"], "one.png", { type: "image/png" })] } });
    await screen.findByText("Change photo");
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar").getAttribute("src"))
      .toBe("https://api.example.test/uploads/profile-photos/1.jpg"));
    expect(uploadMock.mock.calls[0][0]).toBe("/auth/users/bob/profile-photo");
    expect(uploadMock.mock.calls[0][1].get("photo").name).toBe("one.png");
    fireEvent.change(picker, { target: { files: [new File(["two"], "two.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar").getAttribute("src"))
      .toBe("https://api.example.test/uploads/profile-photos/2.jpg"));
  });

  it("keeps the confirmed picture on cancellation, invalid files, oversize files and upload failure", async () => {
    mount(alice, true);
    await screen.findByText("Change photo");
    const picker = screen.getByLabelText("Choose profile photo");
    fireEvent.change(picker, { target: { files: [] } });
    expect(uploadMock).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] } });
    expect(screen.getByRole("alert").textContent).toContain("Choose a JPEG");
    const large = new File(["large"], "large.jpg", { type: "image/jpeg" });
    Object.defineProperty(large, "size", { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(picker, { target: { files: [large] } });
    expect(screen.getByRole("alert").textContent).toContain("5 MB");
    expect(uploadMock).not.toHaveBeenCalled();
    uploadMock.mockRejectedValueOnce(new Error("Cannot read image"));
    fireEvent.change(picker, { target: { files: [new File(["bad"], "bad.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Cannot read image"));
    expect(screen.getByText("Change photo").closest("button")?.disabled).toBe(false);
    expect(screen.getByTestId("img-profile-avatar").getAttribute("src")).toContain("alice.png");
  });

  it("blocks duplicate submissions and ignores an old account's delayed upload", async () => {
    const mounted = mount(alice, true);
    await screen.findByText("Change photo");
    let finish!: (value: unknown) => void;
    uploadMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const picker = screen.getByLabelText("Choose profile photo");
    const files = [new File(["photo"], "photo.jpg", { type: "image/jpeg" })];
    fireEvent.change(picker, { target: { files } });
    fireEvent.change(picker, { target: { files } });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async (path: string) => path === "/auth/me" ? { user: bob, memberships: [] } : []);
    mounted.switchUser(bob);
    await act(async () => { finish({ profilePhotoUrl: "/uploads/profile-photos/late-alice.jpg" }); });
    await waitFor(() => expect(screen.getByText("Add photo")).not.toBeNull());
    expect(screen.queryByTestId("img-profile-avatar")).toBeNull();
  });

  it("uses the matching latest profile photo, then clears it when the server clears the photo", async () => {
    const mounted = mount();
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar").getAttribute("src"))
      .toBe("https://api.example.test/uploads/profile-photos/alice.png"));
    fetchMock.mockImplementation(async (path: string) =>
      path === "/auth/me" ? { user: { ...alice, profilePhotoUrl: null }, memberships: [] } : []);
    await act(async () => { await mounted.queryClient.refetchQueries({ queryKey: ["auth", "me", "alice"] }); });
    await waitFor(() => expect(screen.queryByTestId("img-profile-avatar")).toBeNull());
    expect(screen.getByTestId("text-profile-initials").textContent).toBe("AS");
  });

  it("shows initials when there is no photo or when the image fails to load", async () => {
    const missing = mount(bob);
    expect(screen.getByTestId("text-profile-initials").textContent).toBe("BJ");
    missing.unmount();
    TestImage.fail = true;
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth/me"));
    expect(screen.queryByTestId("img-profile-avatar")).toBeNull();
    expect(screen.getByTestId("text-profile-initials").textContent).toBe("AS");
  });

  it("refreshes the profile on window focus even while the query is fresh", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar")).not.toBeNull());
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (path: string) =>
      path === "/auth/me"
        ? { user: { ...alice, profilePhotoUrl: "/uploads/profile-photos/new.png" }, memberships: [] }
        : []);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar").getAttribute("src"))
      .toBe("https://api.example.test/uploads/profile-photos/new.png"));
    expect(fetchMock).toHaveBeenCalledWith("/auth/me");
  });

  it("never shows the old user's image while a new account's profile is loading", async () => {
    const mounted = mount();
    await waitFor(() => expect(screen.getByTestId("img-profile-avatar")).not.toBeNull());
    let resolveBob!: (value: unknown) => void;
    fetchMock.mockImplementation(async (path: string) =>
      path === "/auth/me" ? new Promise((resolve) => { resolveBob = resolve; }) : []);
    mounted.switchUser(bob);
    expect(screen.queryByTestId("img-profile-avatar")).toBeNull();
    expect(screen.getByTestId("text-profile-initials").textContent).toBe("BJ");
    await act(async () => { resolveBob({ user: bob, memberships: [] }); });
    expect(screen.queryByTestId("img-profile-avatar")).toBeNull();
  });
});
describe("desktop header role label", () => {
  // The session role collapses every membership other than owner/admin to
  // "user", so the header reads the raw membership role and names it as Team
  // settings does.
  it.each([
    ["owner", "admin", "Owner"],
    ["admin", "admin", "Admin"],
    ["billing", "user", "Billing"],
    ["user", "user", "User"],
    ["read_only", "user", "Read Only"],
  ])("shows a %s member as their Team settings role", async (membershipRole, role, label) => {
    mount({ ...bob, role, membershipRole, practiceName: "Bright Lab" });
    expect(await screen.findByText(`${label} · Bright Lab`)).toBeInTheDocument();
    expect(screen.queryByText(/^Member/)).toBeNull();
  });

  it("falls back to the session role without an active membership", async () => {
    mount({ ...bob, role: "admin", membershipRole: null, practiceName: null });
    expect(await screen.findByText("Admin")).toBeInTheDocument();
  });
});
