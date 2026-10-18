import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exportedDeclarationPattern =
  /^\s*export\s+(?:declare\s+)?(const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)\b/gm;
const exportedListPattern = /^\s*export\s*\{([^}]*)\}/gm;
const fingerprintManifestPath = "lib/api-spec/generated-api-fingerprint.json";
const fingerprintInputPaths = [
  "lib/api-spec/openapi.yaml",
  "lib/api-spec/orval.config.ts",
  "lib/api-spec/fix-zod-constant-order.mjs",
  "lib/api-spec/package.json",
];
const generatedDirectoryPaths = [
  "lib/api-zod/src/generated",
  "lib/api-client-react/src/generated",
];

export interface GeneratedApiFingerprint {
  version: 1;
  toolchain: Record<string, string>;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertRetiredCaseReviewAbsent(
  source: string,
  sourcePath: string,
): void {
  // Check source text rather than the fingerprint: regenerating clients must
  // not legitimize the retired contract. Include Orval's hook/schema helpers.
  const retiredPath = "/cases/{caseId}/ai-review";
  const retiredOperation = [...source.matchAll(/[A-Za-z_$][\w$]*/g)]
    .find(([identifier]) =>
      identifier.toLowerCase().includes("acknowledgeaireview"),
    )?.[0];
  const violations = [
    ...(source.includes(retiredPath) ? [retiredPath] : []),
    ...(retiredOperation ? [retiredOperation] : []),
  ];
  if (violations.length === 0) return;

  throw new Error(
    [
      `Retired case-review API found in ${sourcePath}: ${violations.join(", ")}`,
      "Remove PATCH /cases/{caseId}/ai-review and operationId acknowledgeAiReview from the OpenAPI contract.",
      "Then regenerate the clients with pnpm --filter @workspace/api-spec run codegen.",
      "Case acknowledgement is retired; invoice review and historical case metadata remain supported.",
    ].join("\n"),
  );
}

export function findDuplicateNamedExports(source: string): string[] {
  const counts = new Map<string, number>();
  const record = (name: string, space: "type" | "value") => {
    const key = `${space}:${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const match of source.matchAll(exportedDeclarationPattern)) {
    const declarationKind = match[1];
    record(
      match[2],
      declarationKind === "type" || declarationKind === "interface"
        ? "type"
        : "value",
    );
  }

  for (const match of source.matchAll(exportedListPattern)) {
    for (const specifier of match[1].split(",")) {
      const trimmedSpecifier = specifier.trim();
      const isTypeExport = trimmedSpecifier.startsWith("type ");
      const withoutTypeKeyword = trimmedSpecifier.replace(/^type\s+/, "");
      if (!withoutTypeKeyword) continue;

      const aliasMatch = withoutTypeKeyword.match(
        /^(?:[A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (aliasMatch) {
        record(
          aliasMatch[1] ?? withoutTypeKeyword,
          isTypeExport ? "type" : "value",
        );
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key.slice(key.indexOf(":") + 1))
    .sort();
}

export function assertNoDuplicateNamedExports(
  source: string,
  sourcePath: string,
): void {
  const duplicates = findDuplicateNamedExports(source);
  if (duplicates.length === 0) return;

  throw new Error(
    [
      `Duplicate named exports found in ${sourcePath}: ${duplicates.join(", ")}`,
      "Regenerate the API clients from lib/api-spec/openapi.yaml with:",
      "  pnpm --filter @workspace/api-spec run codegen",
      "Then commit the corrected generated output.",
    ].join("\n"),
  );
}

export function assertRequiredNamedExports(
  source: string,
  sourcePath: string,
  requiredNames: readonly string[],
): void {
  const exportedNames = new Set<string>();
  for (const match of source.matchAll(exportedDeclarationPattern)) {
    exportedNames.add(match[2]);
  }
  for (const match of source.matchAll(exportedListPattern)) {
    for (const specifier of match[1].split(",")) {
      const withoutTypeKeyword = specifier.trim().replace(/^type\s+/, "");
      const aliasMatch = withoutTypeKeyword.match(
        /^(?:[A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (aliasMatch) exportedNames.add(aliasMatch[1] ?? withoutTypeKeyword);
    }
  }

  const missing = requiredNames.filter((name) => !exportedNames.has(name));
  if (missing.length === 0) return;

  throw new Error(
    `Required generated exports missing from ${sourcePath}: ${missing.join(", ")}`,
  );
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

export function createGeneratedApiFingerprint(
  workspaceRoot: string,
): GeneratedApiFingerprint {
  const hashPaths = (paths: string[]) =>
    Object.fromEntries(
      paths
        .map((path) => [path, hashFile(resolve(workspaceRoot, path))] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const generatedPaths = generatedDirectoryPaths.flatMap((directory) =>
    listTypeScriptFiles(resolve(workspaceRoot, directory)).map((path) =>
      relative(workspaceRoot, path).replaceAll("\\", "/"),
    ),
  );
  const packageVersion = (packageJsonPath: string): string => {
    const packageJson = JSON.parse(
      readFileSync(resolve(workspaceRoot, packageJsonPath), "utf8"),
    ) as { version?: unknown };
    if (typeof packageJson.version !== "string") {
      throw new Error(`Missing package version in ${packageJsonPath}`);
    }
    return packageJson.version;
  };

  return {
    version: 1,
    toolchain: {
      orval: packageVersion("lib/api-spec/node_modules/orval/package.json"),
      prettier: packageVersion("node_modules/prettier/package.json"),
    },
    inputs: hashPaths(fingerprintInputPaths),
    outputs: hashPaths(generatedPaths),
  };
}

export function assertGeneratedApiFingerprintCurrent(
  expected: GeneratedApiFingerprint,
  actual: GeneratedApiFingerprint,
): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;

  throw new Error(
    [
      "Generated API clients are out of date with lib/api-spec/openapi.yaml or their codegen inputs.",
      "Regenerate them with:",
      "  pnpm --filter @workspace/api-spec run codegen",
      "Then commit the generated clients and lib/api-spec/generated-api-fingerprint.json.",
    ].join("\n"),
  );
}

function main(): void {
  const workspaceRoot = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const specPath = "lib/api-spec/openapi.yaml";
  assertRetiredCaseReviewAbsent(
    readFileSync(resolve(workspaceRoot, specPath), "utf8"),
    specPath,
  );
  const generatedFiles = generatedDirectoryPaths.flatMap((directory) =>
    listTypeScriptFiles(resolve(workspaceRoot, directory)),
  );

  for (const generatedFile of generatedFiles) {
    const source = readFileSync(generatedFile, "utf8");
    assertRetiredCaseReviewAbsent(source, generatedFile);
    assertNoDuplicateNamedExports(
      source,
      generatedFile,
    );
  }
  assertRequiredNamedExports(
    readFileSync(
      resolve(workspaceRoot, "lib/api-zod/src/generated/api.ts"),
      "utf8",
    ),
    "lib/api-zod/src/generated/api.ts",
    ["StartScanJob409Response", "UploadScanInputChunk409Response"],
  );

  const actualFingerprint = createGeneratedApiFingerprint(workspaceRoot);
  const manifestFile = resolve(workspaceRoot, fingerprintManifestPath);
  if (process.argv.includes("--write-fingerprint")) {
    writeFileSync(
      manifestFile,
      `${JSON.stringify(actualFingerprint, null, 2)}\n`,
    );
    return;
  }

  let expectedFingerprint: GeneratedApiFingerprint;
  try {
    expectedFingerprint = JSON.parse(
      readFileSync(manifestFile, "utf8"),
    ) as GeneratedApiFingerprint;
  } catch {
    throw new Error(
      [
        `Generated API fingerprint is missing or invalid: ${fingerprintManifestPath}`,
        "Generate it with:",
        "  pnpm --filter @workspace/api-spec run codegen",
      ].join("\n"),
    );
  }
  assertGeneratedApiFingerprintCurrent(expectedFingerprint, actualFingerprint);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
