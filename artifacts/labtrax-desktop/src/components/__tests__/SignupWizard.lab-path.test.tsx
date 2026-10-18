/** @vitest-environment jsdom */
/**
 * Component tests for the SignupWizard lab account-category flow.
 *
 * Background: the API server has a backend unit test asserting a lab employee
 * can register with no organization/membership (account-only signup). But that
 * test only proves the server honours the payload it is given — it cannot catch
 * a regression in the *desktop wizard* that builds the wrong payload (e.g.
 * accidentally sending `practiceName` or `createOrganization: true` on the
 * "Join" path, which would silently re-create placeholder labs).
 *
 * The signup wizard now asks ONE account-category question with three intents
 * (Join an existing lab / Create a new lab / Dental provider). Invariants
 * protected here:
 *  - Choosing "Join an existing lab" sends `createOrganization: false` and omits
 *    `practiceName` / `licenseNumber` / `practiceAddress` / `practicePhone`.
 *  - Choosing "Create a new lab" sends the full lab payload
 *    (`createOrganization: true`, lab name as `practiceName`, license, address,
 *    phone).
 *  - The two intents drive different step sequences: the JOIN path is the
 *    collapsed lab-search → email-verify → finish flow (LAB_STEPS_JOIN, 6 steps,
 *    no role/plan/lab-details steps) while the CREATE path keeps the full lab
 *    onboarding (LAB_STEPS_CREATE, 9 steps) including the "Lab details" step.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SignupWizard from "../SignupWizard";
import { toast } from "@/hooks/use-toast";
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
import { makeAuthWrapper } from "../../__tests__/test-utils";

// ─── Module mock: @/lib/api ──────────────────────────────────────────────────
// All network helpers the wizard imports are stubbed so the flow runs offline.

const mockApiFetch = vi.fn();
const mockCheckUsernameAvailable = vi.fn();
const mockCheckEmailAvailable = vi.fn();
const mockLookupLabs = vi.fn();
const mockSendEmailVerificationCode = vi.fn();
const mockSendPhoneVerificationCode = vi.fn();
const mockVerifyEmailCode = vi.fn();
const mockVerifyPhoneCode = vi.fn();

vi.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(msg: string, status = 500, body: unknown = null) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError: MockApiError,
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
    checkUsernameAvailable: (...args: unknown[]) => mockCheckUsernameAvailable(...args),
    checkEmailAvailable: (...args: unknown[]) => mockCheckEmailAvailable(...args),
    lookupLabs: (...args: unknown[]) => mockLookupLabs(...args),
    lookupPractices: vi.fn().mockResolvedValue([]),
    sendEmailVerificationCode: (...args: unknown[]) => mockSendEmailVerificationCode(...args),
    sendPhoneVerificationCode: (...args: unknown[]) => mockSendPhoneVerificationCode(...args),
    verifyEmailCode: (...args: unknown[]) => mockVerifyEmailCode(...args),
    verifyPhoneCode: (...args: unknown[]) => mockVerifyPhoneCode(...args),
    isSharedTestEmail: (email: string) =>
      email.trim().toLowerCase() === "shared-test@example.com",
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find the <input> that follows a (non-associated) text label. */
function inputForLabel(label: string): HTMLInputElement {
  const el = screen.getByText(label);
  const input = el.parentElement?.querySelector("input");
  if (!input) throw new Error(`No input found for label "${label}"`);
  return input as HTMLInputElement;
}

function clickButton(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function setValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/**
 * Steps 1–3 are identical for every intent: welcome → credentials →
 * user_type (the single 3-choice account-category question).
 */
async function advanceToAccountCategory() {
  clickButton("Get Started →");

  setValue(inputForLabel("Username"), "labuser");
  setValue(inputForLabel("Email"), "lab@example.com");
  setValue(inputForLabel("Password"), "Password1!");
  setValue(inputForLabel("Confirm Password"), "Password1!");
  clickButton("Continue");

  // Username availability check resolves → user_type step.
  await screen.findByText("Let's get you set up");
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckUsernameAvailable.mockResolvedValue(true);
  mockCheckEmailAvailable.mockResolvedValue(true);
  mockLookupLabs.mockResolvedValue([]);
  mockSendEmailVerificationCode.mockResolvedValue({});
  mockSendPhoneVerificationCode.mockResolvedValue({});
  mockVerifyEmailCode.mockResolvedValue(true);
  mockVerifyPhoneCode.mockResolvedValue(true);
  // Plan list load on the plan_select step.
  mockApiFetch.mockResolvedValue({ ok: true, plans: [] });
});

function renderWizard() {
  const registerMock = vi.fn().mockResolvedValue({ user: { id: "u1" }, token: "t" });
  const Wrapper = makeAuthWrapper("/", { register: registerMock });
  render(
    <Wrapper>
      <SignupWizard onCancel={() => {}} />
    </Wrapper>,
  );
  return { registerMock };
}

async function advanceProviderToPartners() {
  await advanceToAccountCategory();
  fireEvent.click(screen.getByText("Dental provider"));
  fireEvent.click(screen.getByText("Create a new practice"));
  setValue(inputForLabel("Dental License Number"), "DDS123");
  clickButton("Continue");
  setValue(inputForLabel("Practice Name"), "Independent Dental");
  setValue(inputForLabel("Doctor Name"), "Dr. Synthetic047");
  setValue(inputForLabel("Street Address"), "456 Oak Ave");
  setValue(inputForLabel("City"), "Denver");
  setValue(inputForLabel("State"), "CO");
  setValue(inputForLabel("ZIP"), "80201");
  setValue(inputForLabel("Office Phone"), "3035550199");
  clickButton("Continue");
  await screen.findByText("Verify your email");
  setValue(document.querySelector('input[inputmode="numeric"]') as HTMLInputElement, "123456");
  clickButton("Verify");
  await screen.findByText("Case updates");
  clickButton("No thanks");
  await screen.findByText("Partner with a lab");
  expect(screen.getByText("Select one or multiple labs")).toBeInTheDocument();
}

async function finishProviderSignup(action: string) {
  clickButton(action);
  await screen.findByText("Choose your plan");
  fireEvent.click(screen.getByTestId("provider-plan-free"));
  await waitFor(() => clickButton("Continue"));
  await screen.findByText("HIPAA notice");
  fireEvent.click(screen.getByRole("checkbox"));
  clickButton("Accept & Create Account");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SignupWizard — lab account-category flow", () => {
  it("accepts the shared test email and explains username sign-in", async () => {
    renderWizard();

    clickButton("Get Started →");
    expect(screen.getByTestId("signup-progress")).toHaveTextContent("STEP 2 OF 3");
    expect(screen.getByLabelText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("3–12 characters: letters, numbers, or underscores.")).toBeInTheDocument();
    expect(screen.getByText("Special character")).toBeInTheDocument();

    const passwordInput = screen.getByLabelText("Password") as HTMLInputElement;
    expect(passwordInput).toHaveAttribute("type", "password");
    clickButton("Show password");
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute("type", "text");
    clickButton("Hide password");
    expect(passwordInput).toHaveAttribute("type", "password");

    setValue(inputForLabel("Username"), "sharedlab");
    setValue(inputForLabel("Email"), "SHARED-TEST@EXAMPLE.COM");
    setValue(inputForLabel("Password"), "Password1!");
    setValue(inputForLabel("Confirm Password"), "Password1!");

    expect(screen.getByTestId("shared-email-signup-guidance")).toHaveTextContent(
      "Sign in to each with its unique username",
    );
    clickButton("Continue");

    await screen.findByText("Let's get you set up");
    expect(mockCheckUsernameAvailable).toHaveBeenCalledWith("sharedlab");
  });

  it("keeps credential validation and confirmation errors on the redesigned step", async () => {
    renderWizard();
    clickButton("Get Started →");

    clickButton("Continue");
    expect(screen.getByText("Please fill in all fields.")).toBeInTheDocument();

    setValue(inputForLabel("Username"), "newlab");
    setValue(inputForLabel("Email"), "lab@example.com");
    setValue(inputForLabel("Password"), "weak");
    setValue(inputForLabel("Confirm Password"), "weak");
    clickButton("Continue");
    expect(screen.getByText("Password must meet all requirements.")).toBeInTheDocument();

    setValue(inputForLabel("Password"), "Password1!");
    setValue(inputForLabel("Confirm Password"), "Password2!");
    clickButton("Continue");
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();

    setValue(inputForLabel("Confirm Password"), "Password1!");
    clickButton("Continue");
    await screen.findByText("Let's get you set up");
  });

  it("continues to reject a duplicate ordinary email", async () => {
    mockCheckEmailAvailable.mockResolvedValue(false);
    renderWizard();

    clickButton("Get Started →");
    const emailInput = inputForLabel("Email");
    setValue(inputForLabel("Username"), "ordinary");
    setValue(emailInput, "taken@example.com");
    setValue(inputForLabel("Password"), "Password1!");
    setValue(inputForLabel("Confirm Password"), "Password1!");
    fireEvent.blur(emailInput);

    await screen.findByText("An account with this email already exists.");
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("shared-email-signup-guidance")).toBeNull();
  });

  it("JOIN path: collapsed lab-search → verify → finish, account-only payload (createOrganization:false, no lab/practice fields)", async () => {
    const { registerMock } = renderWizard();

    await advanceToAccountCategory();

    fireEvent.click(screen.getByText("Join an existing lab"));
    await screen.findByText("Find your lab");
    expect(screen.queryByText("Lab details")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Step 4 of 6")).toBeInTheDocument();
    clickButton("Continue without selecting");
    await screen.findByText("Verify your email");
    expect(screen.getByLabelText("Step 5 of 6")).toBeInTheDocument();
    setValue(document.querySelector('input[inputmode="numeric"]') as HTMLInputElement, "123456");
    clickButton("Verify");
    await screen.findByText("HIPAA notice");
    expect(screen.queryByText("Case updates")).not.toBeInTheDocument();
    expect(screen.queryByText("Account role")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose your plan")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    clickButton("Accept & Create Account");
    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const payload = registerMock.mock.calls[0][0];
    expect(payload.userType).toBe("lab");
    expect(payload.createOrganization).toBe(false);
    expect(payload.practiceName).toBeUndefined();
    expect(payload.licenseNumber).toBeUndefined();
    expect(payload.practiceAddress).toBeUndefined();
    expect(payload.practicePhone).toBeUndefined();
  });

  it("CREATE path: full lab payload (createOrganization:true, lab name/license/address/phone) and LAB_STEPS_CREATE sequence", async () => {
    const { registerMock } = renderWizard();
    await advanceToAccountCategory();

    // Choosing "Create a new lab" must show the "Lab details" step — this pins
    // the LAB_STEPS_CREATE sequence (9 steps; lab_info is step 4 of 9).
    fireEvent.click(screen.getByText("Create a new lab"));
    await screen.findByText("Lab details");
    expect(screen.getByLabelText("Step 4 of 9")).toBeInTheDocument();
    expect(screen.getByText(/You’ll be Owner with administrator access/)).toBeInTheDocument();

    setValue(inputForLabel("Lab Name"), "Acme Dental Lab");
    setValue(inputForLabel("Street Address"), "123 Main St");
    setValue(inputForLabel("City"), "Springfield");
    setValue(inputForLabel("State"), "IL");
    setValue(inputForLabel("ZIP"), "62704");
    setValue(inputForLabel("Office Phone"), "5551234567");
    setValue(inputForLabel("Lab Email"), "contact@acme.test");
    setValue(inputForLabel("Lab License Number"), "LAB123");
    clickButton("Continue");

    // email_verify → updates_opt_in → join_group → plan_select →
    // hipaa → submit.
    await screen.findByText("Verify your email");
    const codeInput = document.querySelector(
      'input[inputmode="numeric"]',
    ) as HTMLInputElement;
    setValue(codeInput, "123456");
    clickButton("Verify");

    await screen.findByText("Case updates");
    clickButton("No thanks");

    await screen.findByText("Join an existing lab");
    expect(screen.queryByText("Account role")).not.toBeInTheDocument();
    clickButton("Skip for now");

    await screen.findByText("Choose your plan");
    await waitFor(() => clickButton("Continue"));

    await screen.findByText("HIPAA notice");
    fireEvent.click(screen.getByRole("checkbox"));
    clickButton("Accept & Create Account");

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const payload = registerMock.mock.calls[0][0];
    expect(payload.userType).toBe("lab");
    expect(payload.createOrganization).toBe(true);
    expect(payload.practiceName).toBe("Acme Dental Lab");
    expect(payload.licenseNumber).toBe("LAB123");
    expect(payload.practiceAddress).toBe("123 Main St, Springfield, IL, 62704");
    expect(payload.practicePhone).toBe("5551234567");
    expect(payload.role).toBeUndefined();
  });

  it("provider create sends a structured address and no client account number", async () => {
    const { registerMock } = renderWizard();
    await advanceToAccountCategory();
    fireEvent.click(screen.getByText("Dental provider"));
    await screen.findByText("Your practice");
    fireEvent.click(screen.getByText("Create a new practice"));
    await screen.findByText("License number");
    setValue(inputForLabel("Dental License Number"), "DDS123");
    clickButton("Continue");
    await screen.findByText("Practice details");
    expect(screen.getByText(/For a new practice, you’ll be Owner with administrator access/)).toBeInTheDocument();
    setValue(inputForLabel("Practice Name"), "Acme Dental");
    setValue(inputForLabel("Doctor Name"), "Dr. Synthetic047");
    setValue(inputForLabel("Street Address"), "456 Oak Ave");
    setValue(inputForLabel("City"), "Denver");
    setValue(inputForLabel("State"), "CO");
    setValue(inputForLabel("ZIP"), "80201");
    setValue(inputForLabel("Office Phone"), "3035550199");
    clickButton("Continue");
    await screen.findByText("Verify your email");
    setValue(document.querySelector('input[inputmode="numeric"]') as HTMLInputElement, "123456");
    clickButton("Verify");
    await screen.findByText("Case updates");
    clickButton("No thanks");
    await screen.findByText("Partner with a lab");
    expect(screen.queryByText("Account role")).not.toBeInTheDocument();
    clickButton("Skip for now");
    await screen.findByText("Choose your plan");
    fireEvent.click(screen.getByTestId("provider-plan-free"));
    await waitFor(() => clickButton("Continue"));

    await screen.findByText("HIPAA notice");
    fireEvent.click(screen.getByRole("checkbox"));
    clickButton("Accept & Create Account");

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const payload = registerMock.mock.calls[0][0];
    expect(payload.createOrganization).toBe(true);
    expect(payload.joinOrganizationId).toBeUndefined();
    expect(payload.address).toEqual({ line1: "456 Oak Ave", city: "Denver", state: "CO", zip: "80201" });
    expect(payload.accountNumber).toBeUndefined();
    expect(payload.partnerLabSelections).toEqual([]);
    expect(payload.role).toBeUndefined();
  });

  it.each([1, 2])("submits %i partner labs without replacing the intended practice", async (count) => {
    const { registerMock } = renderWizard();
    await advanceProviderToPartners();
    for (let i = 1; i <= count; i++) {
      mockLookupLabs.mockResolvedValue([{ id: `token-${i}`, selectionKey: `key-${i}`, displayName: `Lab ${i}`, city: null, state: null }]);
      setValue(screen.getByPlaceholderText("Search labs…"), `Lab ${i}`);
      fireEvent.click(await screen.findByRole("checkbox", { name: `Lab ${i}` }));
      expect(screen.getByRole("checkbox", { name: `Lab ${i}` })).toHaveAttribute("aria-checked", "true");
      expect(registerMock).not.toHaveBeenCalled();
    }
    if (count === 2) {
      clickButton("Remove Lab 2");
      expect(screen.getByRole("button", { name: "Remove Lab 1" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Lab 2" })).toHaveAttribute("aria-checked", "false");
      fireEvent.click(screen.getByRole("checkbox", { name: "Lab 2" }));
    }
    // Back and Continue retain every selected name.
    clickButton("Back");
    clickButton("No thanks");
    for (let i = 1; i <= count; i++) expect(screen.getByRole("button", { name: `Remove Lab ${i}` })).toBeInTheDocument();
    expect(screen.getByText(`${count} labs selected`)).toBeInTheDocument();
    await finishProviderSignup("Submit partnership request");
    await waitFor(() => expect(registerMock).toHaveBeenCalledOnce());
    expect(registerMock.mock.calls[0][0]).toMatchObject({
      practiceName: "Independent Dental", createOrganization: true,
      partnerLabSelections: Array.from({ length: count }, (_, i) => `token-${i + 1}`),
    });
    expect(registerMock.mock.calls[0][0].joinOrganizationId).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Partnership requests submitted",
      description: expect.stringContaining("Lab 1"),
    }));
  });

  it("deduplicates renewed lookup tokens, removes individual selections, and ignores stale searches", async () => {
    renderWizard();
    await advanceProviderToPartners();
    const search = screen.getByPlaceholderText("Search labs…");
    mockLookupLabs.mockResolvedValue([{ id: "first-token", selectionKey: "stable", displayName: "First Lab", city: null, state: null }]);
    setValue(search, "First");
    expect(screen.getByRole("button", { name: "Submit partnership request" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: "First Lab" }));
    mockLookupLabs.mockResolvedValue([{ id: "renewed-token", selectionKey: "stable", displayName: "First Lab", city: null, state: null }]);
    setValue(search, "renewed");
    await waitFor(() => expect(mockLookupLabs).toHaveBeenCalledWith("renewed"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "First Lab" }));
    expect(screen.queryByRole("button", { name: "Remove First Lab" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "First Lab" }));
    expect(screen.getAllByRole("button", { name: "Remove First Lab" })).toHaveLength(1);
    clickButton("Remove First Lab");
    expect(screen.queryByRole("button", { name: "Remove First Lab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    let resolveOld!: (value: unknown[]) => void;
    mockLookupLabs.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    setValue(search, "old");
    await waitFor(() => expect(mockLookupLabs).toHaveBeenCalledWith("old"));
    setValue(search, "");
    resolveOld([{ id: "stale", displayName: "Stale Lab", city: null, state: null }]);
    await waitFor(() => expect(screen.queryByText("Stale Lab")).toBeNull());
  });

  it("confirms intent before signup and preserves selections on registration failure and retry", async () => {
    const { registerMock } = renderWizard();
    await advanceProviderToPartners();
    mockLookupLabs.mockResolvedValue([{ id: "token", selectionKey: "sdr", displayName: "SDR1", city: null, state: null }]);
    setValue(screen.getByPlaceholderText("Search labs…"), "SDR");
    fireEvent.click(await screen.findByRole("checkbox", { name: "SDR1" }));
    setValue(screen.getByPlaceholderText("Search labs…"), "");
    expect(screen.getByRole("button", { name: "Remove SDR1" })).toBeInTheDocument();
    clickButton("Submit partnership request");
    expect(screen.getByRole("status")).toHaveTextContent("SDR1");
    expect(screen.getByRole("status")).toHaveTextContent("Requests will be sent when signup is completed");
    expect(registerMock).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    await screen.findByText("Choose your plan");
    fireEvent.click(screen.getByTestId("provider-plan-free"));
    await waitFor(() => clickButton("Continue"));
    fireEvent.click(screen.getByRole("checkbox"));
    registerMock.mockRejectedValueOnce(new Error("Please retry registration"));
    clickButton("Accept & Create Account");
    await screen.findByText("Please retry registration");
    expect(toast).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    registerMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    clickButton("Accept & Create Account");
    expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Creating account…" }));
    expect(registerMock).toHaveBeenCalledTimes(2);
    expect(registerMock.mock.calls[1][0].partnerLabSelections).toEqual(["token"]);
    resolve({ user: { id: "u1" }, token: "t" });
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
  });

  it("switches create → join → create without losing lab details or retaining a stale progress count", async () => {
    renderWizard();
    await advanceToAccountCategory();
    fireEvent.click(screen.getByText("Create a new lab"));
    setValue(inputForLabel("Lab Name"), "Saved Lab");
    clickButton("Back");
    fireEvent.click(screen.getByText("Join an existing lab"));
    expect(screen.getByLabelText("Step 4 of 6")).toBeInTheDocument();
    clickButton("Back");
    fireEvent.click(screen.getByText("Create a new lab"));
    expect(screen.getByLabelText("Step 4 of 9")).toBeInTheDocument();
    expect(inputForLabel("Lab Name")).toHaveValue("Saved Lab");
  });
});
