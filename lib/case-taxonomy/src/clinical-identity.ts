import { deriveCaseHierarchy } from "./taxonomy";

type ClinicalValues = { restorationType?: string | null; restorationSubtype?: string | null; material?: string | null };
/** Dropdown labels and historical raw type names can describe the same
 * stored hierarchy. Merely round-tripping the dropdown must not reprice it. */
export function sameClinicalHierarchy(a: ClinicalValues, b: ClinicalValues): boolean {
  const left = deriveCaseHierarchy(a.restorationType, a.restorationSubtype, a.material);
  const right = deriveCaseHierarchy(b.restorationType, b.restorationSubtype, b.material);
  if (!left.subtype && !left.customSubtypeId && a.restorationType !== b.restorationType) return false;
  const leftMaterial = left.customMaterialSubtypeId ?? left.materialSubtype ?? deriveCaseHierarchy(a.restorationType, null, a.material).materialSubtype;
  const rightMaterial = right.customMaterialSubtypeId ?? right.materialSubtype ?? deriveCaseHierarchy(b.restorationType, null, b.material).materialSubtype;
  return left.caseType === right.caseType && left.subtype === right.subtype &&
    left.customSubtypeId === right.customSubtypeId && leftMaterial === rightMaterial &&
    (a.material ?? "").trim().toLowerCase() === (b.material ?? "").trim().toLowerCase();
}
