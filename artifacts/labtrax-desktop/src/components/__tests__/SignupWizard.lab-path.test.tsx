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
 *    onboarding (LAB_STEPS_CREATE, 10 steps) including the "Lab details" step.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SignupWizard from "../SignupWizard";
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
    sendEmailVerificationCode: (...args: unknown[]) => mockSendEmailVerificationCode(...args),
    sendPhoneVerificationCode: (...args: unknown[]) => mockSendPhoneVerificationCode(...args),
    verifyEmailCode: (...args: unknown[]) => mockVerifyEmailCode(...args),
    verifyPhoneCode: (...args: unknown[]) => mockVerifyPhoneCode(...args),
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

function setValue(input: HTMLInputElement, value: string) {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SignupWizard — lab account-category flow", () => {
  it("JOIN path: collapsed lab-search → verify → finish, account-only payload (createOrganization:false, no lab/practice fields)", async () => {
    const { registerMock } = renderWizard();

    await advanceToAccountCategory();

    // Choosing "Join an existing lab" goes straight to the lab-search step and
    // pins LAB_STEPS_JOIN (6 steps; join_group is step 4 of 6).
    fireEvent.click(screen.getByText("Join an existing lab"));
    await screen.findByText("Find your lab");
    expect(screen.queryByText("Lab details")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Step 4 of 6")).toBeInTheDocument();

    // Continue without selecting a lab → email verification.
    clickButton("Continue without selecting");
    await screen.findByText("Verify your email");
    // email_verify is step 5 of 6.
    expect(screen.getByLabelText("Step 5 of 6")).toBeInTheDocument();

    const codeInput = document.querySelector(
      'input[inputmode="numeric"]',
    ) as HTMLInputElement;
    setValue(codeInput, "123456");
    clickButton("Verify");

    // The JOIN path skips updates_opt_in / role_select / plan_select and goes
    // straight to the HIPAA finish step.
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
    // the LAB_STEPS_CREATE sequence (10 steps; lab_info is step 4 of 10).
    fireEvent.click(screen.getByText("Create a new lab"));
    await screen.findByText("Lab details");
    expect(screen.getByLabelText("Step 4 of 10")).toBeInTheDocument();

    setValue(inputForLabel("Lab Name"), "Acme Dental Lab");
    setValue(inputForLabel("Street Address"), "123 Main St");
    setValue(inputForLabel("City"), "Springfield");
    setValue(inputForLabel("State"), "IL");
    setValue(inputForLabel("ZIP"), "62704");
    setValue(inputForLabel("Office Phone"), "5551234567");
    setValue(inputForLabel("Lab Email"), "contact@acme.test");
    setValue(inputForLabel("Lab License Number"), "LAB123");
    clickButton("Continue");

    // email_verify → updates_opt_in → role_select → join_group → plan_select →
    // hipaa → submit.
    await screen.findByText("Verify your email");
    const codeInput = document.querySelector(
      'input[inputmode="numeric"]',
    ) as HTMLInputElement;
    setValue(codeInput, "123456");
    clickButton("Verify");

    await screen.findByText("Case updates");
    clickButton("No thanks");

    await screen.findByText("Account role");
    fireEvent.click(screen.getByText("User"));

    await screen.findByText("Join an existing lab");
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
  });
});
