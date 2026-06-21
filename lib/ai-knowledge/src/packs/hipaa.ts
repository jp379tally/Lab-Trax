import type { KnowledgeSection } from "../types";

/**
 * HIPAA / privacy knowledge for dental labs. General compliance reference only;
 * not legal advice and contains no patient data.
 */
export const HIPAA_SECTIONS: KnowledgeSection[] = [
  {
    id: "hipaa.phi",
    group: "hipaa",
    title: "What is PHI",
    keywords: [
      "phi", "protected health information", "identifier", "identifiers",
      "patient data", "patient information", "personal information", "pii",
    ],
    body: "Protected Health Information (PHI) is individually identifiable health information tied to a patient: name, dates (birth, treatment), addresses, phone/email, account/record numbers, photos, and any clinical detail linked to an identifiable person. In a dental lab, the patient name on a case, the Rx, intraoral photos, and case notes are PHI. De-identified or aggregate data (no way to tie it to a person) is not PHI. Treat any case-level patient detail as PHI by default.",
  },
  {
    id: "hipaa.rules",
    group: "hipaa",
    title: "Core HIPAA rules & roles",
    keywords: [
      "hipaa", "rule", "rules", "privacy rule", "security rule", "breach",
      "baa", "business associate", "covered entity", "compliance",
    ],
    body: "HIPAA's Privacy Rule limits how PHI may be used and disclosed; the Security Rule requires administrative, physical, and technical safeguards for electronic PHI (ePHI); the Breach Notification Rule requires notifying affected parties of breaches. A dental practice is typically a covered entity and a dental lab handling its PHI is usually a business associate, which requires a signed Business Associate Agreement (BAA) and makes the lab directly responsible for safeguarding PHI.",
  },
  {
    id: "hipaa.secure-handling",
    group: "hipaa",
    title: "Secure data handling",
    keywords: [
      "secure", "security", "encryption", "encrypt", "access control",
      "password", "safeguard", "storage", "transmission", "backup",
    ],
    body: "Safeguard ePHI with access controls (unique logins, least privilege), encryption in transit and at rest, strong authentication, audit logging, and secure backups. Don't email PHI in the clear, reuse passwords, or share accounts. Lock screens, keep software patched, and restrict who can export or download patient data. Ensure backups are encrypted and access-controlled, and that deleted data handling still meets retention and recoverability obligations.",
  },
  {
    id: "hipaa.privacy",
    group: "hipaa",
    title: "Privacy & disclosure",
    keywords: [
      "privacy", "disclosure", "share", "release", "consent", "third party",
      "communication", "marketing",
    ],
    body: "Only use and disclose PHI for permitted purposes — primarily treatment, payment, and health-care operations — or with patient authorization. Don't share patient details with unauthorized people, post them in public channels, or use them for marketing without consent. When communicating with the referring office, share only what is needed for the case and verify you are talking to the authorized practice.",
  },
  {
    id: "hipaa.minimum-necessary",
    group: "hipaa",
    title: "Minimum necessary & permissions",
    keywords: [
      "minimum necessary", "least privilege", "permission", "permissions",
      "role", "access", "need to know", "scope",
    ],
    body: "The minimum-necessary standard says you should access and disclose only the PHI required for the task at hand. Operationally this means role-based access so staff see only what their job needs, scoping data to the lab that owns it, and not pulling more patient detail than a workflow requires. LabTrax enforces tenant scoping and roles so users only reach their own lab's data.",
  },
  {
    id: "hipaa.retention",
    group: "hipaa",
    title: "Retention & disposal",
    keywords: [
      "retention", "retain", "records", "keep", "disposal", "dispose",
      "destroy", "delete", "archive",
    ],
    body: "Keep records as long as required by your BAA and applicable state/federal law, then dispose of PHI securely (irreversible deletion of ePHI, shredding of paper). Avoid keeping PHI longer than needed. Soft-delete/restore and audit trails help meet recoverability and accountability requirements, but final disposal of media containing PHI must be secure. Confirm retention periods with the covered entity / counsel.",
  },
  {
    id: "hipaa.practical",
    group: "hipaa",
    title: "Practical compliance for labs",
    keywords: [
      "practical", "guidance", "training", "incident", "breach response",
      "checklist", "policy", "audit", "report",
    ],
    body: "Practical steps: sign BAAs with every practice, train staff on PHI handling, use unique accounts with least-privilege roles, encrypt devices and backups, keep an audit trail, and have an incident-response plan so a suspected breach is reported promptly. Limit PHI in chat/AI tools to what's necessary, and never paste PHI into systems not covered by your safeguards. This is general guidance, not legal advice — consult your compliance officer or counsel for specifics.",
  },
  {
    id: "hipaa.lab-slip-rx-phi",
    group: "hipaa",
    title: "PHI on lab slips and Rx",
    keywords: [
      "lab slip", "rx", "prescription", "work order", "pan number", "barcode",
      "patient name", "case rx", "rx form", "lab order", "dental rx",
    ],
    body: "A dental lab Rx (work order / lab slip) is a HIPAA-covered document whenever it can be tied to an identifiable patient. PHI elements commonly found on an Rx include: patient name or initials, date of birth, tooth number(s) and treatment dates, doctor/practice name and address, and case notes that reference a specific patient's clinical situation. Even a PAN barcode that maps to a patient record is a PHI identifier. Handle physical Rx forms like paper PHI: store them securely, shred before disposal, and do not photograph or scan them to non-secured systems. Within LabTrax, the Rx content and attached files are stored as case-level PHI — access is scoped to authorized members of the owning lab.",
  },
  {
    id: "hipaa.case-media-minimum-necessary",
    group: "hipaa",
    title: "Minimum-necessary for case media",
    keywords: [
      "case media", "photo", "photos", "attachment", "attachments", "scan",
      "impression", "intraoral", "x-ray", "xray", "radiograph", "image",
      "minimum necessary", "media access",
    ],
    body: "Intraoral photographs, radiographs, digital scans, and any other case media attached to a case are ePHI. Apply the minimum-necessary principle: share case media only with staff who have a direct need for that specific case, and only to the referring practice for treatment-related purposes. Do not bulk-download or export media beyond what a workflow requires. When using external services (e.g., for AI shade analysis or shade matching), confirm those services operate under your BAA before transmitting patient-identifiable images. Within LabTrax, case media access is enforced by the lab's membership and role controls — photos are not publicly accessible by URL alone.",
  },
  {
    id: "hipaa.deidentification-demos",
    group: "hipaa",
    title: "De-identification for demos and training",
    keywords: [
      "demo", "demonstration", "training", "test case", "sample case",
      "de-identify", "deidentify", "de-identification", "anonymize",
      "anonymise", "anonymous", "fake patient", "mock data",
    ],
    body: "Never use real patient data for software demos, staff training, screenshots, or marketing materials. Properly de-identified data has all 18 HIPAA Safe Harbor identifiers removed (name, dates, geographic data below state level, phone, email, SSN, MRN, photos, etc.) OR has been certified de-identified by a qualified statistician. In practice, the safest approach is to create synthetic/fictional cases for demos. If you must use real cases for training, redact or replace patient-identifying fields before sharing. LabTrax's demo-seed feature creates fictional cases with no real PHI — use it instead of copying production data.",
  },
  {
    id: "hipaa.retention-dental-lab",
    group: "hipaa",
    title: "Dental-lab record retention rules by state",
    keywords: [
      "retention", "retain", "records", "keep", "how long", "years",
      "state law", "state rules", "state requirements", "record retention",
      "dental records", "case records", "rx records", "lab records",
      "minor", "minors", "adult", "adults", "majority",
      "california", "ca", "texas", "tx", "new york", "ny", "florida", "fl",
      "illinois", "il", "ohio", "oh", "georgia", "ga", "pennsylvania", "pa",
      "federal", "baseline", "destroy", "disposal",
    ],
    body: `Dental-lab record retention varies by state. HIPAA itself sets no explicit minimum retention period for labs — the covered entity's BAA terms and applicable state dental-records laws govern. Below is a practical reference; always verify current rules with counsel before disposing of records.

**Federal baseline:** HIPAA requires covered entities to retain certain HIPAA-related documentation (policies, BAAs, notices) for 6 years from creation or last effective date, but does not specify how long dental records or lab work orders must be kept. Labs inherit retention obligations from their BAA with each practice.

**Representative state minimums (dental/lab records — adult patients):**
- California: 10 years from the date of service; records for minors must be kept until the patient turns 19 or for 10 years from last service, whichever is longer. (CA Business & Professions Code § 1680.5)
- Texas: 10 years from the date the record was created or the date of last treatment. (TX Occupations Code § 258.004)
- New York: 6 years from the date of service or from the date of last entry; 6 years after a minor turns 18 (i.e., until age 24). (NY Education Law § 6530(32))
- Florida: 4 years (general); some liability-driven practices keep 7 years. Minors: 4 years after the patient turns 18. (FL § 466.028(1)(m))
- Illinois: 10 years from date of service; for minors, until age 23 or 10 years, whichever is later. (IL Professional Code)
- Georgia: No explicit dental-specific statute; general medical records guidance suggests 10 years; minors until age 21.
- Ohio: 6 years from last treatment date; minors until age 21 or 6 years from last treatment, whichever is later.
- Pennsylvania: 7 years from date of last service; for minors, until age 18 plus 7 years.

**Minor patients (general rule across most states):** Retain records until the patient reaches the age of majority (typically 18) PLUS the standard adult retention period — commonly resulting in records being kept until the patient is 23–28 years old, depending on state.

**Rx forms and work orders:** In most states the lab Rx / work order is considered part of the dental record and subject to the same retention rules as clinical notes. Keep the Rx together with the case record.

**Practical LabTrax guidance:** Retaining the case record, attachments, and scanned Rx within LabTrax satisfies auditability requirements: each case is timestamped, access is logged, and soft-delete with audit trail preserves recoverability. When the retention period ends, coordinate with the referring practice before disposing of any shared PHI, and use a secure (irreversible) deletion process. This is general reference only — consult your compliance officer or legal counsel for the specific requirements in every state where you operate.`,
  },
  {
    id: "hipaa.baa-lab-practice",
    group: "hipaa",
    title: "BAA obligations between a lab and a dental practice",
    keywords: [
      "baa", "business associate", "business associate agreement",
      "covered entity", "subcontractor", "vendor", "contract", "agreement",
      "obligation", "liability", "practice agreement", "lab agreement",
    ],
    body: "A dental practice is a HIPAA covered entity; a dental lab that receives patient PHI to fabricate restorations is a business associate and must sign a Business Associate Agreement (BAA) with every practice it serves. Key BAA obligations for the lab: (1) Use and disclose PHI only as permitted by the BAA and HIPAA rules. (2) Implement HIPAA-required administrative, physical, and technical safeguards for the PHI received. (3) Report any breach or security incident to the covered entity without unreasonable delay. (4) Ensure any subcontractors who touch PHI (e.g., a milling center, a third-party courier) also sign BAAs. (5) Return or securely destroy PHI at termination of the agreement. When a doctor is linked to multiple labs inside LabTrax, each lab independently holds its own data — PHI from Lab A is never shared with Lab B without a separate authorization. Cross-lab access is limited strictly to the provider's own records across their linked practices.",
  },
];
