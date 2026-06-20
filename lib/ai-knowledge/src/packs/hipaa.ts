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
];
