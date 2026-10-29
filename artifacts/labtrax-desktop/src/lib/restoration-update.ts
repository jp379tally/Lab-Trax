export interface RestorationUpdateInput {
  newToothNumber: string;
  material?: string;
  restorationSubtype?: string;
  shade?: string;
  restorationType?: string;
  arch?: "upper" | "lower" | null;
}

export function buildRestorationUpdateBody(
  update: RestorationUpdateInput,
): {
  toothNumber: string;
  material?: string;
  restorationSubtype?: string;
  shade?: string;
  restorationType?: string;
  arch?: "upper" | "lower" | null;
} {
  return {
    toothNumber: update.newToothNumber,
    ...(update.arch !== undefined ? { arch: update.arch } : {}),
    ...(update.restorationType ? { restorationType: update.restorationType, quantity: 1 } : {}),
    ...(update.material ? { material: update.material } : {}),
    ...(update.restorationSubtype
      ? { restorationSubtype: update.restorationSubtype }
      : {}),
    ...(update.shade !== undefined ? { shade: update.shade } : {}),
  };
}
