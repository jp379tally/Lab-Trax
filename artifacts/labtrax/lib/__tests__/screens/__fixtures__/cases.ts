// Shared fixtures for screen smoke tests. Built once at module load with a
// stable epoch so snapshot diffs stay deterministic.
import type {
  ActivityEntry,
  Client,
  Invoice,
  LabCase,
} from "@/lib/data";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const baseActivity = (
  id: string,
  ts: number,
  type: ActivityEntry["type"],
  description: string,
  extra: Partial<ActivityEntry> = {},
): ActivityEntry => ({ id, type, timestamp: ts, description, ...extra });

export const inProgressCase: LabCase = {
  id: "case-in-progress",
  caseNumber: "#5001",
  doctorName: "Dr. Smith",
  patientName: "Jane Doe",
  patientInitials: "JD",
  caseType: "Restorative",
  toothIndices: "8,9",
  shade: "A2",
  material: "Zirconia",
  status: "in_design",
  isRush: false,
  notes: "Standard zirconia crown",
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - DAY,
  price: 500,
  dueDate: "2024-01-15",
  routeHistory: [
    { station: "received", timestamp: NOW - 2 * DAY },
    { station: "in_design", timestamp: NOW - DAY },
  ],
  photos: ["file:///tmp/photo-1.jpg"],
  videos: [],
  activityLog: [
    baseActivity("a1", NOW - 2 * DAY, "created", "Case created at Intake", {
      station: "received",
      user: "AB",
    }),
    baseActivity("a2", NOW - DAY, "station_change", "Moved to Design", {
      station: "in_design",
      user: "AB",
    }),
    baseActivity("a3", NOW - DAY / 2, "note", "Initial impression looks good", {
      user: "AB",
    }),
  ],
  toothMap: [
    { num: 8, type: "normal" },
    { num: 9, type: "normal" },
  ],
};

export const completedCaseWithInvoice: LabCase = {
  ...inProgressCase,
  id: "case-completed",
  caseNumber: "#5002",
  status: "complete",
  invoiceId: "inv-5002",
  routeHistory: [
    ...inProgressCase.routeHistory,
    { station: "qc", timestamp: NOW - DAY / 2 },
    { station: "complete", timestamp: NOW - DAY / 4 },
  ],
  activityLog: [
    ...inProgressCase.activityLog,
    baseActivity("a4", NOW - DAY / 4, "station_change", "Marked Complete", {
      station: "complete",
      user: "AB",
    }),
  ],
};

export const aiImportedCase: LabCase = {
  ...inProgressCase,
  id: "case-ai",
  caseNumber: "#5003",
  patientName: "Sam AI",
  patientInitials: "SA",
};

export const sampleInvoice: Invoice = {
  id: "inv-5002",
  invoiceNumber: "INV-2024-002",
  clientId: "client-1",
  clientName: "Dr. Smith",
  caseIds: ["case-completed"],
  amount: 500,
  credits: 0,
  status: "paid",
  issuedAt: NOW - DAY / 4,
  dueAt: NOW + 30 * DAY,
  billTo: "Dr. Smith",
  patientName: "Jane Doe",
  caseType: "Restorative",
  teeth: "8,9",
  shade: "A2",
  caseNotes: "Standard zirconia crown",
  lineItems: [
    {
      qty: 2,
      item: "Zirconia Restorative",
      description: "Zirconia restoration - teeth 8,9",
      rate: 250,
      amount: 500,
    },
  ],
};

export const sampleClient: Client = {
  id: "client-1",
  clientNumber: 1,
  accountNumber: "DS-100001",
  practiceName: "Smith Dental",
  leadDoctor: "Dr. Smith",
  phone: "(555) 111-2222",
  email: "office@smithdental.com",
  address: "123 Main St",
  tier: "Standard",
  discountRate: 0,
  createdAt: NOW - 30 * DAY,
};
