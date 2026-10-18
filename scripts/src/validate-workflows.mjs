import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const workflowFiles = (await readdir(workflowsDir))
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort();

if (workflowFiles.length === 0) {
  throw new Error(`No workflow YAML files found in ${workflowsDir}`);
}

for (const file of workflowFiles) {
  const filePath = path.join(workflowsDir, file);
  const document = parseDocument(await readFile(filePath, "utf8"), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    const errors = document.errors.map((error) => error.message).join("\n  ");
    throw new Error(`${file}: invalid YAML\n  ${errors}`);
  }

  const workflow = document.toJS();
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error(`${file}: expected a workflow mapping`);
  }
  if (!Object.hasOwn(workflow, "on")) {
    throw new Error(`${file}: missing GitHub Actions "on" trigger`);
  }
  if (!isMap(document.get("jobs"))) {
    throw new Error(`${file}: missing GitHub Actions jobs mapping`);
  }
  console.log(`✓ ${file}`);
}

console.log(`Validated YAML syntax and workflow structure in ${workflowFiles.length} files.`);
