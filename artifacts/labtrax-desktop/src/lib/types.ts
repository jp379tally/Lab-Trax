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
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  notes?: string | null;
  items?: InvoiceLineItem[];
  payments?: Payment[];
}

export interface Organization {
  id: string;
  type: string;
  name: string;
  displayName?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
}

export interface Membership {
  id: string;
  role: string;
  status: string;
  organizationId: string;
  organization: Organization | null;
}
