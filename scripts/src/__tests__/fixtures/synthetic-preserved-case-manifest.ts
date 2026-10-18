interface SyntheticPreservedCaseManifest {
  version: 1;
  archiveSha256: string;
  columns: string[];
  cases: { id: string; rowHash: string }[];
}

export function createSyntheticPreservedCaseManifest(): SyntheticPreservedCaseManifest {
  return {
    version: 1,
    archiveSha256: "a".repeat(64),
    columns: [
      "id",
      "lab_organization_id",
      "provider_organization_id",
      "created_at",
    ],
    cases: Array.from({ length: 297 }, (_, index) => ({
      id: `synthetic-case-${String(index + 1).padStart(4, "0")}`,
      rowHash: (index + 1).toString(16).padStart(32, "0"),
    })),
  };
}
