/** @vitest-environment jsdom */
/**
 * Coverage for the pre-submit "this doctor already has an account" warning
 * (Task #4398).
 *
 * Invariants protected:
 *  - The warning is asked for from the SERVER's resolver, via the read-only
 *    match-preview endpoint. If anyone replaces this with client-side name
 *    matching, the "asks the server" test fails — a second matching rule
 *    would drift from the one the add call actually applies, and the warning
 *    would start lying to the admin.
 *  - The admin sees the account number, the name, what it matched on, and
 *    where that doctor already practises, BEFORE submitting.
 *  - "Not the same person" is a narrow, per-account opt-out: it excludes only
 *    the account that was shown, and the next lookup carries that exclusion
 *    so a second, different match can still be surfaced.
 *  - The opt-out is reversible before submit.
 *  - Eligibility to be looked up matches the SERVER's contract: any non-empty
 *    identity is previewed, because the resolver exact-matches any non-empty
 *    name. A client-side minimum length would silently skip the warning for
 *    short but perfectly real names.
 *  - A failing lookup degrades to silence, never to a blocked or falsely
 *    reassuring form.
 *  - The check cannot be outrun: while it is debouncing or in flight the
 *    caller is told to hold submit, and no match from the PREVIOUS keystrokes
 *    is shown. Otherwise an admin who types and immediately submits attaches
 *    an existing account without ever seeing the warning.
 */

import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
}));

import {
  DoctorMatchNotice,
  useDoctorMatchPreview,
  type DoctorMatch,
} from "../DoctorMatchWarning";

const WAIT = { timeout: 5000 };

function makeMatch(overrides: Partial<DoctorMatch> = {}): DoctorMatch {
  return {
    index: 0,
    userId: "u_brittney",
    displayName: "Dr. Synthetic013 ALIAS013. Provider013",
    firstName: "Brittney",
    lastName: "Craig",
    email: "brittney@example.test",
    phone: null,
    platformAccountNumber: "100042",
    matchedOn: "name",
    similarity: 1,
    practices: ["Southside Dental"],
    alreadyMemberOfPractice: false,
    ...overrides,
  };
}

/**
 * A minimal stand-in for the add-doctor form: one row of fields, the shared
 * preview hook, and the shared notice — the exact wiring both real dialogs
 * use. `distinctFromUserIds` is the value the dialogs send on submit.
 */
function Harness({ scopeOrgId = "org_practice" }: { scopeOrgId?: string | null }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [distinctFromUserIds, setDistinctFromUserIds] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const { matchByIndex, emailConflictRows, isChecking } = useDoctorMatchPreview(
    scopeOrgId,
    [{ firstName, lastName, email, phone: "", distinctFromUserIds }],
  );

  return (
    <div>
      <input
        aria-label="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <input
        aria-label="Last name"
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
      />
      <input
        aria-label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {/* The dialogs gate their real submit on exactly this flag. */}
      <button type="button" disabled={isChecking}>
        {isChecking ? "Checking…" : "Add doctor"}
      </button>
      <DoctorMatchNotice
        match={matchByIndex.get(0)}
        dismissedCount={distinctFromUserIds.length}
        emailConflict={emailConflictRows.has(0)}
        onMarkDistinct={(userId) =>
          setDistinctFromUserIds((ids) =>
            ids.includes(userId) ? ids : [...ids, userId],
          )
        }
        onUndoDistinct={() => setDistinctFromUserIds([])}
      />
      <div data-testid="submit-payload">
        {JSON.stringify(distinctFromUserIds)}
      </div>
    </div>
  );
}

function renderHarness(props: { scopeOrgId?: string | null } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function typeName(value: string) {
  fireEvent.change(screen.getByLabelText("First name"), { target: { value } });
}

/**
 * Wait past the real 400ms debounce. The timer fires a state update, so the
 * wait has to sit inside `act` or React reports an unwrapped update.
 */
async function pastDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
}

/** The debounce is real (400ms), so give it room rather than faking timers. */
function lastRequestBody(): any {
  const call = mockApiFetch.mock.calls.at(-1);
  return call ? JSON.parse(call[1].body) : null;
}

describe("pre-submit duplicate-doctor warning", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ matches: [] });
  });

  it("asks the server's resolver — it never matches on the client", async () => {
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled(), WAIT);
    const [path, init] = mockApiFetch.mock.calls.at(-1)!;
    expect(path).toBe("/organizations/org_practice/doctors/match-preview");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      doctors: [
        {
          firstName: "Brittney",
          lastName: "",
          email: "",
          phone: "",
          distinctFromUserIds: [],
        },
      ],
    });
  });

  it("shows the account number, name, match reason and practice before submit", async () => {
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");

    const notice = await screen.findByRole("status", {}, WAIT);
    expect(notice).toHaveTextContent(/Looks like/i);
    expect(notice).toHaveTextContent(/100042/);
    expect(notice).toHaveTextContent("Dr. Synthetic013 ALIAS013. Provider013");
    expect(notice).toHaveTextContent(/will attach to that account/i);
    expect(notice).toHaveTextContent(/Matched on name/i);
    expect(notice).toHaveTextContent("Southside Dental");
  });

  it("says what matched when it was a near-miss on the name", async () => {
    mockApiFetch.mockResolvedValue({
      matches: [
        makeMatch({
          matchedOn: "name",
          similarity: 0.88,
          alreadyMemberOfPractice: true,
        }),
      ],
    });
    renderHarness();

    typeName("Britney");

    const notice = await screen.findByRole("status", {}, WAIT);
    expect(notice).toHaveTextContent(/Matched on a similar name/i);
    expect(notice).toHaveTextContent(/already at this practice/i);
  });

  it("'not the same person' excludes only that account, and the next lookup carries it", async () => {
    // First lookup matches Brittney; once she is excluded the server surfaces
    // a second account that genuinely shares the name.
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");
    await screen.findByRole("status", {}, WAIT);

    mockApiFetch.mockResolvedValue({
      matches: [
        makeMatch({
          userId: "u_other_brittney",
          displayName: "Dr. Brittney Craig",
          platformAccountNumber: "100099",
        }),
      ],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /Not the same person — create a separate account/i,
      }),
    );

    // The dismissal travels with the request, so the resolver keeps working
    // on everyone else instead of being switched off wholesale.
    await waitFor(
      () =>
        expect(lastRequestBody().doctors[0].distinctFromUserIds).toEqual([
          "u_brittney",
        ]),
      WAIT,
    );
    // ...and the second account is surfaced, not silently duplicated over.
    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent(/100099/),
      WAIT,
    );
    expect(screen.getByTestId("submit-payload")).toHaveTextContent(
      '["u_brittney"]',
    );
  });

  it("confirms the separate account, and lets the admin undo before submitting", async () => {
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");
    await screen.findByRole("status", {}, WAIT);

    // No further match once she's excluded.
    mockApiFetch.mockResolvedValue({ matches: [] });
    fireEvent.click(screen.getByRole("button", { name: /Not the same person/i }));

    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent(
          /a separate account will be created/i,
        ),
      WAIT,
    );
    expect(screen.getByTestId("submit-payload")).toHaveTextContent(
      '["u_brittney"]',
    );

    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    fireEvent.click(screen.getByRole("button", { name: /^Undo/i }));

    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent(/Looks like/i),
      WAIT,
    );
    expect(screen.getByTestId("submit-payload")).toHaveTextContent("[]");
  });

  it("holds submit until the check has answered, so it cannot be outrun", async () => {
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");

    // The whole point of a pre-submit warning: an admin who types and
    // immediately clicks must not get past the check.
    expect(screen.getByRole("button", { name: /Checking/i })).toBeDisabled();

    await screen.findByRole("status", {}, WAIT);
    expect(screen.getByRole("button", { name: "Add doctor" })).toBeEnabled();
  });

  it("drops a match from previous keystrokes the moment the entry changes", async () => {
    mockApiFetch.mockResolvedValue({ matches: [makeMatch()] });
    renderHarness();

    typeName("Brittney");
    await screen.findByRole("status", {}, WAIT);

    // Editing the name invalidates the answer. Keeping it on screen would
    // name the wrong account, and "Attach to existing account" would be a lie.
    mockApiFetch.mockResolvedValue({ matches: [] });
    typeName("Brittany");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Checking/i })).toBeDisabled();

    await waitFor(
      () => expect(screen.getByRole("button", { name: "Add doctor" })).toBeEnabled(),
      WAIT,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a row will be rejected when the email belongs to another account", async () => {
    mockApiFetch.mockResolvedValue({ matches: [], emailConflicts: [0] });
    renderHarness();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "taken@example.test" },
    });

    const notice = await screen.findByRole("status", {}, WAIT);
    expect(notice).toHaveTextContent(/already belongs to another account/i);
    expect(notice).toHaveTextContent(/will be rejected/i);
  });

  it("warns about a two-character name — the server matches those exactly", async () => {
    // The add call accepts any non-empty first name and the resolver
    // exact-matches any non-empty normalized name, so "Al" is attachable the
    // instant it is typed. A client-side minimum length would be a second
    // rule about who can match, and would skip the warning for short names.
    mockApiFetch.mockResolvedValue({
      matches: [
        makeMatch({
          userId: "u_al",
          displayName: "Dr. Al Ng",
          platformAccountNumber: "100007",
        }),
      ],
    });
    renderHarness();

    typeName("Al");
    expect(screen.getByRole("button", { name: /Checking/i })).toBeDisabled();

    const notice = await screen.findByRole("status", {}, WAIT);
    expect(notice).toHaveTextContent(/100007/);
    expect(notice).toHaveTextContent("Dr. Al Ng");
    expect(JSON.parse(mockApiFetch.mock.calls.at(-1)![1].body).doctors[0]).toMatchObject(
      { firstName: "Al" },
    );
  });

  it("stays quiet until something is actually typed", async () => {
    renderHarness();

    await pastDebounce();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Add doctor" })).toBeEnabled();
  });

  it("a failed lookup warns about nothing rather than blocking the add", async () => {
    mockApiFetch.mockRejectedValue(new Error("network down"));
    renderHarness();

    typeName("Brittney");

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled(), WAIT);
    await waitFor(
      () => expect(screen.queryByRole("status")).toBeNull(),
      WAIT,
    );
    // The form is untouched — submit still goes through, and the server
    // resolves the duplicate the way it always has.
    expect(screen.getByTestId("submit-payload")).toHaveTextContent("[]");
  });

  it("does not look anything up before a lab is known", async () => {
    renderHarness({ scopeOrgId: null });
    typeName("Brittney");

    await pastDebounce();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
