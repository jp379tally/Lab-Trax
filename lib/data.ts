export type UserRole = "user" | "admin";

export type CaseStatus =
  | "INTAKE"
  | "DESIGN"
  | "SCAN"
  | "MILL"
  | "POST_MILL"
  | "SINTERING_FURNACE"
  | "MODEL_ROOM"
  | "PORCELAIN"
  | "QC"
  | "SHIP"
  | "HOLD"
  | "COMPLETE";

export const STATIONS: { id: CaseStatus; label: string; color: string }[] = [
  { id: "INTAKE", label: "Intake", color: "#2563EB" },
  { id: "DESIGN", label: "Design", color: "#F59E0B" },
  { id: "SCAN", label: "Scan", color: "#8B5CF6" },
  { id: "MILL", label: "Mill", color: "#EC4899" },
  { id: "POST_MILL", label: "Post Mill", color: "#D946EF" },
  { id: "SINTERING_FURNACE", label: "Sintering Furnace", color: "#F97316" },
  { id: "MODEL_ROOM", label: "Model Room", color: "#14B8A6" },
  { id: "PORCELAIN", label: "Porcelain", color: "#06B6D4" },
  { id: "QC", label: "Quality Check", color: "#10B981" },
  { id: "COMPLETE", label: "Complete", color: "#22C55E" },
  { id: "SHIP", label: "Shipping", color: "#6366F1" },
  { id: "HOLD", label: "On Hold", color: "#94A3B8" },
];

export type ActivityEntryType = "photo" | "note" | "station_change" | "scan" | "created" | "courtesy_text";

export type CourtesyTextStatus = "sent" | "date_requested" | "date_proposed" | "accepted" | "declined";

export interface CourtesyTextRequest {
  id: string;
  caseId: string;
  message: string;
  sentBy: string;
  sentAt: number;
  status: CourtesyTextStatus;
  wantsUpdatedDate: boolean | null;
  proposedDate?: string;
  proposedTime?: string;
  responseHistory: CourtesyTextResponse[];
}

export interface CourtesyTextResponse {
  id: string;
  type: "date_requested" | "date_proposed" | "accepted" | "declined";
  by: string;
  timestamp: number;
  proposedDate?: string;
  proposedTime?: string;
  note?: string;
}

export interface ActivityEntry {
  id: string;
  type: ActivityEntryType;
  timestamp: number;
  description: string;
  imageUri?: string;
  station?: CaseStatus;
  user?: string;
}

export type ToothType = "normal" | "bridge" | "missing";

export interface ToothEntry {
  num: number;
  type: ToothType;
}

export const MATERIAL_PRICES: Record<string, number> = {
  "Zirconia": 250,
  "E.max": 300,
  "PFM": 200,
  "Gold": 400,
  "Other": 250,
};

export type CaseTypeValue = "Restorative" | "Removable" | "Appliance" | "Temporary" | "Other" | "";

export interface LabCase {
  id: string;
  caseNumber: string;
  doctorName: string;
  patientName: string;
  patientInitials: string;
  caseType?: CaseTypeValue;
  toothIndices: string;
  shade: string;
  material: string;
  status: CaseStatus;
  isRush: boolean;
  isRemake?: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
  price: number;
  dueDate: string;
  routeHistory: { station: CaseStatus; timestamp: number }[];
  photos: string[];
  activityLog: ActivityEntry[];
  trackingNumbers?: string[];
  toothMap?: ToothEntry[];
  courtesyTexts?: CourtesyTextRequest[];
  invoiceId?: string;
  remakeReason?: string;
  assignedBarcode?: string;
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

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: "office" | "lab";
  content: string;
  imageUri?: string;
  timestamp: number;
  read: boolean;
}

export interface Conversation {
  id: string;
  clientId: string;
  clientName: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
}

export interface Group {
  id: string;
  name: string;
  type: "provider" | "lab";
  address: string;
  members: GroupMember[];
  createdAt: number;
}

export interface GroupMember {
  userId: string;
  username: string;
  role: "admin" | "user";
  joinedAt: number;
}

export interface GroupInvitation {
  id: string;
  groupId: string;
  groupName: string;
  invitedUsername: string;
  invitedBy: string;
  status: "pending" | "accepted" | "declined";
  createdAt: number;
}

export interface GroupJoinRequest {
  id: string;
  requestingUsername: string;
  targetAdminUsername: string;
  message: string;
  status: "pending" | "accepted" | "declined";
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
    caseNumber: "#4520",
    doctorName: "Dr. Aris",
    patientName: "Michael Klein",
    patientInitials: "M.K.",
    toothIndices: "#14",
    shade: "A3",
    material: "Zirconia",
    status: "QC",
    isRush: false,
    isRemake: true,
    notes: "Remake of previous crown - occlusion issue\n(REMAKE - No Charge)",
    createdAt: Date.now() - 86400000 * 10,
    updatedAt: Date.now() - 86400000 * 3,
    price: 0,
    dueDate: "2026-02-08",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 10 },
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 8 },
      { station: "PORCELAIN" as CaseStatus, timestamp: Date.now() - 86400000 * 6 },
      { station: "PORCELAIN" as CaseStatus, timestamp: Date.now() - 86400000 * 4 },
      { station: "QC", timestamp: Date.now() - 86400000 * 3 },
    ],
    photos: [],
    activityLog: [
      {
        id: generateId(),
        type: "created",
        timestamp: Date.now() - 86400000 * 10,
        description: "Remake case created - original had occlusion issue",
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
        timestamp: Date.now() - 86400000 * 3,
        description: "Case moved to QC",
        station: "QC",
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
        type: "note",
        timestamp: Date.now() - 86400000 * 2.5,
        description: "RUSH - Patient traveling 02/12. Prioritize this case.",
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
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 5 },
      { station: "PORCELAIN", timestamp: Date.now() - 86400000 * 3 },
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
        description: "Case moved to Design",
        station: "DESIGN",
      },
      {
        id: generateId(),
        type: "station_change",
        timestamp: Date.now() - 86400000 * 3,
        description: "Case moved to Porcelain",
        station: "PORCELAIN",
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
    status: "DESIGN",
    isRush: true,
    notes: "RUSH - Full anterior veneers. Minimal prep.",
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 14400000,
    price: 4200.0,
    dueDate: "2026-02-09",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 3 },
      { station: "DESIGN", timestamp: Date.now() - 14400000 },
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
        timestamp: Date.now() - 14400000,
        description: "Case moved to Design",
        station: "DESIGN",
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
      { station: "PORCELAIN", timestamp: Date.now() - 86400000 * 5 },
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
        timestamp: Date.now() - 86400000 * 5,
        description: "Case moved to Porcelain",
        station: "PORCELAIN",
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
  clientNumber: number;
  accountNumber: string;
  practiceName: string;
  leadDoctor: string;
  phone: string;
  email: string;
  address: string;
  tier: string;
  discountRate: number;
  createdAt: number;
}

export interface LabUser {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  station: string;
  active: boolean;
  createdAt: number;
}

export interface InvoiceLineItem {
  qty: number;
  item: string;
  description: string;
  rate: number;
  amount: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  caseIds: string[];
  amount: number;
  credits: number;
  status: "open" | "sent" | "paid" | "overdue";
  issuedAt: number;
  dueAt: number;
  billTo: string;
  patientName: string;
  caseType: string;
  teeth: string;
  shade: string;
  caseNotes: string;
  lineItems: InvoiceLineItem[];
}

export const SAMPLE_CLIENTS: Client[] = [
  {
    id: generateId(),
    clientNumber: 1,
    accountNumber: "DS-100001",
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
    clientNumber: 2,
    accountNumber: "DS-100002",
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
    clientNumber: 3,
    accountNumber: "DS-100003",
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
    clientNumber: 4,
    accountNumber: "DS-100004",
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
    clientNumber: 5,
    accountNumber: "DS-100005",
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
    role: "user",
    station: "Design",
    active: true,
    createdAt: Date.now() - 86400000 * 180,
  },
  {
    id: generateId(),
    name: "Sam Torres",
    email: "sam@drivesynclab.com",
    role: "user",
    station: "Porcelain",
    active: true,
    createdAt: Date.now() - 86400000 * 90,
  },
  {
    id: generateId(),
    name: "Maya Chen",
    email: "maya@drivesynclab.com",
    role: "user",
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
    credits: 0,
    status: "open",
    issuedAt: Date.now() - 86400000 * 5,
    dueAt: Date.now() + 86400000 * 25,
    billTo: "Elite Dental Group",
    patientName: "Michael Klein",
    caseType: "Crown & Bridge",
    teeth: "#8, #9, #10",
    shade: "A2",
    caseNotes: "Bridge prep - verify margins on #9",
    lineItems: [
      { qty: 3, item: "E.max Crown", description: "Anterior bridge units #8-#10", rate: 895.00, amount: 2685.00 },
      { qty: 1, item: "Custom Shade", description: "Vita A2 shade match", rate: 145.00, amount: 145.00 },
      { qty: 1, item: "Rush Fee", description: "Expedited turnaround", rate: 500.00, amount: 500.00 },
      { qty: 1, item: "Model Work", description: "Diagnostic models and articulation", rate: 500.00, amount: 500.00 },
    ],
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-002",
    clientId: SAMPLE_CLIENTS[1].id,
    clientName: "City Smiles",
    caseIds: [],
    amount: 680.0,
    credits: 0,
    status: "sent",
    issuedAt: Date.now() - 86400000 * 10,
    dueAt: Date.now() + 86400000 * 20,
    billTo: "City Smiles",
    patientName: "Sarah Johnson",
    caseType: "Single Crown",
    teeth: "#14",
    shade: "B1",
    caseNotes: "PFM crown, porcelain butt margin",
    lineItems: [
      { qty: 1, item: "PFM Crown", description: "Porcelain fused to metal crown #14", rate: 580.00, amount: 580.00 },
      { qty: 1, item: "Die & Model", description: "Working model with removable dies", rate: 100.00, amount: 100.00 },
    ],
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-003",
    clientId: SAMPLE_CLIENTS[2].id,
    clientName: "North Lab Dentistry",
    caseIds: [],
    amount: 1580.0,
    credits: 0,
    status: "overdue",
    issuedAt: Date.now() - 86400000 * 40,
    dueAt: Date.now() - 86400000 * 10,
    billTo: "North Lab Dentistry",
    patientName: "Robert Davis",
    caseType: "Implant",
    teeth: "#19, #30",
    shade: "A3",
    caseNotes: "Implant-supported crowns, verify abutment seating",
    lineItems: [
      { qty: 2, item: "Implant Crown", description: "Screw-retained implant crowns", rate: 650.00, amount: 1300.00 },
      { qty: 2, item: "Custom Abutment", description: "Titanium custom abutments", rate: 140.00, amount: 280.00 },
    ],
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2025-048",
    clientId: SAMPLE_CLIENTS[3].id,
    clientName: "Pacific Dental Care",
    caseIds: [],
    amount: 920.0,
    credits: 0,
    status: "paid",
    issuedAt: Date.now() - 86400000 * 30,
    dueAt: Date.now() - 86400000 * 1,
    billTo: "Pacific Dental Care",
    patientName: "Lisa Wang",
    caseType: "Veneer",
    teeth: "#6, #7, #8, #9, #10, #11",
    shade: "BL2",
    caseNotes: "Minimal prep veneers, matching existing laterals",
    lineItems: [
      { qty: 6, item: "Porcelain Veneer", description: "Feldspathic porcelain veneers #6-#11", rate: 120.00, amount: 720.00 },
      { qty: 1, item: "Wax-Up", description: "Diagnostic wax-up for approval", rate: 200.00, amount: 200.00 },
    ],
  },
  {
    id: generateId(),
    invoiceNumber: "INV-2026-004",
    clientId: SAMPLE_CLIENTS[4].id,
    clientName: "Sunrise Family Dental",
    caseIds: [],
    amount: 4200.0,
    credits: 0,
    status: "open",
    issuedAt: Date.now() - 86400000 * 2,
    dueAt: Date.now() + 86400000 * 28,
    billTo: "Sunrise Family Dental",
    patientName: "James Rodriguez",
    caseType: "Full Arch",
    teeth: "Upper Full Arch",
    shade: "A1",
    caseNotes: "Full arch zirconia prosthesis, implant-supported",
    lineItems: [
      { qty: 1, item: "Full Arch Zirconia", description: "Upper full arch implant prosthesis", rate: 3500.00, amount: 3500.00 },
      { qty: 4, item: "Multi-Unit Abutment", description: "Titanium multi-unit abutments", rate: 125.00, amount: 500.00 },
      { qty: 1, item: "Try-In", description: "PMMA try-in prosthesis", rate: 200.00, amount: 200.00 },
    ],
  },
];

const CONV_IDS = [generateId(), generateId(), generateId(), generateId(), generateId()];

export const SAMPLE_CONVERSATIONS: Conversation[] = [
  {
    id: CONV_IDS[0],
    clientId: SAMPLE_CLIENTS[0].id,
    clientName: SAMPLE_CLIENTS[0].practiceName,
    lastMessage: "Currently in the design phase, should be ready by Thursday",
    lastMessageTime: Date.now() - 1200000,
    unreadCount: 1,
  },
  {
    id: CONV_IDS[1],
    clientId: SAMPLE_CLIENTS[1].id,
    clientName: SAMPLE_CLIENTS[1].practiceName,
    lastMessage: "We just received the impression, looks good",
    lastMessageTime: Date.now() - 3600000,
    unreadCount: 0,
  },
  {
    id: CONV_IDS[2],
    clientId: SAMPLE_CLIENTS[2].id,
    clientName: SAMPLE_CLIENTS[2].practiceName,
    lastMessage: "Can you send a photo of the wax-up before investing?",
    lastMessageTime: Date.now() - 7200000,
    unreadCount: 2,
  },
  {
    id: CONV_IDS[3],
    clientId: SAMPLE_CLIENTS[3].id,
    clientName: SAMPLE_CLIENTS[3].practiceName,
    lastMessage: "Gold crown passed QC, shipping today",
    lastMessageTime: Date.now() - 14400000,
    unreadCount: 0,
  },
  {
    id: CONV_IDS[4],
    clientId: SAMPLE_CLIENTS[4].id,
    clientName: SAMPLE_CLIENTS[4].practiceName,
    lastMessage: "Please confirm the shade match on the veneers",
    lastMessageTime: Date.now() - 5400000,
    unreadCount: 1,
  },
];

export const SAMPLE_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: generateId(),
    conversationId: CONV_IDS[0],
    senderId: SAMPLE_CLIENTS[0].id,
    senderType: "office",
    content: "Hi, checking on case #4521 status?",
    timestamp: Date.now() - 3600000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[0],
    senderId: "lab",
    senderType: "lab",
    content: "Currently in the design phase, should be ready by Thursday",
    timestamp: Date.now() - 1800000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[0],
    senderId: SAMPLE_CLIENTS[0].id,
    senderType: "office",
    content: "Great, the patient is asking about the shade. Can you double check A2?",
    timestamp: Date.now() - 1200000,
    read: false,
  },

  {
    id: generateId(),
    conversationId: CONV_IDS[1],
    senderId: SAMPLE_CLIENTS[1].id,
    senderType: "office",
    content: "Sending over the Zirconia crown impression for case #4522",
    timestamp: Date.now() - 7200000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[1],
    senderId: "lab",
    senderType: "lab",
    content: "We just received the impression, looks good",
    timestamp: Date.now() - 3600000,
    read: true,
  },

  {
    id: generateId(),
    conversationId: CONV_IDS[2],
    senderId: SAMPLE_CLIENTS[2].id,
    senderType: "office",
    content: "How is the PFM bridge coming along for Robert Lang?",
    timestamp: Date.now() - 14400000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[2],
    senderId: "lab",
    senderType: "lab",
    content: "Moving through porcelain now. Rush case so we prioritized it.",
    timestamp: Date.now() - 10800000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[2],
    senderId: SAMPLE_CLIENTS[2].id,
    senderType: "office",
    content: "Can you send a photo of the wax-up before investing?",
    timestamp: Date.now() - 7200000,
    read: false,
    imageUri: "",
  },

  {
    id: generateId(),
    conversationId: CONV_IDS[3],
    senderId: SAMPLE_CLIENTS[3].id,
    senderType: "office",
    content: "Any update on the gold crown for Amanda Wells?",
    timestamp: Date.now() - 28800000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[3],
    senderId: "lab",
    senderType: "lab",
    content: "Gold crown passed QC, shipping today",
    timestamp: Date.now() - 14400000,
    read: true,
  },

  {
    id: generateId(),
    conversationId: CONV_IDS[4],
    senderId: SAMPLE_CLIENTS[4].id,
    senderType: "office",
    content: "The veneer case for Tyler Hughes - is BL2 the right shade?",
    timestamp: Date.now() - 10800000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[4],
    senderId: "lab",
    senderType: "lab",
    content: "BL2 confirmed per the prescription. Working on the wax-up now.",
    timestamp: Date.now() - 7200000,
    read: true,
  },
  {
    id: generateId(),
    conversationId: CONV_IDS[4],
    senderId: SAMPLE_CLIENTS[4].id,
    senderType: "office",
    content: "Please confirm the shade match on the veneers",
    timestamp: Date.now() - 5400000,
    read: false,
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

export type PricingTier = {
  id: string;
  name: string;
  prices: Record<string, number>;
};

export const SHADE_OPTIONS = ["A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D2", "D3", "D4", "0M1", "0M2", "0M3", "BL1", "BL2", "BL3", "Custom", "Other"];

export const DEFAULT_TIER_ITEMS = [
  { key: "zirconia_crown", label: "Zirconia Crown" },
  { key: "emax_crown", label: "E.max Crown" },
  { key: "pfm_crown", label: "PFM Crown" },
  { key: "denture", label: "Denture" },
  { key: "partial", label: "Partial" },
  { key: "implant", label: "Implant" },
];

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  minQuantity: number;
  unit: string;
  supplier?: string;
  lastOrdered?: number;
  notes?: string;
}

export const sampleInventory: InventoryItem[] = [
  { id: generateId(), name: "Porcelain Powder - A2", category: "Materials", quantity: 45, minQuantity: 10, unit: "bottles" },
  { id: generateId(), name: "Zirconia Discs - 98mm", category: "Materials", quantity: 12, minQuantity: 5, unit: "discs" },
  { id: generateId(), name: "Impression Trays - Medium", category: "Supplies", quantity: 200, minQuantity: 50, unit: "pcs" },
  { id: generateId(), name: "Diamond Burs - Fine", category: "Tools", quantity: 8, minQuantity: 15, unit: "pcs" },
  { id: generateId(), name: "Casting Alloy - Noble", category: "Materials", quantity: 3, minQuantity: 2, unit: "oz" },
  { id: generateId(), name: "Wax Sheets - Blue", category: "Materials", quantity: 30, minQuantity: 10, unit: "sheets" },
  { id: generateId(), name: "Articulating Paper", category: "Supplies", quantity: 150, minQuantity: 50, unit: "strips" },
  { id: generateId(), name: "Plaster - Type IV", category: "Materials", quantity: 5, minQuantity: 3, unit: "bags" },
  { id: generateId(), name: "Disposable Gloves - M", category: "Supplies", quantity: 500, minQuantity: 100, unit: "pcs" },
  { id: generateId(), name: "Polishing Wheels", category: "Tools", quantity: 22, minQuantity: 10, unit: "pcs" },
];

export const DEFAULT_PRICING_TIERS: PricingTier[] = [
  {
    id: "corporate",
    name: "Corporate",
    prices: { zirconia_crown: 0, emax_crown: 0, pfm_crown: 0, denture: 0, partial: 0, implant: 0 },
  },
  {
    id: "economy",
    name: "Economy",
    prices: { zirconia_crown: 0, emax_crown: 0, pfm_crown: 0, denture: 0, partial: 0, implant: 0 },
  },
  {
    id: "standard",
    name: "Standard",
    prices: { zirconia_crown: 0, emax_crown: 0, pfm_crown: 0, denture: 0, partial: 0, implant: 0 },
  },
  {
    id: "premium",
    name: "Premium",
    prices: { zirconia_crown: 0, emax_crown: 0, pfm_crown: 0, denture: 0, partial: 0, implant: 0 },
  },
];
