import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const generatedZodPath = path.resolve(
  currentDir,
  "..",
  "api-zod",
  "src",
  "generated",
  "api.ts"
);
const generatedRoots = [
  path.resolve(currentDir, "..", "api-zod", "src", "generated"),
  path.resolve(currentDir, "..", "api-client-react", "src", "generated"),
];

// Orval appends wildcard exports to the hand-maintained Zod package barrel.
// Keep its curated type exports instead of publishing duplicate names.
const zodBarrelPath = path.resolve(currentDir, "..", "api-zod", "src", "index.ts");
const barrel = fs.readFileSync(zodBarrelPath, "utf8");
if (!barrel.includes('export * from "./generated/api";')) {
  throw new Error(`Missing curated Zod exports in ${zodBarrelPath}`);
}
const curatedBarrel = barrel.replace(
  /^export \* from '(?:\.\/generated\/api|\.\/generated\/types)';\r?\n/gm,
  ""
);
if (curatedBarrel !== barrel) fs.writeFileSync(zodBarrelPath, curatedBarrel);

const source = fs.readFileSync(generatedZodPath, "utf8");
const declarationPattern =
  /^export const ([A-Za-z_$][\w$]*) = (-?(?:\d+(?:\.\d+)?|\.\d+));\r?\n/gm;
const forwardDeclarations = [];

for (const match of source.matchAll(declarationPattern)) {
  const name = match[1];
  const declarationIndex = match.index;
  const firstReferenceIndex = source.search(new RegExp(`\\b${name}\\b`));

  if (firstReferenceIndex !== -1 && firstReferenceIndex < declarationIndex) {
    forwardDeclarations.push({
      declaration: match[0].trimEnd(),
      start: declarationIndex,
      end: declarationIndex + match[0].length,
    });
  }
}

if (forwardDeclarations.length > 0) {
  let fixedSource = source;
  for (const item of [...forwardDeclarations].reverse()) {
    fixedSource =
      fixedSource.slice(0, item.start) + fixedSource.slice(item.end);
  }

  const importLine = 'import * as zod from "zod";';
  const insertionIndex = fixedSource.indexOf(importLine) + importLine.length;
  if (insertionIndex < importLine.length) {
    throw new Error(`Could not find the Zod import in ${generatedZodPath}`);
  }

  const hoistedBlock = forwardDeclarations
    .map((item) => item.declaration)
    .join("\n\n");
  fixedSource =
    fixedSource.slice(0, insertionIndex) +
    `\n\n${hoistedBlock}` +
    fixedSource.slice(insertionIndex);
  fs.writeFileSync(generatedZodPath, fixedSource);
  console.log(
    `Hoisted ${forwardDeclarations.length} generated Zod constraint constants.`
  );
}

// Orval's formatter and the hoisting pass may disagree about line endings and
// trailing whitespace. Canonicalize *all* generated TypeScript before hashing.
function normalizeGeneratedFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeGeneratedFiles(filePath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const original = fs.readFileSync(filePath, "utf8");
      const normalized =
        original.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "") + "\n";
      if (original !== normalized) fs.writeFileSync(filePath, normalized);
    }
  }
}

for (const directory of generatedRoots) normalizeGeneratedFiles(directory);