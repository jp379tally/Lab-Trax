import { describe, expect, it, vi } from "vitest";
import { installAttachmentSubmissionIndexes } from "./attachment-submission-schema";
import { REQUIRED_MIGRATION_SCHEMA_OBJECTS } from "./schema-object-drift";

describe("attachment retry uniqueness schema", () => {
  it("installs both nullable case scopes without rewriting data", async () => {
    const query = vi.fn().mockResolvedValue({});
    await installAttachmentSubmissionIndexes(query);
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("(case_id, submission_id) WHERE case_id IS NOT NULL AND submission_id IS NOT NULL");
    expect(sql).toContain("(lab_case_id, submission_id) WHERE lab_case_id IS NOT NULL AND submission_id IS NOT NULL");
    expect(sql).not.toMatch(/DELETE|UPDATE|DROP|TRUNCATE/);
    for (const name of ["case_attachments_submission_unique", "case_attachments_legacy_submission_unique"]) {
      expect(REQUIRED_MIGRATION_SCHEMA_OBJECTS).toContainEqual({ kind: "index", schema: "public", name });
    }
  });
  it("propagates duplicate-data/permission failures instead of removing evidence", async () => {
    const failure = new Error("duplicate submission key");
    await expect(installAttachmentSubmissionIndexes(vi.fn().mockRejectedValue(failure))).rejects.toBe(failure);
  });
});
