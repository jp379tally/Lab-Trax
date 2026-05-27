// Print layout config — persisted in localStorage under labtrax_print_layout_v1.

export type FontSize = "sm" | "md" | "lg";

export type FieldSection = "details" | "rx";

export interface PrintLayoutField {
  id: string;
  section: FieldSection;
  label: string;
  fontSize: FontSize;
  visible: boolean;
  fullWidth: boolean;
}

export interface PrintLayoutConfig {
  fields: PrintLayoutField[];
  showNotes: boolean;
  showToothChart: boolean;
}

export const DETAILS_FIELDS: PrintLayoutField[] = [
  { id: "patient",      section: "details", label: "Patient",         fontSize: "sm", visible: true,  fullWidth: false },
  { id: "doctor",       section: "details", label: "Doctor",          fontSize: "sm", visible: true,  fullWidth: false },
  { id: "status",       section: "details", label: "Status",          fontSize: "sm", visible: true,  fullWidth: false },
  { id: "priority",     section: "details", label: "Priority",        fontSize: "sm", visible: true,  fullWidth: false },
  { id: "dueDate",      section: "details", label: "Due Date",        fontSize: "sm", visible: true,  fullWidth: false },
  { id: "created",      section: "details", label: "Created",         fontSize: "sm", visible: true,  fullWidth: false },
  { id: "casePanBarcode", section: "details", label: "Case Pan Barcode", fontSize: "sm", visible: true, fullWidth: true },
];

export const RX_FIELDS: PrintLayoutField[] = [
  { id: "restorativeType", section: "rx", label: "Restorative Type",  fontSize: "sm", visible: true,  fullWidth: false },
  { id: "material",        section: "rx", label: "Material",          fontSize: "sm", visible: true,  fullWidth: false },
  { id: "shade",           section: "rx", label: "Shade",             fontSize: "sm", visible: true,  fullWidth: false },
  { id: "toothNumbers",    section: "rx", label: "Tooth Number(s)",   fontSize: "sm", visible: true,  fullWidth: true  },
];

export const DEFAULT_PRINT_LAYOUT_CONFIG: PrintLayoutConfig = {
  fields: [...DETAILS_FIELDS, ...RX_FIELDS],
  showNotes: true,
  showToothChart: true,
};

const STORAGE_KEY = "labtrax_print_layout_v1";

const VALID_FONT_SIZES: FontSize[] = ["sm", "md", "lg"];
const VALID_SECTIONS: FieldSection[] = ["details", "rx"];

function normalizeField(raw: unknown, defaults: PrintLayoutField): PrintLayoutField {
  const r = raw as Partial<PrintLayoutField>;
  return {
    id: defaults.id,
    section: VALID_SECTIONS.includes(r.section as FieldSection) ? (r.section as FieldSection) : defaults.section,
    label: typeof r.label === "string" && r.label ? r.label : defaults.label,
    fontSize: VALID_FONT_SIZES.includes(r.fontSize as FontSize) ? (r.fontSize as FontSize) : defaults.fontSize,
    visible: typeof r.visible === "boolean" ? r.visible : defaults.visible,
    fullWidth: typeof r.fullWidth === "boolean" ? r.fullWidth : defaults.fullWidth,
  };
}

export function loadPrintLayoutConfig(): PrintLayoutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRINT_LAYOUT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<PrintLayoutConfig>;
    // Merge with defaults to handle new fields added in future versions and
    // normalize any malformed field objects from corrupted localStorage entries.
    const savedFields: unknown[] = Array.isArray(parsed.fields) ? parsed.fields : [];
    const defaultMap = new Map(DEFAULT_PRINT_LAYOUT_CONFIG.fields.map((f) => [f.id, f]));
    const merged: PrintLayoutField[] = [];
    for (const sf of savedFields) {
      const id = (sf as Partial<PrintLayoutField>).id;
      const def = id ? defaultMap.get(id) : undefined;
      if (def) merged.push(normalizeField(sf, def));
    }
    // Append any defaults not present in saved config.
    for (const f of DEFAULT_PRINT_LAYOUT_CONFIG.fields) {
      if (!merged.find((m) => m.id === f.id)) merged.push(f);
    }
    return {
      fields: merged,
      showNotes: typeof parsed.showNotes === "boolean" ? parsed.showNotes : true,
      showToothChart: typeof parsed.showToothChart === "boolean" ? parsed.showToothChart : true,
    };
  } catch {
    return DEFAULT_PRINT_LAYOUT_CONFIG;
  }
}

export function savePrintLayoutConfig(config: PrintLayoutConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore storage quota errors
  }
}

export function isDefaultLayout(config: PrintLayoutConfig): boolean {
  return JSON.stringify(config) === JSON.stringify(DEFAULT_PRINT_LAYOUT_CONFIG);
}
