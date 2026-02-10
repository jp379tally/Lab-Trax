export type UserRole = "tech" | "admin";

export type CaseStatus =
  | "INTAKE"
  | "DESIGN"
  | "WAX"
  | "INVEST"
  | "CAST"
  | "FINISH"
  | "PORCELAIN"
  | "GLAZE"
  | "QC"
  | "SHIP"
  | "HOLD"
  | "COMPLETE";

export const STATIONS: { id: CaseStatus; label: string; color: string }[] = [
  { id: "INTAKE", label: "Intake", color: "#2563EB" },
  { id: "DESIGN", label: "Design", color: "#F59E0B" },
  { id: "WAX", label: "Wax-Up", color: "#8B5CF6" },
  { id: "INVEST", label: "Invest", color: "#EC4899" },
  { id: "CAST", label: "Cast", color: "#EF4444" },
  { id: "FINISH", label: "Finish", color: "#F97316" },
  { id: "PORCELAIN", label: "Porcelain", color: "#06B6D4" },
  { id: "GLAZE", label: "Glaze", color: "#14B8A6" },
  { id: "QC", label: "Quality Check", color: "#10B981" },
  { id: "SHIP", label: "Shipping", color: "#6366F1" },
  { id: "HOLD", label: "On Hold", color: "#94A3B8" },
  { id: "COMPLETE", label: "Complete", color: "#22C55E" },
];

export type ActivityEntryType = "photo" | "note" | "station_change" | "scan" | "created";

export interface ActivityEntry {
  id: string;
  type: ActivityEntryType;
  timestamp: number;
  description: string;
  imageUri?: string;
  station?: CaseStatus;
  user?: string;
}

export interface LabCase {
  id: string;
  caseNumber: string;
  doctorName: string;
  patientName: string;
  patientInitials: string;
  toothIndices: string;
  shade: string;
  material: string;
  status: CaseStatus;
  isRush: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
  price: number;
  dueDate: string;
  routeHistory: { station: CaseStatus; timestamp: number }[];
  photos: string[];
  activityLog: ActivityEntry[];
  trackingNumbers?: string[];
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: "rush" | "update" | "complete" | "alert";
  caseId?: string;
  read: boolean;
  timestamp: number;
}

export interface ShippingAccount {
  id: string;
  companyName: string;
  accountNumber: string;
  createdAt: number;
}

export function getStationInfo(status: CaseStatus) {
  return STATIONS.find((s) => s.id === status) || STATIONS[0];
}

export function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export const SAMPLE_CASES: LabCase[] = [
  {
    id: generateId(),
    caseNumber: "#4521",
    doctorName: "Dr. Aris",
    patientName: "Michael Klein",
    patientInitials: "M.K.",
    toothIndices: "#8, #9, #10",
    shade: "A2",
    material: "E.max",
    status: "DESIGN",
    isRush: false,
    notes: "Bridge prep - verify margins",
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 3600000,
    price: 1250.0,
    dueDate: "2026-02-14",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 2 },
      { station: "DESIGN", timestamp: Date.now() - 3600000 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 2,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
      {
        id: generateId(),
        type: "note",
        timestamp: Date.now() - 86400000 * 1.5,
        description: "Patient prefers slightly warmer shade, adjust to A2+",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 3600000,
        description: "Case moved to Design",
        station: "DESIGN",
      },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4522",
    doctorName: "Dr. Bloom",
    patientName: "Jessica Stone",
    patientInitials: "J.S.",
    toothIndices: "#3",
    shade: "B1",
    material: "Zirconia",
    status: "INTAKE",
    isRush: false,
    notes: "",
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 3600000,
    price: 680.0,
    dueDate: "2026-02-16",
    routeHistory: [{ station: "INTAKE", timestamp: Date.now() - 3600000 }],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 3600000,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4518",
    doctorName: "Dr. Chen",
    patientName: "Robert Lang",
    patientInitials: "R.L.",
    toothIndices: "#19, #20",
    shade: "A3",
    material: "PFM",
    status: "PORCELAIN",
    isRush: true,
    notes: "RUSH - Patient traveling 02/12",
    createdAt: Date.now() - 86400000 * 5,
    updatedAt: Date.now() - 7200000,
    price: 1580.0,
    dueDate: "2026-02-12",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 5 },
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 4 },
      { station: "WAX", timestamp: Date.now() - 86400000 * 3 },
      { station: "INVEST", timestamp: Date.now() - 86400000 * 2 },
      { station: "CAST", timestamp: Date.now() - 86400000 },
      { station: "PORCELAIN", timestamp: Date.now() - 7200000 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 5,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 4,
        description: "Case moved to Design",
        station: "DESIGN",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 3,
        description: "Case moved to Wax-Up",
        station: "WAX",
      },
      {
        id: generateId(),
        type: "note",
        timestamp: Date.now() - 86400000 * 2.5,
        description: "RUSH - Patient traveling 02/12. Prioritize this case.",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 2,
        description: "Case moved to Invest",
        station: "INVEST",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000,
        description: "Case moved to Cast",
        station: "CAST",
      },
      {
        id: generateId(),
        type: "note",
        timestamp: Date.now() - 43200000,
        description: "Shade verified against Vita guide - A3 confirmed",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 7200000,
        description: "Case moved to Porcelain",
        station: "PORCELAIN",
      },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4515",
    doctorName: "Dr. Patel",
    patientName: "Amanda Wells",
    patientInitials: "A.W.",
    toothIndices: "#14",
    shade: "C2",
    material: "Gold",
    status: "QC",
    isRush: false,
    notes: "Full gold crown - check occlusion",
    createdAt: Date.now() - 86400000 * 7,
    updatedAt: Date.now() - 1800000,
    price: 920.0,
    dueDate: "2026-02-13",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 7 },
      { station: "WAX", timestamp: Date.now() - 86400000 * 5 },
      { station: "INVEST", timestamp: Date.now() - 86400000 * 4 },
      { station: "CAST", timestamp: Date.now() - 86400000 * 3 },
      { station: "FINISH", timestamp: Date.now() - 86400000 * 2 },
      { station: "QC", timestamp: Date.now() - 1800000 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 7,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 5,
        description: "Case moved to Wax-Up",
        station: "WAX",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 4,
        description: "Case moved to Invest",
        station: "INVEST",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 3,
        description: "Case moved to Cast",
        station: "CAST",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 2,
        description: "Case moved to Finish",
        station: "FINISH",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 1800000,
        description: "Case moved to Quality Check",
        station: "QC",
      },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4510",
    doctorName: "Dr. Martinez",
    patientName: "Tyler Hughes",
    patientInitials: "T.H.",
    toothIndices: "#6, #7, #8, #9, #10, #11",
    shade: "BL2",
    material: "E.max",
    status: "WAX",
    isRush: true,
    notes: "RUSH - Full anterior veneers. Minimal prep.",
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 14400000,
    price: 4200.0,
    dueDate: "2026-02-09",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 3 },
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 2 },
      { station: "WAX", timestamp: Date.now() - 14400000 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 3,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 2,
        description: "Case moved to Design",
        station: "DESIGN",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 14400000,
        description: "Case moved to Wax-Up",
        station: "WAX",
      },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4508",
    doctorName: "Dr. Kim",
    patientName: "Lisa Barton",
    patientInitials: "L.B.",
    toothIndices: "#30",
    shade: "A3.5",
    material: "Zirconia",
    status: "SHIP",
    isRush: false,
    notes: "Standard single crown",
    createdAt: Date.now() - 86400000 * 10,
    updatedAt: Date.now() - 900000,
    price: 720.0,
    dueDate: "2026-02-09",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 10 },
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 8 },
      { station: "WAX", timestamp: Date.now() - 86400000 * 6 },
      { station: "INVEST", timestamp: Date.now() - 86400000 * 5 },
      { station: "CAST", timestamp: Date.now() - 86400000 * 4 },
      { station: "FINISH", timestamp: Date.now() - 86400000 * 3 },
      { station: "QC", timestamp: Date.now() - 86400000 * 2 },
      { station: "SHIP", timestamp: Date.now() - 900000 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 10,
        description: "Case created and scanned in at Intake",
        station: "INTAKE",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 8,
        description: "Case moved to Design",
        station: "DESIGN",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 6,
        description: "Case moved to Wax-Up",
        station: "WAX",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 5,
        description: "Case moved to Invest",
        station: "INVEST",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 4,
        description: "Case moved to Cast",
        station: "CAST",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 3,
        description: "Case moved to Finish",
        station: "FINISH",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 2,
        description: "Case moved to Quality Check",
        station: "QC",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 900000,
        description: "Case moved to Shipping",
        station: "SHIP",
      },
    ],
  },
];

export interface Client {
  id: string;
  practiceName: string;
  leadDoctor: string;
  phone: string;
  email: string;
  address: string;
  tier: "Standard" | "Premium" | "Elite";
  discountRate: number;
  createdAt: number;
}

export interface LabUser {
  id: string;
  name: string;
  email: string;
  role: "tech" | "admin";
  station: string;
  active: boolean;
  createdAt: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  caseIds: string[];
  amount: number;
  status: "open" | "sent" | "paid" | "overdue";
  issuedAt: number;
  dueAt: number;
}

export const SAMPLE_CLIENTS: Client[] = [
  {
    id: generateId(),
    practiceName: "Elite Dental Group",
    leadDoctor: "Dr. Aris",
    phone: "(555) 100-2000",
    email: "front@elitedental.com",
    address: "1200 Park Ave, Suite 400, New York, NY 10128",
    tier: "Elite",
    discountRate: 15,
    createdAt: Date.now() - 86400000 * 90,
  },
  {
    id: generateId(),
    practiceName: "City Smiles",
    leadDoctor: "Dr. Bloom",
    phone: "(555) 200-3000",
    email: "office@citysmiles.com",
    address: "345 Market St, Floor 2, San Francisco, CA 94105",
    tier: "Premium",
    discountRate: 10,
    createdAt: Date.now() - 86400000 * 60,
  },
  {
    id: generateId(),
    practiceName: "North Lab Dentistry",
    leadDoctor: "Dr. Chen",
    phone: "(555) 300-4000",
    email: "info@northlabdent.com",
    address: "890 Elm St, Chicago, IL 60614",
    tier: "Standard",
    discountRate: 0,
    createdAt: Date.now() - 86400000 * 30,
  },
  {
    id: generateId(),
    practiceName: "Pacific Dental Care",
    leadDoctor: "Dr. Patel",
    phone: "(555) 400-5000",
    email: "hello@pacificdental.com",
    address: "2100 Ocean Blvd, Suite 110, Los Angeles, CA 90015",
    tier: "Premium",
    discountRate: 10,
    createdAt: Date.now() - 86400000 * 120,
  },
  {
    id: generateId(),
    practiceName: "Sunrise Family Dental",
    leadDoctor: "Dr. Martinez",
    phone: "(555) 500-6000",
    email: "contact@sunrisedental.com",
    address: "456 Sunrise Blvd, Miami, FL 33101",
    tier: "Elite",
    discountRate: 15,
    createdAt: Date.now() - 86400000 * 200,
  },
];

export const SAMPLE_USERS: LabUser[] = [
  {
    id: generateId(),
    name: "Alex Rivera",
    email: "alex@drivesynclab.com",
    role: "admin",
    station: "All",
    active: true,
    createdAt: Date.now() - 86400000 * 365,
  },
  {
    id: generateId(),
    name: "Jordan Lee",
    email: "jordan@drivesynclab.com",
    role: "tech",
    station: "Design",
    active: true,
    createdAt: Date.now() - 86400000 * 180,
  },
  {
    id: generateId(),
    name: "Sam Torres",
    email: "sam@drivesynclab.com",
    role: "tech",
    station: "Porcelain",
    active: true,
    createdAt: Date.now() - 86400000 * 90,
  },
  {
    id: generateId(),
    name: "Maya Chen",
    email: "maya@drivesynclab.com",
    role: "tech",
    station: "Wax-Up",
    active: false,
    createdAt: Date.now() - 86400000 * 60,
  },
];

export const SAMPLE_INVOICES: Invoice[] = [
  {
    id: generateId(),
    invoiceNumber: "INV-2026-001",
    clientId: SAMPLE_CLIENTS[0].id,
    clientName: "Elite Dental Group",
    caseIds: [],
    amount: 3830.0,
    status: "open",
    issuedAt: Date.now() - 86400000 * 5,
    dueAt: Date.now() + 86400000 * 25,
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-002",
    clientId: SAMPLE_CLIENTS[1].id,
    clientName: "City Smiles",
    caseIds: [],
    amount: 680.0,
    status: "sent",
    issuedAt: Date.now() - 86400000 * 10,
    dueAt: Date.now() + 86400000 * 20,
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-003",
    clientId: SAMPLE_CLIENTS[2].id,
    clientName: "North Lab Dentistry",
    caseIds: [],
    amount: 1580.0,
    status: "overdue",
    issuedAt: Date.now() - 86400000 * 40,
    dueAt: Date.now() - 86400000 * 10,
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2025-048",
    clientId: SAMPLE_CLIENTS[3].id,
    clientName: "Pacific Dental Care",
    caseIds: [],
    amount: 920.0,
    status: "paid",
    issuedAt: Date.now() - 86400000 * 30,
    dueAt: Date.now() - 86400000 * 1,
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-004",
    clientId: SAMPLE_CLIENTS[4].id,
    clientName: "Sunrise Family Dental",
    caseIds: [],
    amount: 4200.0,
    status: "open",
    issuedAt: Date.now() - 86400000 * 2,
    dueAt: Date.now() + 86400000 * 28,
  },
];

export const SAMPLE_NOTIFICATIONS: Notification[] = [
  {
    id: generateId(),
    title: "Rush Alert",
    message: "Case #4518 (Dr. Chen) due in 3 days - currently at Porcelain",
    type: "rush",
    caseId: SAMPLE_CASES[2].id,
    read: false,
    timestamp: Date.now() - 1800000,
  },
  {
    id: generateId(),
    title: "Station Update",
    message: "Case #4515 moved to Quality Check",
    type: "update",
    caseId: SAMPLE_CASES[3].id,
    read: false,
    timestamp: Date.now() - 3600000,
  },
  {
    id: generateId(),
    title: "Rush Alert",
    message:
      "Case #4510 (Dr. Martinez) - anterior veneers due 02/11, currently at Wax",
    type: "rush",
    caseId: SAMPLE_CASES[4].id,
    read: true,
    timestamp: Date.now() - 7200000,
  },
  {
    id: generateId(),
    title: "Ready to Ship",
    message: "Case #4508 (Dr. Kim) has passed QC and is ready for shipping",
    type: "complete",
    caseId: SAMPLE_CASES[5].id,
    read: true,
    timestamp: Date.now() - 14400000,
  },
];
