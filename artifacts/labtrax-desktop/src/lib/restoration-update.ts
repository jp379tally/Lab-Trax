export interface RestorationUpdateInput {
  newToothNumber: string;
  material?: string;
  restorationSubtype?: string;
  shade?: string;
  restorationType?: "Crown" | "Pontic";
}

export function buildRestorationUpdateBody(
  update: RestorationUpdateInput,
): {
  toothNumber: string;
  material?: string;
  restorationSubtype?: string;
  shade?: string;
  restorationType?: "Crown" | "Pontic";
} {
  return {
    toothNumber: update.newToothNumber,
    ...(update.restorationType ? { restorationType: update.restorationType, quantity: 1 } : {}),
    ...(update.material ? { material: update.material } : {}),
    ...(update.restorationSubtype
      ? { restorationSubtype: update.restorationSubtype }
      : {}),
    ...(update.shade ? { shade: update.shade } : {}),
  };
}
