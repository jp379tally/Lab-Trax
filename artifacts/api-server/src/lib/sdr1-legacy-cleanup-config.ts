import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const cleanupConfigSchema = z.object({
  labId: z.string().uuid(),
  legacyCleanup: z.object({
    confirmationPhrase: z.string().min(1).max(160),
    eraStartMs: z.number().int().nonnegative(),
    eraEndMs: z.number().int().positive(),
    targetPatients: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  }).strict().superRefine((config, context) => {
    if (config.eraStartMs >= config.eraEndMs) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["eraEndMs"], message: "Cleanup date window is reversed." });
    }
    if (new Set(config.targetPatients).size !== config.targetPatients.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetPatients"], message: "Cleanup targets must be unique." });
    }
  }),
}).passthrough();

type LegacyCleanupConfig = {
  labOrganizationId: string;
  confirmationPhrase: string;
  eraStartMs: number;
  eraEndMs: number;
  targetPatients: string[];
};

export const legacyCleanupUnavailableMessage =
  "The private legacy-cleanup configuration is missing or invalid.";

function findWorkspaceRoot(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function configuredDirectory(): string | null {
  const configured = process.env.LABTRAX_SDR1_CLEANUP_CONFIG_DIR?.trim()
    || process.env.LABTRAX_RECOVERY_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const supportRoots = [
    ...(workspaceRoot ? [path.join(workspaceRoot, "support")] : []),
    path.resolve(process.cwd(), "support"),
    path.resolve(process.cwd(), "../../support"),
    path.resolve(process.cwd(), "../support"),
  ].filter((directory, index, all) => all.indexOf(directory) === index);
  const matches = new Set<string>();
  for (const root of supportRoots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(root, entry.name);
        if (existsSync(path.join(directory, "recovery-scope-config.json"))) matches.add(directory);
      }
    } catch {
      // Missing support roots are expected in local and isolated test runs.
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function loadLegacyCleanupConfig(): LegacyCleanupConfig | null {
  const directory = configuredDirectory();
  if (!directory) return null;
  try {
    const parsed = cleanupConfigSchema.parse(JSON.parse(
      readFileSync(path.join(directory, "recovery-scope-config.json"), "utf8"),
    ));
    return {
      labOrganizationId: parsed.labId,
      ...parsed.legacyCleanup,
    };
  } catch {
    return null;
  }
}

const loaded = loadLegacyCleanupConfig();
export const legacyCleanupConfigurationAvailable = loaded !== null;
export const legacyCleanupConfiguration: LegacyCleanupConfig = loaded ?? {
  labOrganizationId: "",
  confirmationPhrase: "",
  eraStartMs: 0,
  eraEndMs: 1,
  targetPatients: [],
};
