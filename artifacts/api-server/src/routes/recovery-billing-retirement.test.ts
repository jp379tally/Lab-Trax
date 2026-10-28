import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../../");

describe("retired Recovery Billing entrypoints", () => {
  it("does not mount any Recovery Billing routes or publish them in the API contract", () => {
    const routeSource = readFileSync(
      resolve(root, "artifacts/api-server/src/routes/labtrax-routes.ts"),
      "utf8",
    );
    const spec = parse(readFileSync(resolve(root, "lib/api-spec/openapi.yaml"), "utf8"));

    expect(routeSource).not.toContain('router.use("/billing-recovery"');
    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/billing-recovery")))
      .toEqual([]);
  });
});
