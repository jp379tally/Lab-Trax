import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { REMAKE_REASON_KEYS } from "../case-taxonomy/src/remake-reasons.ts";

const specPath = fileURLToPath(new URL("./openapi.yaml", import.meta.url));
const startMarker = "          # BEGIN GENERATED REMAKE REASON KEYS";
const endMarker = "          # END GENERATED REMAKE REASON KEYS";
const generatedBlock = [
  startMarker,
  `          enum: [${REMAKE_REASON_KEYS.join(", ")}]`,
  endMarker,
].join("\n");

const spec = await readFile(specPath, "utf8");
const markerPattern = new RegExp(
  `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

if (!markerPattern.test(spec)) {
  throw new Error("Generated remake-reason enum markers were not found in openapi.yaml");
}

const generatedSpec = spec.replace(markerPattern, generatedBlock);
if (generatedSpec !== spec) {
  await writeFile(specPath, generatedSpec);
}