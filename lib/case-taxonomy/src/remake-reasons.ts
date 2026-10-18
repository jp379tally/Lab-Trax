export type RemakeReasonCategory = "crown_bridge" | "removable";
export type RemakeConditionalField = "customReason" | "shade" | "material";

export const REMAKE_REASONS = [
  { key: "fit_contacts", label: "Didn't fit — contacts", category: "crown_bridge", conditionalFields: [] },
  { key: "fit_occlusion", label: "Didn't fit — occlusion", category: "crown_bridge", conditionalFields: [] },
  { key: "fit_margins", label: "Didn't fit — margins", category: "crown_bridge", conditionalFields: [] },
  { key: "shade_wrong", label: "Shade was wrong", category: "crown_bridge", conditionalFields: ["shade"] },
  { key: "wrong_material_doctor", label: "Wrong material — doctor", category: "crown_bridge", conditionalFields: ["material"] },
  { key: "wrong_material_lab", label: "Wrong material — lab", category: "crown_bridge", conditionalFields: ["material"] },
  { key: "crown_broke", label: "Crown broke", category: "crown_bridge", conditionalFields: [] },
  { key: "bridge_broke", label: "Bridge broke", category: "crown_bridge", conditionalFields: [] },
  { key: "denture_broke", label: "Denture broke", category: "removable", conditionalFields: [] },
  { key: "partial_broke", label: "Partial broke", category: "removable", conditionalFields: [] },
  { key: "denture_fit_occlusion", label: "Denture didn't fit — occlusion", category: "removable", conditionalFields: [] },
  { key: "denture_fit_intaglio", label: "Denture didn't fit — intaglio", category: "removable", conditionalFields: [] },
  { key: "partial_fit_occlusion", label: "Partial didn't fit — occlusion", category: "removable", conditionalFields: [] },
  { key: "partial_fit_intaglio", label: "Partial didn't fit — intaglio", category: "removable", conditionalFields: [] },
  { key: "denture_tissue_color", label: "Denture tissue wrong color", category: "removable", conditionalFields: [] },
  { key: "partial_tissue_color", label: "Partial tissue wrong color", category: "removable", conditionalFields: [] },
  { key: "denture_material_wrong", label: "Denture wrong material", category: "removable", conditionalFields: ["material"] },
  { key: "partial_material_wrong", label: "Partial wrong material", category: "removable", conditionalFields: ["material"] },
  { key: "other", label: "Other", category: null, conditionalFields: ["customReason"] },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  category: RemakeReasonCategory | null;
  conditionalFields: readonly RemakeConditionalField[];
}>;

export type RemakeReasonKey = (typeof REMAKE_REASONS)[number]["key"];
export const REMAKE_REASON_KEYS = REMAKE_REASONS.map((reason) => reason.key) as [
  RemakeReasonKey,
  ...RemakeReasonKey[],
];
export const CUSTOM_REMAKE_REASON_MAX_LENGTH = 2000;

export function getRemakeReason(key: string | null | undefined) {
  return REMAKE_REASONS.find((reason) => reason.key === key);
}

export function remakeReasonUsesField(
  key: string | null | undefined,
  field: RemakeConditionalField,
): boolean {
  return getRemakeReason(key)?.conditionalFields.some((candidate) => candidate === field) ?? false;
}