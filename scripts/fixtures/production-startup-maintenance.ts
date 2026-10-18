import { registerHistoricalStartupJobs } from "../../artifacts/api-server/src/lib/startup-maintenance.ts";

const state = {
  completionFlags: [] as string[],
  vendorId: null as string | null,
  dueDate: "2026-10-20",
  expectedDeliveryDate: "2026-10-10" as string | null,
  restorationRows: ["upper", "lower"],
  invoiceStatus: "draft",
  invoices: [] as string[],
  mediaFiles: ["case-photo.jpg"],
  mediaReference: "case-photo.jpg",
};

const jobs = [
  {
    name: "vendor linking",
    schedule: () => { state.vendorId = "inferred-vendor"; },
  },
  {
    name: "date clearing",
    schedule: () => { state.expectedDeliveryDate = null; },
  },
  {
    name: "restoration collapse",
    schedule: () => { state.restorationRows.splice(1); },
  },
  {
    name: "invoice status conversion",
    schedule: () => { state.invoiceStatus = "open"; },
  },
  {
    name: "invoice reconstruction",
    schedule: () => { state.invoices.push("new-historical-invoice"); },
  },
  {
    name: "media repair and cleanup",
    schedule: () => { state.mediaFiles.splice(0); },
  },
];

// Deliberately leave the one-time completion markers absent. The registration
// gate must decide before a job can query a flag or reach a database/storage writer.
const result = registerHistoricalStartupJobs(jobs);
process.stdout.write(JSON.stringify({ result, state }));
