export type CaseStatus =
  | "received"
  | "in_design"
  | "in_milling"
  | "in_porcelain"
  | "qc"
  | "shipped"
  | "delivered"
  | "on_hold"
  | "remake"
  | "cancelled";

export type CasePriority = "normal" | "rush";

export interface LabCase {
  id: string;
  caseNumber: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  patientFirstName: string;
  patientLastName: string;
  externalPatientId?: string | null;
  doctorName: string;
  status: CaseStatus;
  priority: CasePriority;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  restorationCount?: number;
  restorationTypes?: string | null;
  restorationMaterials?: string | null;
  teeth?: string | null;
  totalPrice?: string | number | null;
  restorations?: CaseRestoration[];
}

export interface CaseRestoration {
  id: string;
  caseId: string;
  toothNumber: string;
  restorationType: string;
  material?: string | null;
  shade?: string | null;
  notes?: string | null;
  quantity: number;
  unitPrice: string | number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CaseEvent {
  id: string;
  caseId: string;
  eventType: string;
  actorUserId?: string | null;
  actorOrganizationId?: string | null;
  actorInitials?: string | null;
  metadataJson?: Record<string, unknown> | null;
  occurredAt?: string | null;
  createdAt?: string | null;
}

export type InvoiceStatus =
  | "draft"
  | "open"
  | "partially_paid"
  | "paid"
  | "void"
  | "overdue";

export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  caseRestorationId?: string | null;
  description: string;
  quantity: number;
  unitPrice: string | number;
  lineTotal: string | number;
  sortOrder: number;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: string | number;
  method?: string | null;
  reference?: string | null;
  paidAt?: string | null;
  notes?: string | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  caseId?: string | null;
  labOrganizationId: string;
  providerOrganizationId: string;
  status: InvoiceStatus;
  subtotal?: string | number | null;
  tax?: string | number | null;
  discount?: string | number | null;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  notes?: string | null;
  items?: InvoiceLineItem[];
  payments?: Payment[];
  providerOrganization?: { id: string; name: string } | null;
  labOrganization?: { id: string; name: string } | null;
}

export interface Organization {
  id: string;
  type: string;
  name: string;
  displayName?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  isActive?: boolean;
  createdByUserId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Membership {
  id: string;
  role: string;
  status: string;
  organizationId: string;
  organization: Organization | null;
}

export interface MeResponse {
  user: {
    id: string;
    username: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
    practiceName?: string | null;
  };
  memberships: Membership[];
}
