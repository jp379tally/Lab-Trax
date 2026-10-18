import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "./http";

export const RECOVERY_DATA_UNAVAILABLE_MESSAGE =
  "Recovery billing is unavailable because its private source records or configuration are missing or invalid.";

const DEFAULT_RECOVERY_CONFIGURATION = {
  labId: "00000000-0000-4000-8000-000000000001",
  tag: "recovery-test-fixture",
  startDate: "1970-01-01",
  endDate: "9999-12-31",
  timezone: "UTC",
  safeguardVersion: "recovery-safeguards-v1",
  caseNumberOverrides: {},
  legacyCleanup: {
    confirmationPhrase: "CONFIRM_FIXTURE_ONLY",
    eraStartMs: 946684800000,
    eraEndMs: 946771200000,
    targetPatients: ["Fixture Patient"],
  },
} as const;

const stagedCaseSchema = z.object({
  case_number: z.string().min(1),
  received_at: z.string().min(1),
  provider_organization_id: z.string().nullable().optional(),
  needs_ai_review: z.boolean().nullable().optional(),
  evidence: z.unknown().optional(),
}).passthrough();
const stagedCasesSchema = z.array(stagedCaseSchema);
const stagedAttachmentSchema = z.object({
  disk_filename: z.string().min(1),
  kind: z.string().min(1),
}).passthrough();
const stagedAttachmentsSchema = z.record(z.string(), z.array(stagedAttachmentSchema));

function validIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const recoveryPrivateConfigSchema = z.object({
  labId: z.string().uuid(),
  tag: z.string().min(1).max(120),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validIsoDate),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validIsoDate),
  timezone: z.string().min(1).max(120).refine(validTimeZone),
  safeguardVersion: z.string().min(1).max(120),
  caseNumberOverrides: z.record(z.string().min(1), z.string().min(1)),
  legacyCleanup: z.object({
    confirmationPhrase: z.string().min(1).max(160),
    eraStartMs: z.number().int().nonnegative(),
    eraEndMs: z.number().int().positive(),
    targetPatients: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  }).strict().superRefine((cleanup, context) => {
    if (cleanup.eraStartMs >= cleanup.eraEndMs) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["eraEndMs"], message: "Legacy cleanup date window is reversed." });
    }
    if (new Set(cleanup.targetPatients).size !== cleanup.targetPatients.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetPatients"], message: "Legacy cleanup targets must be unique." });
    }
  }),
}).strict().superRefine((config, context) => {
  if (config.startDate > config.endDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "Date window is reversed." });
  }
  if (Object.keys(config.caseNumberOverrides).length !== 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["caseNumberOverrides"], message: "Required identity map is incomplete." });
  }
  if (new Set(Object.values(config.caseNumberOverrides)).size !== Object.keys(config.caseNumberOverrides).length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["caseNumberOverrides"], message: "Identity map targets must be unique." });
  }
});

type RecoveryPrivateConfig = z.infer<typeof recoveryPrivateConfigSchema>;
type StagedCase = z.infer<typeof stagedCaseSchema>;
type StagedAttachments = z.infer<typeof stagedAttachmentsSchema>;

export type RecoveryScopeEntry = {
  caseNumber: string;
  historicalDate: string;
  practiceId?: string | null;
  flagged?: boolean | null;
  evidence?: unknown;
  prescriptions: string[];
  inWindow: boolean;
};

export type RecoveryScopeLoadResult =
  | { available: true; scope: Map<string, RecoveryScopeEntry>; configuration: RecoveryPrivateConfig }
  | { available: false; reason: "missing" | "invalid" | "empty" | "ambiguous"; scope: Map<string, RecoveryScopeEntry> };

function recoveredCaseId(caseNumber: string): string {
  const namespace = Buffer.from("6f1b3d0e6a4c4c7a9b2e3d5a7c9e1f20", "hex");
  const hash = createHash("sha1").update(namespace).update(`case:${caseNumber}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emptyScope(): Map<string, RecoveryScopeEntry> {
  return new Map<string, RecoveryScopeEntry>();
}

// Only evidence-backed, applied identities enter the repair. Never case-number
// matching alone: paper numbers can be reissued to unrelated live cases.
export function buildRecoveryScope(
  casesInput: unknown,
  attachmentsInput: unknown,
  caseNumberOverrides: Readonly<Record<string, string>> = {},
  dateWindow: Pick<RecoveryPrivateConfig, "startDate" | "endDate"> = DEFAULT_RECOVERY_CONFIGURATION,
): Map<string, RecoveryScopeEntry> {
  const stagedCases = stagedCasesSchema.parse(casesInput);
  const stagedAttachments: StagedAttachments = stagedAttachmentsSchema.parse(attachmentsInput);
  return new Map(stagedCases.map((row: StagedCase): [string, RecoveryScopeEntry] => {
    const caseNumber = caseNumberOverrides[row.case_number] ?? row.case_number;
    return [recoveredCaseId(caseNumber), {
      caseNumber,
      historicalDate: row.received_at,
      practiceId: row.provider_organization_id,
      flagged: row.needs_ai_review,
      evidence: row.evidence,
      prescriptions: (stagedAttachments[row.case_number] ?? [])
        .filter((attachment) => attachment.kind === "prescription")
        .map((attachment) => attachment.disk_filename),
      inWindow: row.received_at >= dateWindow.startDate && row.received_at <= dateWindow.endDate,
    }];
  }));
}

export function loadRecoveryScopeFromDirectory(directory: string): RecoveryScopeLoadResult {
  let casesText: string;
  let attachmentsText: string;
  let configText: string;
  try {
    casesText = readFileSync(path.join(directory, "staged-cases.json"), "utf8");
    attachmentsText = readFileSync(path.join(directory, "staged-attachments.json"), "utf8");
    configText = readFileSync(path.join(directory, "recovery-scope-config.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      return { available: false, reason: "missing", scope: emptyScope() };
    }
    throw error;
  }

  try {
    const configuration = recoveryPrivateConfigSchema.parse(JSON.parse(configText));
    const stagedCases = stagedCasesSchema.parse(JSON.parse(casesText));
    const stagedAttachments = stagedAttachmentsSchema.parse(JSON.parse(attachmentsText));
    if (stagedCases.length === 0) {
      return { available: false, reason: "empty", scope: emptyScope() };
    }
    const sourceNumbers = new Set(stagedCases.map((row) => row.case_number));
    if (Object.keys(configuration.caseNumberOverrides).some((number) => !sourceNumbers.has(number))) {
      return { available: false, reason: "invalid", scope: emptyScope() };
    }
    const resolvedNumbers = stagedCases.map((row) =>
      configuration.caseNumberOverrides[row.case_number] ?? row.case_number,
    );
    if (new Set(resolvedNumbers).size !== resolvedNumbers.length) {
      return { available: false, reason: "invalid", scope: emptyScope() };
    }
    return {
      available: true,
      configuration,
      scope: buildRecoveryScope(
        stagedCases,
        stagedAttachments,
        configuration.caseNumberOverrides,
        configuration,
      ),
    };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
      return { available: false, reason: "invalid", scope: emptyScope() };
    }
    throw error;
  }
}

function findWorkspaceRoot(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function completePrivateDataDirectories(supportRoot: string): string[] {
  try {
    return readdirSync(supportRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(supportRoot, entry.name))
      .filter((directory) => [
        "staged-cases.json",
        "staged-attachments.json",
        "recovery-scope-config.json",
      ].every((file) => existsSync(path.join(directory, file))));
  } catch {
    return [];
  }
}

function defaultRecoveryDataDirectory(): { directory: string; ambiguous: boolean } {
  const configured = process.env.LABTRAX_RECOVERY_DATA_DIR?.trim();
  if (configured) return { directory: path.resolve(configured), ambiguous: false };

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const supportRoots = [
    ...(workspaceRoot ? [path.join(workspaceRoot, "support")] : []),
    path.resolve(process.cwd(), "support"),
    path.resolve(process.cwd(), "../../support"),
    path.resolve(process.cwd(), "../support"),
  ].filter((directory, index, all) => all.indexOf(directory) === index);
  const complete = supportRoots.flatMap(completePrivateDataDirectories);
  if (complete.length === 1) return { directory: complete[0]!, ambiguous: false };
  if (complete.length > 1) return { directory: supportRoots[0] ?? process.cwd(), ambiguous: true };
  return {
    directory: path.join(supportRoots[0] ?? process.cwd(), "recovery-billing"),
    ambiguous: false,
  };
}

const dataDirectory = defaultRecoveryDataDirectory();
const loadedRecoveryScope: RecoveryScopeLoadResult = dataDirectory.ambiguous
  ? { available: false, reason: "ambiguous", scope: emptyScope() }
  : loadRecoveryScopeFromDirectory(dataDirectory.directory);
const activeConfiguration = loadedRecoveryScope.available
  ? loadedRecoveryScope.configuration
  : DEFAULT_RECOVERY_CONFIGURATION;

export const RECOVERY_DATA_DIR = dataDirectory.directory;
export const RECOVERY_LAB_ID = activeConfiguration.labId;
export const RECOVERY_TAG = activeConfiguration.tag;
export const RECOVERY_START = activeConfiguration.startDate;
export const RECOVERY_END = activeConfiguration.endDate;
export const RECOVERY_TIMEZONE = activeConfiguration.timezone;
export const RECOVERY_SAFEGUARD_VERSION = activeConfiguration.safeguardVersion;
export const legacyCleanupConfiguration = activeConfiguration.legacyCleanup;
export const recoveryScope = loadedRecoveryScope.scope;
export const recoveryDataAvailable = loadedRecoveryScope.available;

export function assertRecoveryDataAvailable(
  result: RecoveryScopeLoadResult = loadedRecoveryScope,
): asserts result is Extract<RecoveryScopeLoadResult, { available: true }> {
  if (!result.available) throw new HttpError(503, RECOVERY_DATA_UNAVAILABLE_MESSAGE);
}
