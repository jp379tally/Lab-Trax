export const CASE_STATIONS: { value: string; label: string }[] = [
  { value: "received", label: "Received" },
  { value: "in_design", label: "In Design" },
  { value: "scan", label: "Scan" },
  { value: "in_milling", label: "In Milling" },
  { value: "post_mill", label: "Post Mill" },
  { value: "sintering_furnace", label: "Sintering Furnace" },
  { value: "model_room", label: "Model Room" },
  { value: "in_porcelain", label: "Porcelain" },
  { value: "qc", label: "Quality Check" },
  { value: "complete", label: "Complete" },
  { value: "shipped", label: "Shipping" },
  { value: "on_hold", label: "On Hold" },
  { value: "delivered", label: "Delivered" },
  { value: "remake", label: "Remake" },
];

export function stationLabelFor(value: string | null | undefined): string {
  if (!value) return "—";
  return (
    CASE_STATIONS.find((s) => s.value === value)?.label ??
    value
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase())
      .trim()
  );
}
