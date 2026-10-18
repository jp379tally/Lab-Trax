/**
 * The baseline workflow stations provisioned for a lab that has not configured
 * any locations yet. Keep this list shared by every lazy-seeding path.
 */
export const BUILT_IN_LAB_STATIONS: {
  code: string;
  name: string;
  status: string;
}[] = [
  { code: "received", name: "Received", status: "received" },
  { code: "in_design", name: "In Design", status: "in_design" },
  { code: "scan", name: "Scan", status: "scan" },
  { code: "in_milling", name: "In Milling", status: "in_milling" },
  { code: "post_mill", name: "Post Mill", status: "post_mill" },
  { code: "sintering_furnace", name: "Sintering Furnace", status: "sintering_furnace" },
  { code: "model_room", name: "Model Room", status: "model_room" },
  { code: "in_porcelain", name: "Porcelain", status: "in_porcelain" },
  { code: "qc", name: "Quality Check", status: "qc" },
  { code: "complete", name: "Complete", status: "complete" },
  { code: "shipped", name: "Shipping", status: "shipped" },
  { code: "on_hold", name: "On Hold", status: "on_hold" },
  { code: "delivered", name: "Delivered", status: "delivered" },
  { code: "remake", name: "Remake", status: "remake" },
];