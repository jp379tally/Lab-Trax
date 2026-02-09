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

export interface LabCase {
  id: string;
  caseNumber: string;
  doctorName: string;
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
  },
  {
    id: generateId(),
    caseNumber: "#4522",
    doctorName: "Dr. Bloom",
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
  },
  {
    id: generateId(),
    caseNumber: "#4518",
    doctorName: "Dr. Chen",
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
  },
  {
    id: generateId(),
    caseNumber: "#4515",
    doctorName: "Dr. Patel",
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
  },
  {
    id: generateId(),
    caseNumber: "#4510",
    doctorName: "Dr. Martinez",
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
    dueDate: "2026-02-11",
    routeHistory: [
      { station: "INTAKE", timestamp: Date.now() - 86400000 * 3 },
      { station: "DESIGN", timestamp: Date.now() - 86400000 * 2 },
      { station: "WAX", timestamp: Date.now() - 14400000 },
    ],
  },
  {
    id: generateId(),
    caseNumber: "#4508",
    doctorName: "Dr. Kim",
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
    dueDate: "2026-02-10",
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
