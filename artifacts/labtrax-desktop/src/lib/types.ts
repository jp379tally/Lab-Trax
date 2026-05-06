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
  /** "mobile" when this case originated from the mobile app's lab_cases table */
  _source?: "mobile";
}

export type RestorationPriceSource = "default" | "tier" | "override" | "manual";

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
  priceSource?: RestorationPriceSource | null;
  priceSourceId?: string | null;
  priceSourceName?: string | null;
  priceKey?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PricingTier {
  id: string;
  labOrganizationId: string;
  name: string;
  prices: Record<string, number>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PricingOverride {
  id: string;
  labOrganizationId: string;
  doctorName: string;
  practiceName?: string | null;
  providerOrganizationId?: string | null;
  tierName?: string | null;
  prices: Record<string, number>;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PricingHistoryEntry {
  id: string;
  action: string;
  createdAt?: string | null;
  userId?: string | null;
  userName?: string | null;
  beforePrices?: Record<string, number | string> | null;
  afterPrices?: Record<string, number | string> | null;
  beforeName?: string | null;
  afterName?: string | null;
  beforeDoctorName?: string | null;
  afterDoctorName?: string | null;
  beforePracticeName?: string | null;
  afterPracticeName?: string | null;
  beforeNotes?: string | null;
  afterNotes?: string | null;
}

export interface CaseAttachment {
  id: string;
  caseId: string;
  uploadedByUserId: string;
  uploadedByOrganizationId: string;
  fileName: string;
  storageKey: string;
  fileType: string;
  visibility?: string | null;
  createdAt?: string | null;
  uploaderName?: string | null;
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

export interface InvoiceDisplayMetadata {
  patientName?: string | null;
  billTo?: string | null;
  teeth?: string | null;
  shade?: string | null;
  caseNotes?: string | null;
  caseType?: string | null;
  clientName?: string | null;
  credits?: number | null;
  lineItems?: Array<{ item?: string | null; description?: string | null }> | null;
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
  displayMetadata?: InvoiceDisplayMetadata | null;
  displayMetadataJson?: InvoiceDisplayMetadata | null;
  items?: InvoiceLineItem[];
  payments?: Payment[];
  providerOrganization?: { id: string; name: string } | null;
  labOrganization?: { id: string; name: string } | null;
  linkedTransactions?: Array<{
    id: string;
    bankAccountId: string;
    txnDate: string;
    payee?: string | null;
    memo?: string | null;
    creditAmount: string | number;
    debitAmount: string | number;
    source: string;
    accountName?: string | null;
  }>;
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

export interface BankAccount {
  id: string;
  labOrganizationId: string;
  name: string;
  institution?: string | null;
  last4?: string | null;
  openingBalance: string | number;
  currency: string;
  isArchived: boolean;
  bookBalance?: string | number;
  clearedBalance?: string | number;
  unreconciledBalance?: string | number;
  createdAt?: string | null;
}

export interface TransactionCategory {
  id: string;
  labOrganizationId: string;
  name: string;
  kind: "income" | "expense" | "transfer";
  color?: string | null;
  isArchived: boolean;
}

export interface BankTransaction {
  id: string;
  labOrganizationId: string;
  bankAccountId: string;
  txnDate: string;
  type: string;
  checkNumber?: string | null;
  payee?: string | null;
  memo?: string | null;
  categoryId?: string | null;
  debitAmount: string;
  creditAmount: string;
  netAmount: string;
  cleared: boolean;
  reconciled: boolean;
  status: "posted" | "projected" | "void";
  source: string;
  runningBalance?: string;
  importBatchId?: string | null;
  recurringRuleId?: string | null;
  transferGroupId?: string | null;
  createdAt?: string | null;
  invoices?: Array<{ invoiceId: string; invoiceNumber: string }>;
}

export interface RecurringRule {
  id: string;
  labOrganizationId: string;
  bankAccountId: string;
  name: string;
  payee?: string | null;
  memo?: string | null;
  categoryId?: string | null;
  direction: "debit" | "credit";
  amount?: string | null;
  estimateMethod: "fixed" | "avg_last_3";
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  dayOfMonth: number;
  startDate: string;
  endDate?: string | null;
  autoCreate: boolean;
  isActive: boolean;
  lastGeneratedFor?: string | null;
}

export interface Reconciliation {
  id: string;
  labOrganizationId: string;
  bankAccountId: string;
  statementDate: string;
  startingBalance: string;
  endingBalance: string;
  clearedTotal: string;
  difference: string;
  status: string;
  completedAt?: string | null;
  createdAt?: string | null;
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
