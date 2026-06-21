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
      "secure", "securely", "security", "encryption", "encrypt", "access control",
      "password", "safeguard", "storage", "transmission", "backup",
      "handle", "handling", "safely", "protect", "protecting",
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
      "washington", "wa", "colorado", "co", "arizona", "az",
      "new jersey", "nj", "north carolina", "nc", "michigan", "mi",
      "virginia", "va", "massachusetts", "ma", "minnesota", "mn", "missouri", "mo",
      "oregon", "or", "nevada", "nv", "tennessee", "tn", "south carolina", "sc",
      "wisconsin", "wi", "indiana", "in", "maryland", "md", "connecticut", "ct",
      "kentucky", "ky", "oklahoma", "ok", "louisiana", "la", "alabama", "al",
      "utah", "ut", "new mexico", "nm", "idaho", "id", "montana", "mt",
      "wyoming", "wy", "north dakota", "nd", "south dakota", "sd", "nebraska", "ne",
      "kansas", "ks", "iowa", "ia", "arkansas", "ar", "mississippi", "ms",
      "west virginia", "wv", "delaware", "de", "new hampshire", "nh",
      "vermont", "vt", "maine", "me", "rhode island", "ri", "hawaii", "hi",
      "alaska", "ak",
      "federal", "baseline", "destroy", "disposal",
    ],
    body: `Dental-lab record retention varies by state. HIPAA itself sets no explicit minimum — the covered entity's BAA terms and applicable state dental-records laws govern. Always verify current rules with counsel before disposing of records.

**Federal baseline:** HIPAA requires covered entities to retain HIPAA-related documentation (policies, BAAs, notices) for 6 years from creation or last effective date, but sets no specific retention period for dental records or lab work orders. Labs inherit retention obligations from their BAA with each practice.

**State minimums — adult patients (minors: add the adult period to age 18 unless noted):**
AL: 10 yr (no explicit statute; general guidance) | AK: 10 yr | AZ: 7 yr (minors until 21 or 7 yr) | AR: 10 yr | CA: 10 yr (minors until 19 or 10 yr) | CO: 7 yr | CT: 7 yr | DE: 7 yr | FL: 4 yr (minors: 4 yr after 18) | GA: 10 yr (no explicit statute) | HI: 7 yr | ID: 10 yr (minors until 21 or 10 yr) | IL: 10 yr (minors until 23 or 10 yr) | IN: 7 yr | IA: 7 yr | KS: 10 yr | KY: 5 yr | LA: 10 yr | ME: 7 yr | MD: 5 yr (minors until 21 or 5 yr) | MA: 7 yr | MI: 10 yr (minors until 21 or 10 yr) | MN: 7 yr (minors until 19 or 7 yr) | MS: 10 yr (minors until 21 or 10 yr) | MO: 10 yr | MT: 10 yr | NE: 10 yr | NV: 5 yr | NH: 7 yr | NJ: 7 yr (minors until 21 or 7 yr) | NM: 10 yr | NY: 6 yr (minors until 24) | NC: 10 yr (minors until 21 or 10 yr) | ND: 6 yr | OH: 6 yr (minors until 21 or 6 yr) | OK: 7 yr | OR: 7 yr (minors until 21 or 7 yr) | PA: 7 yr | RI: 5 yr | SC: 10 yr (minors until 21 or 10 yr) | SD: 7 yr (minors until 21 or 7 yr) | TN: 10 yr (minors until 21 or 10 yr) | TX: 10 yr | UT: 7 yr (minors until 21 or 7 yr) | VT: 10 yr | VA: 6 yr (minors until 24) | WA: 7 yr (minors until 21 or 7 yr) | WV: 10 yr | WI: 5 yr | WY: 7 yr (no explicit statute)

**Minor patients:** In most states retain records until the patient reaches the age of majority (18) plus the standard adult retention period — typically until age 23–28 depending on state.

**Rx forms and work orders:** In most states the lab Rx / work order is part of the dental record, subject to the same retention rules as clinical notes. Keep the Rx with the case record.

**Practical guidance:** Retaining the case record, attachments, and scanned Rx within LabTrax satisfies auditability requirements: cases are timestamped, access is logged, and soft-delete with audit trail preserves recoverability. Coordinate with the referring practice before disposing of shared PHI, and use a secure (irreversible) deletion process. This is general reference only — consult your compliance officer or legal counsel for the specific requirements in every state where you operate.`,
  },
  {
    id: "hipaa.disposal-methods",
    group: "hipaa",
    title: "Secure disposal of Rx forms, paper records, and ePHI",
    keywords: [
      "shred", "shredding", "shredder", "cross-cut", "strip-cut", "micro-cut",
      "destroy", "destruction", "disposal", "dispose", "paper records",
      "certificate of destruction", "certificate", "degauss", "degaussing",
      "purge", "wipe", "overwrite", "secure erase", "sanitize", "sanitisation",
      "media sanitization", "nist 800-88", "hard drive", "flash drive",
      "usb", "device disposal", "end of life", "decommission",
      "rx disposal", "rx destruction", "paper rx", "paper disposal",
      "lab slip disposal", "work order disposal", "record disposal",
      "approved disposal", "compliant disposal", "hipaa disposal",
      "california", "ca", "texas", "tx", "new york", "ny", "florida", "fl",
      "illinois", "il", "ohio", "oh", "georgia", "ga", "pennsylvania", "pa",
      "washington", "wa", "colorado", "co", "arizona", "az",
      "new jersey", "nj", "north carolina", "nc", "michigan", "mi",
      "virginia", "va", "massachusetts", "ma", "minnesota", "mn", "missouri", "mo",
    ],
    body: `HIPAA requires that PHI be disposed of in a manner that renders it unreadable and unrecoverable. The Privacy Rule does not prescribe a single method but sets the outcome standard; several states add explicit method or documentation requirements for dental-practice and lab records.

**Paper records and physical Rx forms**

*HIPAA standard:* Shred, burn, pulp, or pulverize paper so PHI cannot be reconstructed. The HHS guidance examples include locked shred bins serviced by a certified destruction vendor. Strip-cut shredders (long ribbons) are generally considered insufficient; **cross-cut or micro-cut shredders** are the accepted minimum because strips can be re-assembled.

*State-specific requirements and notes:*
- **California (CA):** Medical records containing PHI must be destroyed by shredding or other means that render them unreadable and undecipherable. California also requires labs/providers to take reasonable steps to protect customer/patient records during disposal. (CA Civ. Code § 1798.81; CA Health & Safety Code § 123111)
- **Texas (TX):** Dental records must be destroyed in a manner that prevents reconstruction — cross-cut shredding or incineration; Texas law specifically requires a covered entity to dispose of confidential records using methods that make them unreadable. (TX Occ. Code § 258.004; TX Bus. & Com. Code § 521.052)
- **New York (NY):** Requires appropriate safeguards including destruction of patient records in a manner that makes reconstruction impossible; the state recommends cross-cut shredding or incineration for paper PHI. (NY Public Health Law § 18; NY SHIELD Act)
- **Florida (FL):** Requires destruction of PHI so it cannot be practicably read or reconstructed; specific methods listed include shredding, pulverizing, burning, or using a destruction service. (FL § 501.171; FL § 408.810)
- **Illinois (IL):** Records must be disposed of in a manner that ensures their confidentiality; recommended methods include shredding or incineration. (740 ILCS 14/15)
- **Massachusetts (MA):** Requires destruction by shredding documents containing personal information so they cannot be read or reconstructed; strip-cut shredding is explicitly discouraged in MA data-security guidance. (201 CMR 17.00)
- **Other states (GA, OH, PA, WA, CO, AZ, NJ, NC, MI, VA, MN, MO):** All require that records be rendered unreadable or unrecoverable. Cross-cut or micro-cut shredding, incineration, or use of a certified destruction vendor satisfies these requirements in all listed states.

**Certificate of destruction**

Most compliance frameworks (and several state regulations) recommend — and some require — obtaining a **certificate of destruction** from the shredding or destruction vendor. The certificate should include: name and address of the destroying firm, date of destruction, description and quantity of records destroyed, and the method used. Retain these certificates as part of your compliance records for the same duration as your BAA and HIPAA policy documentation (at least 6 years under federal HIPAA).

**Electronic PHI (ePHI) — digital media sanitization**

NIST SP 800-88 (Guidelines for Media Sanitization) is the recognized federal framework for ePHI disposal:
- **Clear:** Overwrite storage with non-sensitive data (acceptable for reuse within the organization).
- **Purge:** Cryptographic erase, degaussing, or block-erase commands for internal reuse or sale to trusted parties.
- **Destroy (recommended for disposal/decommission):** Physical destruction — shredding, disintegration, pulverizing, or incineration — renders media unrecoverable. Hard drives, SSDs, USB drives, and backup tapes all require method-appropriate destruction.

*Degaussing* (strong magnetic field) is effective for magnetic hard drives but **does not work on SSDs or flash-based media** — those must be physically destroyed or cryptographically erased. Degaussing a magnetic drive also renders it unusable.

**For dental labs — practical steps:**
1. Use a cross-cut or micro-cut shredder (or a certified shredding service) for all paper Rx forms, work orders, and case printouts when the retention period ends.
2. Obtain and file a certificate of destruction for any batch or vendor-assisted destruction.
3. For end-of-life devices (computers, tablets, external drives) containing ePHI: use NIST-compliant cryptographic erase or physical destruction. Do not donate, sell, or discard devices without verified sanitization.
4. Coordinate destruction with the referring dental practice — shared PHI (like patient names on Rx forms) should be disposed of consistently across both parties.
5. LabTrax soft-delete preserves records for audit recovery. When you are ready for final disposal after the retention window, use the export-and-delete workflow and confirm ePHI removal from backups in accordance with your BAA and disaster-recovery policy.

This is general compliance reference, not legal advice. State requirements can change — verify current rules with your compliance officer or legal counsel before disposing of records.`,
  },
  {
    id: "hipaa.breach-response",
    group: "hipaa",
    title: "Data breach response for dental labs",
    keywords: [
      "breach", "data breach", "security incident", "incident", "incident response",
      "notification", "notify", "report", "reporting", "reportable",
      "stolen", "lost", "unauthorized access", "unauthorized",
      "hhs", "ocr", "office for civil rights",
      "60 day", "60-day", "72 hour", "72-hour", "72h",
      "laptop stolen", "laptop lost", "device stolen", "device lost",
      "shred bin", "compromised", "ransomware", "phishing",
      "media breach", "large breach", "500", "media notice",
      "state notification", "state breach", "california breach", "texas breach",
      "ca breach", "tx breach",
      "breach log", "breach documentation", "document breach",
      "risk assessment", "low probability", "hipaa breach rule",
    ],
    body: `When a dental lab suspects or confirms that PHI was improperly accessed, used, or disclosed, the HIPAA Breach Notification Rule requires a structured incident response. This is general guidance — consult your compliance officer or legal counsel immediately.

**What qualifies as a reportable breach**
A breach is any impermissible use or disclosure of unsecured PHI. Apply the four-factor risk assessment: (1) nature and extent of PHI involved, (2) who could have accessed it, (3) whether it was actually acquired or viewed, (4) whether risk has been mitigated. If you cannot demonstrate a low probability of compromise across all four factors, treat it as a reportable breach.

**Notification timeline (60-day federal rule)**
- **Lab → covered entity (dental practice):** Notify "without unreasonable delay," no later than 60 days after discovery. The BAA may require shorter notice.
- **Covered entity → affected patients:** Within 60 days of discovery.
- **Covered entity → HHS/OCR:** Breaches affecting <500 individuals: log and report annually. Breaches affecting 500+ individuals: report to HHS OCR within 60 days (posted publicly on the HHS breach portal).
- **Media notice:** Breaches affecting 500+ residents of a state require prominent media notification in that state within 60 days.

**State-specific windows (shorter than 60 days)**
California: 72 hours (CMIA, healthcare operators). Florida, Colorado, Washington: 30 days. Texas: 60 days (matches federal). New York, Illinois: "most expedient time possible." Check state law for every state where affected individuals reside.

**Common scenarios**
- *Stolen or lost device:* Encrypted device with no evidence of access → document low probability. Unencrypted → reportable.
- *Compromised shred bin or unsecured paper records:* Paper PHI exposed to unauthorized parties → reportable unless low probability is clearly documented.
- *Ransomware:* HHS presumes a breach — treat as reportable unless PHI non-exfiltration is proven.
- *Unauthorized account access or phishing:* Investigate scope, preserve logs, report unless low-probability analysis is complete.

**What to document (retain 6 years)**
Date of discovery; description of the incident; PHI types and number of individuals affected; four-factor risk assessment and conclusion; containment and mitigation steps taken; notifications sent to the practice, patients, HHS, and media with dates; corrective actions.`,
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
