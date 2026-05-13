// Add-Item Wizard helpers extracted from `app/case/[id].tsx`. The wizard
// itself stays in the screen, but the pure pricing/tooth-display logic
// and the back-button transition table are testable on their own.

import type { Client, PricingTier, ToothType, InvoiceLineItem } from "../data";

export type AddItemStep =
  | "caseType"
  | "toothChart"
  | "material"
  | "removableSubtype"
  | "removableMaterial"
  | "gingivaShade"
  | "applianceSubtype"
  | "applianceArch"
  | "applianceNightGuardType"
  | "applianceRetainerType"
  | "applianceNightGuard"
  | "applianceEssexTeeth"
  | "applianceEssexShade"
  | "complete";

export function formatToothDisplay(
  teeth: number[],
  types: Record<number, ToothType>,
): string {
  const sorted = [...teeth].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i];
    const tp = types[t] || "normal";
    if (tp === "missing") {
      parts.push(`X${t}`);
      i++;
    } else if (tp === "bridge") {
      let end = i;
      while (end + 1 < sorted.length && (types[sorted[end + 1]] || "normal") === "bridge") end++;
      parts.push(end > i ? `#${sorted[i]}-#${sorted[end]}` : `#${t}`);
      i = end + 1;
    } else {
      parts.push(`#${t}`);
      i++;
    }
  }
  return parts.join(", ");
}

export function computeBillableCount(
  teeth: number[],
  types: Record<number, ToothType>,
): number {
  const normalCount = teeth.filter((t) => (types[t] || "normal") === "normal").length;
  const hasPontic = teeth.some((t) => (types[t] || "normal") === "bridge");
  return normalCount + (hasPontic ? 1 : 0);
}

export function getAppliancePriceKey(subtype: string, variant: string): string {
  if (subtype === "Night Guard") {
    if (variant === "Hard") return "night_guard_hard";
    if (variant === "Soft") return "night_guard_soft";
    if (variant === "Hard/Soft") return "night_guard_hard_soft";
  } else if (subtype === "Retainer") {
    if (variant === "Hawley") return "retainer_hawley";
    if (variant === "Hard") return "retainer_hard";
    if (variant === "Lingual") return "retainer_lingual";
  } else if (subtype === "Snore Guard") {
    return "snore_guard";
  } else if (subtype === "Sports Guard") {
    return "sports_guard";
  }
  return "";
}

export function getApplianceUnitPrice(input: {
  priceKey: string;
  client: Client | undefined;
  pricingTiers: PricingTier[];
}): number {
  const { priceKey, client, pricingTiers } = input;
  if (
    priceKey &&
    client?.customPricing?.[priceKey] !== undefined &&
    client.customPricing[priceKey] > 0
  ) {
    return client.customPricing[priceKey];
  }
  const tier = pricingTiers.find((t) => t.name === client?.tier);
  return (tier?.prices?.[priceKey] as number | undefined) ?? 0;
}

export function buildApplianceLineItems(input: {
  subtype: string;
  variant: string;
  arch: string;
  unitPrice: number;
}): InvoiceLineItem[] {
  const { subtype, variant, arch, unitPrice } = input;
  const itemLabel = variant ? `${subtype} - ${variant}` : subtype;
  if (arch === "Both") {
    return [
      { qty: 1, item: itemLabel, description: `${itemLabel} (Upper)`, rate: unitPrice, amount: unitPrice },
      { qty: 1, item: itemLabel, description: `${itemLabel} (Lower)`, rate: unitPrice, amount: unitPrice },
    ];
  }
  const archLabel = arch ? ` (${arch})` : "";
  return [{ qty: 1, item: itemLabel, description: `${itemLabel}${archLabel}`, rate: unitPrice, amount: unitPrice }];
}

// Back-button transition table for the Add Item wizard. Encodes the
// conditional jumps that used to live in the modal header onPress.
export function previousAddItemStep(input: {
  current: AddItemStep;
  itemCaseType: string;
  removableSubtype: string;
}): AddItemStep {
  const { current, itemCaseType, removableSubtype } = input;
  switch (current) {
    case "toothChart":
      return itemCaseType === "Removable" ? "removableSubtype" : "caseType";
    case "material":
      return "toothChart";
    case "removableSubtype":
      return "caseType";
    case "removableMaterial":
      return removableSubtype === "Denture" ? "removableSubtype" : "toothChart";
    case "gingivaShade":
      return "removableMaterial";
    case "applianceSubtype":
      return "caseType";
    case "applianceArch":
      return "applianceSubtype";
    case "applianceNightGuardType":
      return "applianceArch";
    case "applianceRetainerType":
      return "applianceArch";
    case "applianceNightGuard":
      return "applianceSubtype";
    case "applianceEssexTeeth":
      return "applianceSubtype";
    case "applianceEssexShade":
      return "applianceEssexTeeth";
    case "caseType":
    default:
      return "caseType";
  }
}
