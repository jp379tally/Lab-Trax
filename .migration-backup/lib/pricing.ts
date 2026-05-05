import { Client, MATERIAL_PRICES, PricingTier } from "./data";

export function materialToPriceKey(material: string, caseType?: string): string | null {
  const m = (material || "").toLowerCase().trim();
  const ct = (caseType || "").toLowerCase().trim();
  if (!m) return null;
  if (m.includes("zirconia")) return "zirconia_crown";
  if (m.includes("emax") || m.includes("e.max") || m.includes("e max")) return "emax_crown";
  if (m.includes("pfz")) return "pfz_crown";
  if (m.includes("pfm")) return "pfm_crown";
  if (m.includes("gold") || m.includes("full cast") || m.includes("semi precious") || m.includes("cast metal")) return "pfm_crown";
  if (ct === "removable" || m === "acrylic") return "denture";
  if (m.includes("flexible")) return "partial";
  if (m.includes("night guard") || ct === "appliance") return "night_guard_hard";
  if (m.includes("retainer")) return "retainer_hard";
  if (m.includes("temporary") || ct === "temporary") return "temporary";
  return null;
}

export function findClientByDoctor(doctorName: string, clients: Client[]): Client | undefined {
  const stripDr = (n: string) => (n || "").trim().toLowerCase().replace(/^dr\.?\s*/i, "");
  const drName = stripDr(doctorName);
  if (!drName) return undefined;
  return clients.find(c =>
    stripDr(c.leadDoctor) === drName ||
    (c.additionalProviders || []).some(p => stripDr(p) === drName)
  );
}

export function resolveItemPrice(
  material: string,
  caseType: string | undefined,
  client: Client | undefined,
  pricingTiers: PricingTier[]
): number {
  const key = materialToPriceKey(material, caseType);
  if (key && client?.customPricing && client.customPricing[key] !== undefined && client.customPricing[key] > 0) {
    return client.customPricing[key];
  }
  if (key && client?.tier) {
    const tier = pricingTiers.find(t =>
      (t.name || "").toLowerCase() === (client.tier || "").toLowerCase() ||
      (t.id || "").toLowerCase() === (client.tier || "").toLowerCase()
    );
    if (tier?.prices && tier.prices[key] !== undefined && tier.prices[key] > 0) {
      return tier.prices[key];
    }
  }
  return MATERIAL_PRICES[material] ?? 250;
}

export function resolvePriceForCase(
  material: string,
  caseType: string | undefined,
  doctorName: string,
  clients: Client[],
  pricingTiers: PricingTier[]
): number {
  const client = findClientByDoctor(doctorName, clients);
  return resolveItemPrice(material, caseType, client, pricingTiers);
}
