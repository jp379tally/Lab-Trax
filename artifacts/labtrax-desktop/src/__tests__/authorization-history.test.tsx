/* @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationHistory,
  type AuthorizationRecord,
} from "@/components/AuthorizationHistory";

describe("AuthorizationHistory", () => {
  it("labels current and superseded uploads and only offers replacement for the current record", () => {
    const current: AuthorizationRecord = {
      id: "current-1",
      authorizationType: "autopay",
      originalFilename: "correct.pdf",
      byteSize: 100,
      uploaderUserId: "user-1",
      createdAt: "2026-01-02T00:00:00.000Z",
      supersedesDocumentId: "old-1",
      status: "current",
    };
    const superseded: AuthorizationRecord = {
      id: "old-1",
      authorizationType: "card_on_file",
      originalFilename: "wrong.pdf",
      byteSize: null,
      uploaderUserId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      supersedesDocumentId: null,
      status: "superseded",
    };
    const replace = vi.fn();

    render(
      <AuthorizationHistory
        records={[current, superseded]}
        onView={vi.fn()}
        onDownload={vi.fn()}
        onReplace={replace}
      />,
    );

    expect(screen.getByTestId("authorization-status-current-1")).toHaveTextContent("Current");
    expect(screen.getByTestId("authorization-status-old-1")).toHaveTextContent("Superseded");
    expect(screen.queryByTestId("button-replace-authorization-old-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-replace-authorization-current-1"));
    expect(replace).toHaveBeenCalledWith(current);
  });
});