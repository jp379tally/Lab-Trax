import type { KnowledgeSection } from "../types";

/**
 * Dental-lab domain knowledge: restoration types, materials, and digital
 * workflows. General reference only — contains no patient data. Material names
 * mirror LabTrax's canonical vocabulary (e.g. "Lithium Disilicate (Emax)").
 */
export const DENTAL_SECTIONS: KnowledgeSection[] = [
  {
    id: "dental.crown-bridge",
    group: "dental",
    title: "Crown & bridge",
    keywords: [
      "crown", "bridge", "crowns", "bridges", "fixed", "abutment", "pontic",
      "coping", "fpd", "unit", "margin",
    ],
    body: "A crown is a full-coverage restoration for a single prepared tooth; a bridge replaces one or more missing teeth by joining crowns (retainers) over abutment teeth to suspended pontics. Bridge size is counted in units (e.g. a 3-unit bridge = 2 abutments + 1 pontic). Common materials are Zirconia, Lithium Disilicate (Emax), PFM, and full cast. Accurate margins, contacts, and occlusion are essential. Anterior cases prioritize esthetics (often Emax or layered zirconia); high-load posterior cases prioritize strength (often monolithic zirconia).",
  },
  {
    id: "dental.dentures",
    group: "dental",
    title: "Full dentures",
    keywords: [
      "denture", "dentures", "full denture", "complete denture", "acrylic",
      "removable", "teeth setup", "festooning", "vdo", "edentulous",
    ],
    body: "A full (complete) denture replaces all teeth in an arch for an edentulous patient. Fabrication moves through impressions, bite/VDO records, a wax try-in for esthetics and occlusion, and processing in acrylic (or printed/milled). Shade and mold selection of denture teeth, midline, and lip support drive the esthetic result. Balanced occlusion improves stability. Common materials: heat-cured acrylic bases and prefabricated/printed denture teeth.",
  },
  {
    id: "dental.partials",
    group: "dental",
    title: "Partial dentures",
    keywords: [
      "partial", "partials", "rpd", "partial denture", "framework", "clasp",
      "cast metal", "flexible", "valplast", "chrome cobalt",
    ],
    body: "A removable partial denture (RPD) replaces some teeth while clasping onto remaining natural teeth. Designs include cast metal frameworks (chrome-cobalt) for rigidity and retention, and flexible thermoplastic partials for esthetics/comfort. Surveying and a clear design (rests, clasps, connectors) determine fit and load distribution. The case typically includes a framework try-in before tooth setup and processing.",
  },
  {
    id: "dental.implants",
    group: "dental",
    title: "Implant restorations",
    keywords: [
      "implant", "implants", "abutment", "screw-retained", "cement-retained",
      "ti-base", "custom abutment", "implant crown", "analog", "scan body",
    ],
    body: "Implant restorations attach to one or more implant fixtures rather than natural teeth. They can be screw-retained (retrievable, no cement, requires an access channel) or cement-retained (on a stock or custom abutment). Custom abutments and ti-bases optimize emergence profile and angulation. Digital workflows use a scan body to capture implant position. Match the correct implant system/platform — connection compatibility is critical.",
  },
  {
    id: "dental.surgical-guides",
    group: "dental",
    title: "Surgical guides",
    keywords: [
      "surgical guide", "guide", "guided surgery", "drill guide", "sleeve",
      "planning", "cbct", "printed guide",
    ],
    body: "A surgical guide is a (usually 3D-printed) appliance that directs implant drill placement based on a merged CBCT + intraoral scan plan. It positions metal sleeves so osteotomies match the planned angle, depth, and position. Accuracy depends on the planning merge, a stable seat (tooth/tissue/bone-supported), and correct sleeve/drill-kit selection for the chosen implant system.",
  },
  {
    id: "dental.all-on-x",
    group: "dental",
    title: "All-on-X / full-arch implants",
    keywords: [
      "all-on-x", "all on 4", "all-on-4", "full arch", "hybrid", "fp1", "fp3",
      "bar", "multi-unit", "conversion", "fixed full arch",
    ],
    body: "All-on-X is a fixed full-arch prosthesis supported by several implants (commonly 4–6) via multi-unit abutments. Workflows include an immediate conversion/provisional and a definitive bar- or framework-supported prosthesis (titanium or zirconia) with teeth. Passive fit on the multi-unit abutments, verified jig/verification, hygiene access, and lip/VDO support are key. These are complex, high-value cases requiring close lab–surgeon communication.",
  },
  {
    id: "dental.digital-workflow",
    group: "dental",
    title: "Digital, milling & 3D printing",
    keywords: [
      "digital", "milling", "mill", "3d printing", "printing", "printed",
      "stl", "design", "nesting", "sintering", "glaze", "additive",
    ],
    body: "Modern labs combine subtractive (milling) and additive (3D printing) manufacturing. A typical digital flow: receive/scan model → design in CAD → mill or print → finish (sinter zirconia, crystallize Emax, stain/glaze) → QC. Milling suits zirconia, Emax, PMMA, and metals; printing suits models, surgical guides, try-ins, and some provisionals/denture bases. Output files are commonly STL; maintain consistent design parameters (cement gap, contacts, margins) for predictable fit.",
  },
  {
    id: "dental.zirconia",
    group: "dental",
    title: "Zirconia",
    keywords: [
      "zirconia", "zr", "monolithic", "layered", "translucent", "3y", "4y",
      "5y", "sinter", "strength",
    ],
    body: "Zirconia is a strong, versatile ceramic milled in a soft (green) state then sintered to full density and shrinkage. Higher-translucency grades (4Y/5Y) improve esthetics for anterior/visible units; lower-translucency, higher-strength grades (3Y) suit high-load posterior crowns and bridges. It can be used monolithic (full-contour) for strength or layered with porcelain for esthetics. Correct shade selection, sintering, and staining/glazing determine the final look.",
  },
  {
    id: "dental.emax",
    group: "dental",
    title: "Lithium Disilicate (Emax)",
    keywords: [
      "emax", "lithium disilicate", "e.max", "glass ceramic", "pressed",
      "milled", "veneer", "anterior", "crystallize",
    ],
    body: "Lithium Disilicate (Emax) is a glass-ceramic prized for natural esthetics and good strength for single units and veneers, especially in the anterior. It is pressed or milled, then crystallized, and can be stained/glazed or cut back and layered. It is the canonical wording used in LabTrax for this material. Ideal for veneers, inlays/onlays, and anterior crowns; for long-span bridges or very high load, zirconia is usually preferred.",
  },
  {
    id: "dental.pmma",
    group: "dental",
    title: "PMMA & provisionals",
    keywords: [
      "pmma", "provisional", "temporary", "temp", "try-in", "mock-up",
      "prototype", "milled provisional",
    ],
    body: "PMMA is a milled acrylic-like polymer used for provisionals, long-term temporaries, try-ins, and full-arch prototypes. It lets the patient and clinician test esthetics, function, and VDO before committing to a definitive restoration. PMMA prototypes are especially valuable in complex full-arch/All-on-X cases to validate the design that the final zirconia or titanium prosthesis will copy.",
  },
  {
    id: "dental.pfm",
    group: "dental",
    title: "PFM (porcelain-fused-to-metal)",
    keywords: [
      "pfm", "porcelain fused to metal", "metal", "coping", "alloy",
      "noble", "high noble", "base metal", "opaque",
    ],
    body: "PFM restorations bond feldspathic porcelain to a cast metal coping, combining metal strength with porcelain esthetics. Alloys range from high-noble/noble (precious) to base metal; precious-alloy content can carry a surcharge that should be reflected on the invoice. PFMs are durable and well-proven but can show a metal margin or reduced translucency versus all-ceramic options; many labs now favor zirconia or Emax for esthetic zones.",
  },
  {
    id: "dental.shades",
    group: "dental",
    title: "Shade systems & esthetics",
    keywords: [
      "shade", "shades", "color", "vita", "a1", "a2", "a3", "bleach", "stump",
      "shade matching", "value", "esthetics",
    ],
    body: "Shade communicates tooth color. The VITA Classical system (A–D families, e.g. A1–A4, plus bleach shades BL1–BL4) is most common; VITA 3D-Master is value-organized. Good matching needs the body shade, sometimes a stump (prep) shade for translucent materials, and notes/photos for characterization. Value (brightness) often matters more than hue. Always record shade clearly on the case and verify against the Rx — mismatched shade is a frequent remake cause.",
  },
  {
    id: "dental.occlusion",
    group: "dental",
    title: "Occlusion & articulation",
    keywords: [
      "occlusion", "bite", "articulator", "articulation", "contacts",
      "centric", "excursion", "interferences", "vertical dimension",
    ],
    body: "Occlusion is how the upper and lower teeth meet. Restorations must have correct centric contacts and clearance in excursive movements to avoid high spots, fractures, and patient discomfort. Mounted models or a digital articulator reproduce the patient's bite. Check and adjust contacts before finishing; record the bite (and VDO for full-arch) accurately at intake.",
  },
  {
    id: "dental.cadcam-scanners",
    group: "dental",
    title: "CAD/CAM & intraoral scanners",
    keywords: [
      "cad", "cam", "cad/cam", "scanner", "scanners", "intraoral", "ios",
      "itero", "trios", "scan", "digital impression", "model",
    ],
    body: "CAD/CAM software designs restorations from digital impressions captured by intraoral scanners (e.g. iTero, TRIOS) or by scanning physical models. The design (margins, contacts, cement gap, anatomy) is then milled or printed. Clean scans with clear margins reduce remakes. LabTrax Desktop can auto-import cases from an iTero Lab-Review queue, extracting the Rx and creating a case flagged for review.",
  },
  {
    id: "dental.lab-communication",
    group: "dental",
    title: "Lab–dentist communication",
    keywords: [
      "communication", "remake", "remakes", "rx", "instructions", "photos",
      "notes", "doctor preferences", "quality", "feedback",
    ],
    body: "Most remakes trace back to incomplete information, not lab skill. Good cases include a complete Rx (material, shade, design), a clear bite, clean margins, and photos for esthetic work. Capture each doctor's standing preferences (favored materials, contact tightness, pontic design) so the lab delivers consistently. When something on the Rx is ambiguous, query the office before fabricating rather than guessing.",
  },
];
