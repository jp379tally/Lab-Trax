/** @vitest-environment jsdom */
/**
 * Regression suite: "Create a name-only practice"
 *
 * The Customer Center lets a lab admin add a practice with just a name (e.g.
 * "Dr. Susan Byrne"). The server contract (createOrgSchema) only requires
 * name + type — city/state/ZIP are optional. AddPracticeDialog used to block
 * submission unless city, state, AND ZIP were all filled (a handleSubmit gate,
 * `required` attributes, and a disabled submit button), so a name-only practice
 * could never be created and appeared to silently fail.
 *
 * This test pins that a name-only payload is accepted: the submit button is
 * enabled with just a name, and POST /organizations is sent without
 * city/state/zip.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { AddPracticeDialog } from "@/pages/practices";

const LAB = { id: "lab1", type: "lab", name: "Acme Dental Lab", displayName: "Acme Dental Lab" };

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/organizations" && (!opts || opts.method !== "POST")) {
      return Promise.resolve([LAB]);
    }
    if (url === "/organizations" && opts?.method === "POST") {
      return Promise.resolve({ id: "new-org", type: "provider", name: "Dr. Susan Byrne" });
    }
    return Promise.resolve(null);
  });
});

function nameInput(): HTMLInputElement {
  // FormField labels aren't associated with inputs, so target the input that
  // follows the "Legal name" label.
  const label = screen.getByText("Legal name");
  const input = label.parentElement?.querySelector("input");
  if (!input) throw new Error("Legal name input not found");
  return input as HTMLInputElement;
}

describe("AddPracticeDialog — name-only practice creation", () => {
  it("creates a practice with only a name (no city/state/zip)", async () => {
    const onClose = vi.fn();
    render(<AddPracticeDialog adminLabOrgIds={["lab1"]} onClose={onClose} />, {
      wrapper: makeAuthWrapper(),
    });

    fireEvent.change(nameInput(), { target: { value: "Dr. Susan Byrne" } });

    const submit = screen.getByRole("button", { name: "Create practice" });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/organizations",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    const postCall = apiFetchMock.mock.calls.find(
      ([url, opts]) => url === "/organizations" && opts?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(postCall![1].body as string);
    expect(payload.name).toBe("Dr. Susan Byrne");
    expect(payload.type).toBe("provider");
    expect(payload).not.toHaveProperty("city");
    expect(payload).not.toHaveProperty("state");
    expect(payload).not.toHaveProperty("zip");

    // No doctors added → dialog closes after create.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the submit button disabled when the name is empty", () => {
    render(<AddPracticeDialog adminLabOrgIds={["lab1"]} onClose={vi.fn()} />, {
      wrapper: makeAuthWrapper(),
    });
    expect(screen.getByRole("button", { name: "Create practice" })).toBeDisabled();
  });
});
