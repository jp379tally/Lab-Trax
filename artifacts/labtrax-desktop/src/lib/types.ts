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
  bridgeConnectors?: string | null;
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
  /** Optional wall-clock time of day paired with dueDate, formatted "HH:MM" (24-hour). Never set without a dueDate. */
  dueTime?: string | null;
  expectedDeliveryDate?: string | null;
  /** Calendar date when the cases API says the lab received the case. */
  receivedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  restorationCount?: number;
  restorationTypes?: string | null;
  restorationMaterials?: string | null;
  /**
   * The encoded `restorationSubtype` value of the first (non-"missing")
   * restoration row. Used by the desktop type filter to categorise the case
   * via `deriveCaseHierarchy` without loading full restoration details.
   */
  firstRestorationSubtype?: string | null;
  teeth?: string | null;
  totalPrice?: string | number | null;
  restorations?: CaseRestoration[];
  /** "mobile" when this case originated from the mobile app's lab_cases table */
  _source?: "mobile";
  /**
   * Legacy compatibility field. New AI/iTero imports no longer set a pending
   * review state; retained because older case records and the API still expose it.
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
   * match. Shown as an independent "Did you mean?" correction prompt.
   */
  suggestedDoctorName?: string | null;
  /** Provider org id of the suggested match doctor. */
  suggestedProviderOrgId?: string | null;
  /** Practice display name of the suggested match (resolved by the server). */
  suggestedPracticeName?: string | null;
  /** Barcode assigned to the case pan. Cleared when the case is located to Complete. */
  casePanBarcode?: string | null;
  /**
   * Lab-scoped account number of the provider organization (practice) assigned
   * to this case. Populated from organizations.account_number. Null for legacy
   * cases and cases whose practice has no account number set.
   */
  providerAccountNumber?: string | null;
  /** Free-text general notes entered on the case. */
  caseNotes?: string | null;
  /** Stable, server-owned prescription scan history in chronological order. */
  rxNoteEntries?: RxNoteEntry[];
  /** Optional removable-workflow stage, editable by lab owners and admins. */
  step?: "custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null;
  /** Shade recorded only while the removable workflow is at Wax Setup. */
  stepShade?: string | null;
  /**
   * Top-level shade value for the case, written by the AI intake and iTero
   * import paths. Used as a fallback in Lab Slip rendering when no restoration
   * rows carry a shade.
   */
  shade?: string | null;
  /**
   * Gingival (tissue) shade for removable/denture cases, captured by the AI
   * intake and iTero import paths. Null for all non-removable cases and when
   * not specified.
   */
  gingivialShade?: string | null;
  /**
   * The specific lab_locations row id where this case is physically located.
   * Written whenever a locate action is performed. Null for cases located
   * before this feature was added or via legacy paths.
   */
  labLocationId?: string | null;
  /**
   * Human-readable name of the station identified by `labLocationId`.
   * Resolved server-side; avoids a separate locations lookup on the client.
   */
  labLocationName?: string | null;
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
  /**
   * Free-text preferences for this doctor (e.g. "Prefers ½ mm out of occlusion"),
   * populated on GET /cases/:id from the doctor_profiles table.
   */
  doctorPreferences?: string | null;
  /**
   * Structured clinical preferences supplied by the provider for this case.
   * This is intentionally separate from doctorPreferences, which remains the
   * lab-authored doctor profile note.
   */
  providerDoctorPreferences?: {
    occlusionAmount?: number | null;
    occlusionUnit?: "mm" | "microns" | null;
    proximalContactAmount?: number | null;
    proximalContactUnit?: "mm" | "microns" | null;
    anatomyPreference?:
      | "primary_only"
      | "primary_and_secondary"
      | "other"
      | null;
    anatomyOther?: string | null;
    caseQuestionContactMethod?: "text" | "phone_call" | "email" | null;
    caseQuestionContactValue?: string | null;
  } | null;
  /** Lab-wide setting resolved onto the detailed case print payload. */
  printProviderPreferencesOnLabSlips?: boolean | null;
  /**
   * The case's currently-open exception, if any. Lab-internal — the server
   * returns null for provider/practice viewers even when one exists.
   */
  activeException?: CaseExceptionSummary | null;
  /** Convenience flag mirroring `activeException !== null` on list payloads. */
  hasActiveException?: boolean;
}

export interface RxNoteEntry {
  id: string;
  caseId: string;
  noteText: string;
  scannedAt: string | null;
  provenance: "legacy" | "ai_reader" | "itero_import" | "case_intake";
}

// ── Exception case types ─────────────────────────────────────────────────────

/**
 * Summary of a case exception, as returned inline on case list/detail
 * payloads and by `GET /case-exceptions/active`.
 */
export interface CaseExceptionSummary {
  id: string;
  labOrganizationId: string;
  /** Canonical `cases.id` or legacy `lab_cases.id`, depending on `caseKind`. */
  caseId: string;
  caseKind: "canonical" | "legacy";
  status: "active" | "resolved";
  issueText: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  resolvedByUserId?: string | null;
  resolvedByName?: string | null;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
  resolutionLabLocationId?: string | null;
  resolutionStatus?: string | null;
  previousStatus?: string | null;
  /** Current case location, returned on the lab-only exception detail. */
  currentLocationId?: string | null;
  currentLocationName?: string | null;
  currentLocationStatus?: string | null;
}

/** Request body for creating an exception case. A non-hold exception must name
 * the active lab location where the case currently is. */
export type CreateCaseExceptionRequest =
  | {
      caseId: string;
      putOnHold: true;
      issueText?: string;
    }
  | {
      caseId: string;
      putOnHold: false;
      labLocationId: string;
      issueText?: string;
    };

/** A row in the dashboard's active-exception queue. */
export interface CaseExceptionQueueItem extends CaseExceptionSummary {
  caseNumber: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  doctorName: string | null;
  /** Canonical case status, used as the location-label fallback. */
  caseStatus: string | null;
  mediaCount: number;
  hasMedia: boolean;
  noteCount: number;
  latestNoteText: string | null;
  latestNoteAuthorName: string | null;
  latestNoteCreatedAt: string | null;
}

export interface CaseExceptionNote {
  id: string;
  caseExceptionId: string;
  authorUserId: string | null;
  authorName: string | null;
  noteText: string;
  createdAt: string;
}

export interface CaseExceptionHistoryEntry {
  type: "opened" | "note_added" | "media_added" | "resolved";
  occurredAt: string | null;
  actorName: string | null;
  detail: string | null;
}

/** Full payload from `GET /case-exceptions/:id`. */
export interface CaseExceptionDetail extends CaseExceptionSummary {
  notes: CaseExceptionNote[];
  attachments: CaseAttachment[];
  history: CaseExceptionHistoryEntry[];
  /** True only for owner/admin members of the owning lab. */
  viewerCanResolve: boolean;
}

// ── Doctor profile types ─────────────────────────────────────────────────────

export type DoctorPhoneType = "main" | "mobile" | "other";
export type DoctorEmailLabel = "general" | "invoicing" | "other";

export interface DoctorPhoneEntry {
  id?: string;
  number: string;
  type: DoctorPhoneType;
  primary: boolean;
}

export interface DoctorEmailEntry {
  id?: string;
  address: string;
  label: DoctorEmailLabel;
  primary: boolean;
}

export interface DoctorProfile {
  doctorName: string;
  providerOrganizationId: string;
  labOrganizationId: string;
  phones: DoctorPhoneEntry[];
  emails: DoctorEmailEntry[];
  preferences: string;
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

export interface DoctorMatchCandidate {
  doctorName: string;
  /**
   * The practice this doctor is actually associated with (from
   * GET /doctors/resolve-name). Null for legacy names with no practice, and
   * for the POST /cases 409 duplicate-gate candidates, which are already
   * scoped to the selected practice.
   */
  providerOrganizationId: string | null;
  practiceName?: string | null;
  practiceAddressLine1?: string | null;
  practiceCity?: string | null;
  practiceState?: string | null;
  similarity: number;
  totalCases: number;
}

export type RestorationPriceSource =
  | "default"
  | "tier"
  | "override"
  | "discount"
  | "manual";

export interface CaseRestoration {
  implantRetention?: string | null;
  implantManufacturer?: string | null;
  implantPlatformNotes?: string | null;
  id: string;
  caseId: string;
  toothNumber: string;
  restorationType: string;
  restorationSubtype?: string | null;
  /** Billable arch for removable/ortho appliances. */
  arch?: "upper" | "lower" | null;
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
  /** Semantic category for durable attachment provenance. */
  category?: "outgoing" | "prescription" | null;
  note?: string | null;
  createdAt?: string | null;
  uploaderName?: string | null;
  scanAccuracy?: CaseScanAccuracy | null;
  /** Authenticated case attachment id for a PLY texture, when present. */
  textureAttachmentId?: string | null;
  scan?: { textureAttachmentId?: string | null } | null;
}

export type ScanObjectCondition =
  | "simple-matte"
  | "dental-complex"
  | "reflective-or-translucent";

export interface CaseScanAccuracy {
  objectCondition?: ScanObjectCondition | null;
  estimatedErrorRangeMm?: { min: number; max: number } | null;
  accuracyProfile?: {
    evidence?: string;
    conditions?: string[];
    warning?: string;
  } | null;
  disclaimer?: string | null;
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
  isDiscount?: boolean;
  sortOrder: number;
  parentLineItemId?: string | null;
  subItems?: InvoiceLineItem[];
  /** true = price explicitly set; false = alloy sub-item still waiting for lab to price it */
  priced?: boolean;
}

export interface InvoiceDisplayMetadata {
  patientName?: string | null;
  billTo?: string | null;
  teeth?: string | null;
  shade?: string | null;
  material?: string | null;
  caseNotes?: string | null;
  caseType?: string | null;
  caseSubtype?: string | null;
  clientName?: string | null;
  credits?: number | null;
  lineItems?: Array<{
    item?: string | null;
    description?: string | null;
    subItems?: Array<{
      item?: string | null;
      description?: string | null;
    }> | null;
  }> | null;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: string | number;
  method?: string | null;
  reference?: string | null;
  // The API returns the raw payment row columns; these are the authoritative
  // field names for the payment method and reference number.
  paymentMethod?: string | null;
  referenceNumber?: string | null;
  paidAt?: string | null;
  notes?: string | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  caseId?: string | null;
  labOrganizationId: string;
  providerOrganizationId: string;
  /** Durable doctor attribution returned by billing endpoints. */
  doctorIdentity?: string | null;
  doctorDisplayName?: string | null;
  doctorName?: string | null;
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
  dateRepairLogs?: Array<{
    id: string;
    userId: string | null;
    beforeJson: {
      issuedAt?: string | null;
      dueAt?: string | null;
    } | null;
    afterJson: {
      issuedAt?: string | null;
      dueAt?: string | null;
    } | null;
    createdAt: string;
    actorUsername: string | null;
    actorFirstName: string | null;
    actorLastName: string | null;
    actorInitials: string | null;
  }>;
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
  hasDeposit?: boolean;
  /** True when any alloy sub-item on this invoice still has a $0 unit price. Set by the list endpoint. */
  hasUnpricedAlloy?: boolean;
  /** Whether this invoice appears in any practice_statements row. Returned by GET /:invoiceId. */
  inStatement?: boolean;
  /** The statement ID if this invoice is part of a statement. */
  statementId?: string | null;
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
  // Settlement figures derived from the statement's current invoice balances.
  // `totalPaid` / `balanceDue` carry the same live values; `snapshot*` keeps
  // the immutable figures captured when the statement was issued.
  totalPaid: string | number;
  balanceDue: string | number;
  currentTotalPaid?: string | number;
  currentBalanceDue?: string | number;
  snapshotTotalPaid?: string | number;
  snapshotBalanceDue?: string | number;
  invoiceIdsJson?: string[];
  pdfStorageKey?: string | null;
  pdfFileName?: string | null;
  bundleAttachments?: PracticeStatementBundleAttachment[];
  createdAt?: string;
  lastEmailedAt?: string | null;
  lastEmailedTo?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
}

export interface PracticeStatementBundleAttachment {
  index: number;
  doctorName: string | null;
  label: string;
  fileName: string;
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
  printProviderPreferencesOnLabSlips?: boolean | null;
  licenseNumber?: string | null;
  additionalEmails?: Array<{ id: string; email: string; type: string }> | null;
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
  /** System-default lookup key. "accounts_receivable" | "accounts_payable" | null */
  categoryType?: string | null;
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
  /** A Make Deposits batch represented by one posting transaction. */
  isAggregateDeposit?: boolean;
  splitGroups?: AggregateDepositSplitGroup[];
}

export interface AggregateDepositPayment {
  childTransactionId: string;
  amount: string;
  payee?: string | null;
  memo?: string | null;
  checkNumber?: string | null;
  paymentMethod?: string | null;
  receiptNumber?: string | null;
  statementId?: string | null;
  paymentSessionId?: string | null;
  invoices: Array<{ invoiceId: string; invoiceNumber: string }>;
}

export interface AggregateDepositSplitGroup {
  providerOrganizationId: string | null;
  providerName: string;
  subtotal: string;
  payments: AggregateDepositPayment[];
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
    profilePhotoUrl?: string | null;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
    userType?: string | null;
    practiceName?: string | null;
  };
  memberships: Membership[];
}
