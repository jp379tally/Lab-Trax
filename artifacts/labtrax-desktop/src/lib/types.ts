export type CaseStatus =
  | "received"
  | "in_design"
  | "scan"
  | "in_milling"
  | "post_mill"
  | "sintering_furnace"
  | "model_room"
  | "in_porcelain"
  | "qc"
  | "complete"
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
  /** Initials-only patient identifier, populated for legacy/mobile-originated cases where full name is unavailable. */
  patientInitials?: string | null;
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
  /**
   * True when the case was auto-created by an AI import (e.g. from iTero
   * Lab-Review) and a human still needs to verify the extracted fields.
   * Cleared via PATCH /cases/:id/ai-review.
   */
  needsAiReview?: boolean;
  /** Identifier of the upstream import source, e.g. "itero". */
  aiImportSource?: string | null;
  /** When this case is a remake of another, that original's id. */
  remakeOfCaseId?: string | null;
  /** Free-text reason captured at remake creation. */
  remakeReason?: string | null;
  /** True = chargeable remake, false = no-charge remake, null = unspecified. */
  remakeCharged?: boolean | null;
  /**
   * When the AI assigned a doctor name that closely matches (but doesn't
   * exactly equal) an existing doctor on file, this is the suggested
   * match. Shown as a "Did you mean?" prompt in the AI-review banner.
   */
  suggestedDoctorName?: string | null;
  /** Provider org id of the suggested match doctor. */
  suggestedProviderOrgId?: string | null;
  /** Practice display name of the suggested match (resolved by the server). */
  suggestedPracticeName?: string | null;
  /** Barcode assigned to the case pan. Cleared when the case is located to Complete. */
  casePanBarcode?: string | null;
  /** Free-text general notes entered on the case. */
  caseNotes?: string | null;
  /**
   * Top-level shade value for the case, written by the AI intake and iTero
   * import paths. Used as a fallback in Lab Slip rendering when no restoration
   * rows carry a shade.
   */
  shade?: string | null;
  /**
   * Contact details from the provider organization record, populated on
   * GET /cases/:id so the advanced print renderer can display the Doctor Info
   * block without an extra round-trip.
   */
  providerOrganizationContact?: {
    name?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
    billingEmail?: string | null;
  } | null;
}

/**
 * One result from `GET /cases/patient-similarity`. Used by the desktop and
 * mobile clients to render the "possible duplicate / remake?" dialog.
 */
export interface PatientSimilarityHit {
  id: string;
  source: "canonical" | "legacy";
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
  matchKind: "exact" | "nickname" | "fuzzy";
  createdAt: string | null;
  dueDate: string | null;
  toothNumbers: string;
  restorationTypes: string;
  hasInvoice: boolean;
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
  note?: string | null;
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
  toothNumber?: number | null;
  toothLabel?: string | null;
  description: string;
  quantity: number;
  unitPrice: string | number;
  lineTotal: string | number;
  sortOrder: number;
  parentLineItemId?: string | null;
  subItems?: InvoiceLineItem[];
}

export interface InvoiceDisplayMetadata {
  patientName?: string | null;
  billTo?: string | null;
  teeth?: string | null;
  shade?: string | null;
  material?: string | null;
  caseNotes?: string | null;
  caseType?: string | null;
  clientName?: string | null;
  credits?: number | null;
  lineItems?: Array<{
    item?: string | null;
    description?: string | null;
    subItems?: Array<{ item?: string | null; description?: string | null }> | null;
  }> | null;
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
  aiGenerated?: boolean;
  aiPricingWarning?: string | null;
  aiReviewedAt?: string | null;
  aiReviewedByUserId?: string | null;
  voidedAt?: string | null;
  voidedByUserId?: string | null;
  voidReason?: string | null;
  voidKind?: "void" | "writeoff" | null;
  sourceInvoiceId?: string | null;
  caseCompletedAt?: string | null;
  layoutPresetId?: string | null;
  frozen?: boolean;
  caseDeletedAt?: string | null;
  caseDeletedByUserId?: string | null;
  caseDeletedNote?: string | null;
  linkedCaseIsDeleted?: boolean | null;
  linkedCaseNumber?: string | null;
}

export interface InvoiceAttachment {
  id: string;
  invoiceId: string;
  fileName: string;
  storageKey: string;
  fileType: string;
  fileSize: number;
  includeInPdf: boolean;
  uploadedByUserId?: string | null;
  createdAt?: string | null;
}

export interface InvoiceCredit {
  id: string;
  invoiceId: string;
  providerOrganizationId: string;
  labOrganizationId: string;
  amount: string | number;
  sourceKind: "adjustment" | "deposit" | "writeoff" | "manual";
  note?: string | null;
  appliedByUserId?: string | null;
  createdAt?: string | null;
  reversedAt?: string | null;
}

export interface PracticeSummary {
  providerOrganizationId: string;
  totals: {
    invoiceCount: number;
    openCount: number;
    totalBilled: string;
    openBalance: string;
    creditsAvailable: string;
  };
  aging: {
    current: string;
    days_1_30: string;
    days_31_60: string;
    days_61_90: string;
    days_90_plus: string;
  };
  recentInvoices: Array<{
    id: string;
    invoiceNumber: string;
    total: string | number;
    balanceDue: string | number;
    status: string;
    issuedAt?: string | null;
    dueAt?: string | null;
    aiGenerated?: boolean;
  }>;
}

export interface PracticeStatement {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  periodStart: string;
  periodEnd: string;
  invoiceCount: number;
  totalBilled: string | number;
  totalPaid: string | number;
  balanceDue: string | number;
  invoiceIdsJson?: string[];
  createdAt?: string;
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
  statementEmailOptOut?: boolean | null;
  parentLabOrganizationId?: string | null;
  accountNumber?: string | null;
  createdByUserId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
  logoUrl?: string | null;
  logoplacements?: string[] | null;
  duplicateSuggestionThreshold?: string | number | null;
  defaultCaseDueDays?: number | null;
  capCaseDueToDefault?: boolean | null;
  autoAddAlloyOnPfm?: boolean | null;
  licenseNumber?: string | null;
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
  accountType?: string | null;
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
  vendorId?: string | null;
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
  depositedByUserId?: string | null;
  depositedAt?: string | null;
  depositedByName?: string | null;
  invoices?: Array<{ invoiceId: string; invoiceNumber: string }>;
}

export interface RecurringRule {
  id: string;
  labOrganizationId: string;
  bankAccountId: string;
  name: string;
  payee?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  vendorType?: "vendor" | "employee" | "item" | null;
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

export interface OrgMemberRow {
  id: string;
  userId: string;
  labId: string;
  role: string;
  status: string;
  createdAt?: string | null;
  user: {
    id: string;
    username: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    initials?: string | null;
    platformAccountNumber?: string | null;
  } | null;
}

export interface MeResponse {
  user: {
    id: string;
    username: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
    userType?: string | null;
    practiceName?: string | null;
  };
  memberships: Membership[];
}
