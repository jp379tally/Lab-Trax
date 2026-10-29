import { describe, expect, it } from "vitest";
import { assertExternalProductionBinding } from "./external-production-backup";
describe("external production capture binding", () => {
 it("requires explicit opt-in", () => expect(assertExternalProductionBinding(undefined, "dev", "prod")).toBe(false));
 it("rejects development bindings", () => expect(() => assertExternalProductionBinding("a".repeat(40), "dev", "prod")).toThrow());
 it("rejects missing configuration and invalid revisions", () => {
  expect(() => assertExternalProductionBinding("a".repeat(40), "dev", "")).toThrow();
  expect(() => assertExternalProductionBinding("invalid", "prod", "prod")).toThrow();
 });
 it("allows the operator to proceed to mandatory snapshot lineage checks", () => expect(assertExternalProductionBinding("a".repeat(40), "prod", "prod")).toBe(true));
});
