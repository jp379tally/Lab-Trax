import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRule } from "./lab-scoped-backup-contract";

const open = vi.hoisted(() => vi.fn());
vi.mock("./case-media-object-storage", () => ({ openPrivateBackupObject: open }));
import { LAB_LOGO_EXTENSIONS } from "./lab-logo-storage";
import { collectPrivateLabMedia, safeBackupRelativePath, stagePrivateLabMedia } from "./lab-scoped-backup-media";

const roots: string[] = [];
const uploads: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const file of uploads.splice(0)) await fs.rm(file, { recursive: true, force: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-media-test-"));
  roots.push(root);
  return root;
}
/** Writes a file below the server's uploads directory for one test. */
async function upload(relative: string, bytes: string) {
  const file = path.resolve("uploads", relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: "wx" });
  uploads.push(file);
  return file;
}
/** An App Storage double for one exact object. */
function stored(relativeName: string, bytes: string) {
  return {
    relativeName,
    size: Buffer.byteLength(bytes),
    copyTo: vi.fn(async (destination: string) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }),
  };
}

const unique = randomUUID();
const photo = randomUUID();
const chunkHex = "0123456789abcdef01234567";
/** The scan jobs and inputs an export selected for lab A, from its snapshot. */
const scans = { jobs: new Set(["job-a"]), inputJobs: new Map([["input-a", "job-a"]]) };

const readers: {
  name: string;
  kind: MediaRule["kind"];
  row: Record<string, unknown>;
  value: unknown;
  references: string[];
  /** Keys owned by another row, lab or namespace, or otherwise unsafe. */
  rejected: unknown[];
}[] = [
  {
    name: "uploaded authorization form", kind: "authorization",
    row: { id: "doc-a", lab_organization_id: "lab-a", practice_organization_id: "practice-a" },
    value: "practice-authorizations/lab-a/practice-a/doc-a.pdf",
    references: ["private-objects/case-media/practice-authorizations/lab-a/practice-a/doc-a.pdf"],
    rejected: [
      "practice-authorizations/lab-b/practice-a/doc-a.pdf",
      "practice-authorizations/lab-a/practice-b/doc-a.pdf",
      "practice-authorizations/lab-a/practice-a/doc-b.pdf",
      "lab-authorizations/lab-a/doc-a/authorization.pdf",
    ],
  },
  {
    name: "retired authorization form", kind: "authorization",
    row: {
      id: "doc-a", lab_organization_id: "lab-a", practice_organization_id: "practice-a",
      legacy_authorization_id: "old-a",
    },
    value: "lab-authorizations/lab-a/old-a/authorization.pdf",
    references: ["private-objects/case-media/lab-authorizations/lab-a/old-a/authorization.pdf"],
    rejected: [
      "lab-authorizations/lab-b/old-a/authorization.pdf",
      "lab-authorizations/lab-a/old-b/authorization.pdf",
      "lab-authorizations/lab-a/old-a/signature",
      "practice-authorizations/lab-a/practice-a/doc-a.pdf",
    ],
  },
  {
    name: "retired signature", kind: "legacy-evidence",
    row: { lab_organization_id: "lab-a", legacy_authorization_id: "old-a" },
    value: { signatureObjectKey: "lab-authorizations/lab-a/old-a/signature", signerLegalName: "Signer A" },
    references: ["private-objects/case-media/lab-authorizations/lab-a/old-a/signature"],
    rejected: [
      { signatureObjectKey: "lab-authorizations/lab-b/old-a/signature" },
      { signatureObjectKey: "lab-authorizations/lab-a/old-b/signature" },
      { signatureObjectKey: "lab-authorizations/lab-a/old-a/authorization.pdf" },
      "lab-authorizations/lab-a/old-a/signature",
    ],
  },
  {
    name: "autopay signature", kind: "autopay-signature", row: { id: "auth-a" },
    value: "provider-autopay/auth-a/signature",
    references: ["private-objects/case-media/provider-autopay/auth-a/signature"],
    rejected: ["provider-autopay/auth-b/signature", "provider-autopay/auth-a/authorization.pdf"],
  },
  {
    name: "autopay signed PDF", kind: "autopay-document", row: { id: "auth-a" },
    value: "provider-autopay/auth-a/authorization.pdf",
    references: ["private-objects/case-media/provider-autopay/auth-a/authorization.pdf"],
    rejected: ["provider-autopay/auth-b/authorization.pdf", "provider-autopay/auth-a/signature"],
  },
  {
    name: "statement PDF", kind: "statement-pdf", row: { id: "statement-a" },
    value: `backup-test-${unique}.pdf`,
    references: [`local-uploads/practice-statements/backup-test-${unique}.pdf`],
    rejected: ["../foreign.pdf", "nested/foreign.pdf"],
  },
  {
    name: "statement bundle", kind: "statement-bundle", row: { id: "statement-a" },
    value: {
      attachments: [
        { storageKey: `backup-test-${unique}.pdf` },
        { storageKey: `backup-test-${unique}-doctor-two.pdf` },
      ],
    },
    references: [
      `local-uploads/practice-statements/backup-test-${unique}.pdf`,
      `local-uploads/practice-statements/backup-test-${unique}-doctor-two.pdf`,
    ],
    rejected: [
      { attachments: [{ storageKey: "first.pdf" }, { storageKey: "../foreign.pdf" }] },
      { attachments: [{ storageKey: "first.pdf" }, { storageKey: "" }] },
    ],
  },
  {
    name: "profile photo", kind: "profile-photo", row: { id: "user-a" },
    value: `/uploads/profile-photos/user-a-${photo}.jpg`,
    references: [`local-uploads/profile-photos/user-a-${photo}.jpg`],
    rejected: [
      `/uploads/profile-photos/user-b-${photo}.jpg`,
      `/uploads/profile-photos/user-a-x-${photo}.jpg`,
      "/uploads/profile-photos/user-a-photo.jpg",
      `/uploads/profile-photos/user-a-${photo}.jpg?v=1`,
      "/uploads/case-media/user-a.jpg",
    ],
  },
  {
    name: "logo", kind: "logo", row: { id: "lab-a" },
    value: "/api/organizations/lab-a/logo?v=123",
    references: ["logo-owner/lab-a"],
    rejected: [
      "/api/organizations/lab-b/logo?v=123",
      "/api/organizations/lab-a/logo?v=1&x=2",
      "/api/organizations/lab-a/logo?v=",
      "https://cdn.example/logo.png",
    ],
  },
  {
    name: "support attachment", kind: "support", row: { id: "attachment-a", filename: "screen.png" },
    value: `support-${unique}`,
    references: [`private-objects/support-reports/support-${unique}`],
    rejected: ["../foreign", "reports/foreign"],
  },
  {
    name: "scan input", kind: "scan-input", row: { id: "input-a", job_id: "job-a" },
    value: "scan-job-a-input-input-a",
    references: ["private-objects/case-media/scan-job-a-input-input-a"],
    rejected: [
      "scan-job-b-input-input-a",
      "scan-job-a-input-input-b",
      "scan-job-a-input-input-ab",
      "scan-job-a-input-input-a-",
    ],
  },
  {
    name: "scan input chunk", kind: "scan-chunk", row: { id: "chunk-a", input_id: "input-a", offset: 0 },
    value: `scan-job-a-input-input-a-chunk-0-${chunkHex}`,
    references: [`private-objects/case-media/scan-job-a-input-input-a-chunk-0-${chunkHex}`],
    rejected: [
      `scan-job-a-input-input-b-chunk-0-${chunkHex}`,
      `scan-job-a-input-input-a-chunk-8-${chunkHex}`,
      "scan-job-a-input-input-a-chunk-0-",
      `scan-job-a-input-input-a-chunk-0-${chunkHex}-extra`,
      // The key must name the chunk's own input's job, not just any job.
      `scan-job-b-input-input-a-chunk-0-${chunkHex}`,
      `scan-x-job-a-input-input-a-chunk-0-${chunkHex}`,
      `scan-job-a-input-input-a-chunk-0-ab-input-input-a-chunk-0-${chunkHex}`,
    ],
  },
  {
    name: "scan output", kind: "scan-output",
    row: { id: "output-a", job_id: "job-a", format: "ply", ready_at: "2026-09-12T00:00:00.000Z" },
    value: "scan-job-a-ply-lease-a",
    references: ["private-objects/case-media/scan-job-a-ply-lease-a"],
    rejected: ["scan-job-b-ply-lease-a", "scan-job-a-stl-lease-a", "scan-job-a-ply", "scan-job-a-ply-"],
  },
  {
    name: "saved scan document", kind: "scan-document", row: { id: "document-a", scan_job_id: "job-a" },
    value: "scan-job-a-stl-lease-a",
    references: ["private-objects/case-media/scan-job-a-stl-lease-a"],
    rejected: ["scan-job-b-stl-lease-a", "case-a.jpg", "scan-job-a"],
  },
];

describe("private lab backup readers fail closed", () => {
  it.each(readers)("$name keeps its storage namespace and stops when the file is missing", async ({
    kind, row, value, references,
  }) => {
    const files = new Set<string>();
    expect(collectPrivateLabMedia(kind, row, value, files, scans)).toBe(true);
    expect([...files]).toEqual(references);
    open.mockResolvedValue(null);
    const origin = "fixture_table.fixture_column (row fixture-a)";
    const error = await stagePrivateLabMedia(files, await temp(), new Map([[references[0]!, origin]]))
      .then(() => null, (failure: unknown) => failure as Error);
    expect(error?.message).toContain(`Lab backup stopped: ${origin} refers to a missing file`);
    expect(error?.message).not.toContain(process.cwd());
    // Each reader asks for its exact object; nothing is listed or guessed.
    const first = references[0]!;
    if (first.startsWith("private-objects/")) {
      expect(open).toHaveBeenCalledExactlyOnceWith(first.slice("private-objects/".length));
    } else if (first.startsWith("logo-owner/")) {
      expect(open.mock.calls.map(([name]) => name)).toEqual(LAB_LOGO_EXTENSIONS.map(ext => `lab-logos/lab-a.${ext}`));
    } else {
      expect(open).not.toHaveBeenCalled();
    }
  });

  it.each(readers)("$name refuses keys owned by another row, lab or namespace", ({ kind, row, rejected }) => {
    for (const value of rejected) {
      expect(() => collectPrivateLabMedia(kind, row, value, new Set(), scans), JSON.stringify(value)).toThrow();
    }
  });

  it("refuses scan files whose scan job the export did not select for this lab", () => {
    // Lab B's job and input with correctly bound keys: only the lab check stops these.
    const foreign: [MediaRule["kind"], Record<string, unknown>, string][] = [
      ["scan-input", { id: "input-b", job_id: "job-b" }, "scan-job-b-input-input-b"],
      ["scan-chunk", { id: "chunk-b", input_id: "input-b", offset: 0 }, `scan-job-b-input-input-b-chunk-0-${chunkHex}`],
      ["scan-output", { id: "output-b", job_id: "job-b", format: "ply", ready_at: "2026-09-12" }, "scan-job-b-ply-lease-b"],
      // A saved document is selected by its own lab column, so it can name another lab's job.
      ["scan-document", { id: "document-a", lab_organization_id: "lab-a", scan_job_id: "job-b" }, "scan-job-b-ply-lease-b"],
    ];
    for (const [kind, row, value] of foreign) {
      const files = new Set<string>();
      expect(() => collectPrivateLabMedia(kind, row, value, files, scans), kind)
        .toThrow("does not belong to one of this lab's scan jobs");
      expect([...files], kind).toEqual([]);
    }
    // Without the scan jobs read in the export snapshot, no scan file is exported.
    for (const reader of readers.filter(({ kind }) => kind.startsWith("scan-"))) {
      expect(() => collectPrivateLabMedia(reader.kind, reader.row, reader.value, new Set()), reader.name)
        .toThrow("export snapshot");
    }
  });

  it("refuses a stored key when the row lacks the identity it must be bound to", () => {
    expect(() => collectPrivateLabMedia("authorization", { id: "doc-a", practice_organization_id: "practice-a" },
      "practice-authorizations/undefined/practice-a/doc-a.pdf", new Set())).toThrow("lab_organization_id");
    expect(() => collectPrivateLabMedia("autopay-signature", {}, "provider-autopay/undefined/signature", new Set()))
      .toThrow("no id");
    expect(() => collectPrivateLabMedia("scan-output", { format: "ply", ready_at: "2026-09-12" },
      "scan-undefined-ply-lease", new Set())).toThrow("job_id");
  });

  it.each(["../b", "/etc/passwd", "a/../b", "a//b", "a\\b", "a%2fb", "https://foreign/secret", "a?b", "a#b", "a\0b", "./a", "a/"])(
    "rejects the unsafe or ambiguous path %j",
    value => {
      expect(() => safeBackupRelativePath(value)).toThrow();
      for (const kind of ["statement-pdf", "support"] as const) {
        expect(() => collectPrivateLabMedia(kind, { filename: "report.png" }, value, new Set())).toThrow();
      }
    },
  );

  it("archives every bundle entry the app could serve and ignores manifests it would not read", () => {
    for (const value of ["text", [], {}, { attachments: null }, { attachments: {} },
      { attachments: [null, 7, {}, { storageKey: 7 }] }]) {
      const files = new Set<string>();
      expect(collectPrivateLabMedia("statement-bundle", {}, value, files)).toBe(true);
      expect([...files], JSON.stringify(value)).toEqual([]);
    }
  });

  it("skips references that have no stored bytes by design", () => {
    const files = new Set<string>();
    // A reserved scan output the app never served.
    collectPrivateLabMedia("scan-output", { job_id: "job-a", format: "ply", ready_at: null }, "scan-job-a-ply-lease", files);
    // A support attachment whose retention window already redacted it.
    collectPrivateLabMedia("support", { filename: "" }, "expired-object", files);
    // Profile photos stored outside LabTrax, whatever their path, or inline in the row itself.
    for (const external of [
      "https://images.example/avatar.png",
      "http://images.example/avatar.png",
      "https://example.com/wp-content/uploads/2026/09/avatar.jpg",
      `HTTPS://cdn.example/uploads/profile-photos/user-a-${photo}.jpg`,
      "data:image/png;base64,AAAA",
    ]) {
      expect(collectPrivateLabMedia("profile-photo", { id: "user-a" }, external, files), external).toBe(true);
    }
    // Retired evidence with no signature image.
    collectPrivateLabMedia("legacy-evidence", { lab_organization_id: "lab-a", legacy_authorization_id: "old-a" }, {}, files);
    expect([...files]).toEqual([]);
  });

  it("accepts profile photos from earlier releases that named files by timestamp", () => {
    const files = new Set<string>();
    collectPrivateLabMedia("profile-photo", { id: "user-a" }, "/uploads/profile-photos/user-a-1749112345678.jpg", files);
    expect([...files]).toEqual(["local-uploads/profile-photos/user-a-1749112345678.jpg"]);
  });

  it("copies one exact logo and refuses when more than one stored format exists", async () => {
    open.mockImplementation(async (name: string) => name === "lab-logos/lab-a.jpg" ? stored(name, "LOGO-A") : null);
    const destination = await temp();
    await stagePrivateLabMedia(new Set(["logo-owner/lab-a"]), destination);
    expect(await fs.readFile(path.join(destination, "private-objects/lab-logos/lab-a.jpg"), "utf8")).toBe("LOGO-A");

    const copies: ReturnType<typeof stored>[] = [];
    open.mockImplementation(async (name: string) => {
      if (name !== "lab-logos/lab-a.png" && name !== "lab-logos/lab-a.webp") return null;
      const object = stored(name, "LOGO");
      copies.push(object);
      return object;
    });
    await expect(stagePrivateLabMedia(new Set(["logo-owner/lab-a"]), await temp())).rejects.toThrow("ambiguous");
    expect(copies).toHaveLength(2);
    for (const object of copies) expect(object.copyTo).not.toHaveBeenCalled();
  });

  it("does not read a same-named object from another private namespace", async () => {
    open.mockImplementation(async (name: string) => name === "case-media/shared-name" ? stored(name, "OTHER") : null);
    await expect(stagePrivateLabMedia(new Set(["private-objects/support-reports/shared-name"]), await temp()))
      .rejects.toThrow("missing file");
    expect(open).toHaveBeenCalledExactlyOnceWith("support-reports/shared-name");
  });

  it("copies local statement PDFs byte for byte and leaves other references to the case-media reader", async () => {
    const name = `backup-test-${randomUUID()}.pdf`;
    await upload(`practice-statements/${name}`, "STATEMENT-A");
    const destination = await temp();
    const handled = await stagePrivateLabMedia(
      new Set([`local-uploads/practice-statements/${name}`, "case-a.jpg", "invoice-attachments/invoice-a.pdf"]),
      destination,
    );
    expect([...handled]).toEqual([`local-uploads/practice-statements/${name}`]);
    expect(await fs.readFile(path.join(destination, "local-uploads/practice-statements", name), "utf8")).toBe("STATEMENT-A");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a local upload reached through a symbolic link", async () => {
    const foreign = path.join(await temp(), "foreign.jpg");
    await fs.writeFile(foreign, "foreign-lab-bytes");
    const name = `user-a-${randomUUID()}.jpg`;
    const link = path.resolve("uploads", "profile-photos", name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(foreign, link);
    uploads.push(link);
    const destination = await temp();
    await expect(stagePrivateLabMedia(new Set([`local-uploads/profile-photos/${name}`]), destination))
      .rejects.toThrow("symbolic link");
    await expect(fs.readFile(path.join(destination, "local-uploads/profile-photos", name))).rejects.toThrow();
  });
});
