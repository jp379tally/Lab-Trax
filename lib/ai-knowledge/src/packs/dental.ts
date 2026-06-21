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

  {
    id: "dental.tooth-nomenclature",
    group: "dental",
    title: "Tooth nomenclature & numbering",
    keywords: [
      "universal numbering", "tooth number", "teeth numbers", "numbering system",
      "mesial", "distal", "buccal", "facial", "lingual", "palatal", "occlusal",
      "incisal", "surfaces", "quadrant", "anterior", "posterior",
    ],
    body: "The Universal Numbering System (used in the US) numbers permanent teeth 1–32: maxillary arch right to left (#1 upper-right third molar → #16 upper-left third molar), then mandibular arch left to right (#17 lower-left third molar → #32 lower-right third molar). Primary teeth use letters A–T. Tooth surfaces: mesial (toward midline), distal (away from midline), buccal/facial (toward cheek or lip), lingual/palatal (toward tongue or palate), occlusal (chewing surface of posteriors), incisal (cutting edge of anteriors). Proximal surfaces are the mesial and distal together. Anatomical landmarks technicians reference: cusp tips, ridges (marginal, transverse, oblique), fossae (central, triangular), grooves (central, buccal, lingual), and embrasures (spaces between adjacent tooth contacts). Understanding surface nomenclature is essential for reading Rx descriptions, charting restorations, and communicating about margin locations.",
  },

  {
    id: "dental.dental-anatomy",
    group: "dental",
    title: "Dental anatomy & tooth morphology",
    keywords: [
      "anatomy", "morphology", "incisor", "canine", "cuspid", "premolar",
      "bicuspid", "molar", "cusp of carabelli", "cingulum", "lingual fossa",
      "oblique ridge", "mesiobuccal", "distobuccal", "mesiolingual", "distolingual",
    ],
    body: "Incisors (teeth 7–10, 23–26) have a single cutting edge; central incisors are wider than laterals. The cingulum is a rounded eminence on the lingual surface of anteriors; the lingual fossa lies between the cingulum and the incisal edge. Canines (teeth 6, 11, 22, 27) have a single pointed cusp and the longest root — used for tearing. Premolars/bicuspids (teeth 4–5, 12–13, 20–21, 28–29) typically have two cusps (buccal and lingual) and function for seizing and grinding. Molars (teeth 1–3, 14–16, 17–19, 30–32) are the largest teeth and primary grinders; maxillary first molars typically have four cusps (MB, DB, ML, DL) plus the cusp of Carabelli on the ML cusp, and a prominent oblique ridge connecting the ML and DB cusps. Mandibular first molars have five cusps (MB, DB, ML, DL, distal). Correct restoration contour must recreate natural anatomy: proper cusp height, ridge alignment, and embrasure form ensure occlusal function, self-cleansing, and tissue health.",
  },

  {
    id: "dental.gypsum-materials",
    group: "dental",
    title: "Gypsum materials (plaster & stone)",
    keywords: [
      "gypsum", "plaster", "dental stone", "die stone", "type i", "type ii",
      "type iii", "type iv", "type v", "w:p ratio", "water powder ratio",
      "setting expansion", "model", "cast", "pour",
    ],
    body: "Gypsum products used in the dental lab are classified by ADA type: Type I (impression plaster) — fast set, low expansion, brittle, used for impressions; Type II (model/lab plaster) — general pours and flasking, weakest; Type III (dental stone, alpha-hemihydrate) — stronger than plaster, used for study models and working casts; Type IV (die stone, high-strength) — hardest conventional gypsum, low expansion, used for accurate working dies and master casts; Type V (high-expansion die stone) — higher expansion compensates for alloy shrinkage. The water-to-powder (W:P) ratio controls strength and expansion: lower W:P yields a stronger, harder set. Type III stone mixes at approximately 0.30 mL/g; Type IV at 0.22–0.24 mL/g. Setting expansion must be controlled — excess expansion distorts the model. Key handling rules: always add powder to water, never add to a mix, use vacuum spatulation for investments to remove air, store in sealed containers in a dry room. Hardened stone erodes in tap water; use saturated calcium sulfate dihydrate solution (SDS) when wetting casts.",
  },

  {
    id: "dental.dental-waxes",
    group: "dental",
    title: "Dental waxes",
    keywords: [
      "wax", "waxes", "baseplate wax", "inlay wax", "utility wax", "boxing wax",
      "sticky wax", "blockout wax", "casting wax", "carving wax", "occlusal rim",
      "wax up", "pattern wax",
    ],
    body: "Dental waxes are mixtures of natural or synthetic waxes formulated for specific lab uses. Three functional groups: (1) Impression waxes — low melting point, flow at mouth temperature, used chairside (e.g. bite-registration, corrective wax). (2) Pattern waxes — form molds for prosthetic restorations: inlay wax (highest dimensional accuracy, used for wax-up of crowns, inlays, RPD frameworks), baseplate wax (sheets ~1 mm/18 ga, used for occlusal rims, denture wax-ups, boxing impressions), sheet-casting wax (controlled gauge 24–30 ga, used for RPD relief), preformed/wire wax (round and half-round shapes for RPD sprues and connectors). (3) Processing waxes — lab support: sticky wax (holds pieces together for indexing), utility/rope wax (beading impressions), boxing wax (dams for controlled cast pouring), blockout wax (fills undercuts in RPD fabrication). Temperature governs handling: waxes soften at elevated temps and become brittle if too cool. Hard baseplate wax resists flow in warm climates; medium type is used in cooler environments.",
  },

  {
    id: "dental.investment-materials",
    group: "dental",
    title: "Investment materials",
    keywords: [
      "investment", "gypsum bonded", "phosphate bonded", "burnout", "thermal expansion",
      "setting expansion", "casting", "porosity", "mold", "sprue",
    ],
    body: "Casting investments create a heat-resistant mold by surrounding a wax pattern and withstanding burnout temperatures. Two main binder types: (1) Gypsum-bonded investments — use gypsum as the binder with a silica filler; suitable for lower-fusing gold alloys and some PFM alloys (max burnout ~700°C/1300°F). Setting expansion plus thermal expansion compensate for metal shrinkage on solidification. (2) Phosphate-bonded investments — use ammonium phosphate binder with silica; withstand higher burnout temperatures (~900°C/1650°F) needed for high-fusing base-metal alloys (Ni-Cr, Co-Cr). Some silver-palladium alloys also require phosphate-bonded investment. Mixing procedure: weigh powder and measure liquid (colloidal silica solution or water), vacuum-spatulate to remove air, apply to pattern, bench-set, then place in furnace. Proper burnout eliminates all wax residue (incomplete burnout causes porosity and carbon inclusions). Common casting defects: porosity (from gas entrapment or insufficient burnout), fins (from cracked investment), incomplete casting (from cold alloy or mold). Follow manufacturer W:P ratio and burnout schedule precisely.",
  },

  {
    id: "dental.dental-alloys",
    group: "dental",
    title: "Dental alloys & metals",
    keywords: [
      "alloy", "alloys", "noble", "high noble", "base metal", "gold",
      "chrome cobalt", "cobalt chromium", "titanium", "nickel chromium",
      "precious", "non precious", "metal surcharge",
    ],
    body: "Dental alloys are classified by noble metal content: High-noble (HN) — ≥60% noble metals (Au, Pt, Pd) + ≥40% gold; Noble — ≥25% noble metals; Base metal (predominantly non-noble, e.g. Ni-Cr, Co-Cr). Common alloy types: conventional casting golds (soft/Type I for inlays, hard/Type III for crowns and FPDs); ceramic/PFM golds (≥2100°F fusion, matched coefficient of thermal expansion to porcelain); Ni-Cr and Co-Cr (base metal, used for PFM copings and RPD frameworks, require phosphate-bonded investment and higher casting temperatures); Co-Cr (ticonium) specifically for RPD frameworks — hard, stiff, corrosion-resistant; Titanium — biocompatible, lightweight, hypoallergenic, used for implants and some frameworks. Key properties influencing clinical selection: hardness (Brinell/Vickers — harder alloys resist wear, are harder to burnish), melting range, coefficient of thermal expansion (critical for porcelain bonding), and biocompatibility (Ni allergy is common). Precious-metal content (gold, platinum, palladium) typically carries a material surcharge on the invoice.",
  },

  {
    id: "dental.dental-ceramics-porcelain",
    group: "dental",
    title: "Dental ceramics & porcelain",
    keywords: [
      "porcelain", "ceramics", "feldspathic", "opaque", "bisque", "glaze",
      "stain", "layering", "firing", "thermal expansion", "coefficient",
      "pfm porcelain", "leucite",
    ],
    body: "Feldspathic porcelain is the traditional lab ceramic used in PFM and all-ceramic layered restorations. Build-up sequence for PFM: apply opaque layer (masks metal color and bonds porcelain to metal oxide layer), then dentin/body porcelain, then enamel/incisal porcelain; fire each layer in a vacuum oven. Bisque bake produces the initial fired shape for adjustment before glaze firing. Glaze firing creates the final surface luster; stains can be added for characterization. The coefficient of thermal expansion (CTE) of porcelain must closely match the metal coping (within ~0.5 × 10⁻⁶/°C) or the restoration will craze or fracture on cooling. Leucite-reinforced ceramics (e.g. IPS Empress) have higher strength than feldspathic alone — pressed or milled, then crystallized. Monolithic restorations (full-contour zirconia or pressed Emax) avoid the layering step and delamination risk. Stain-and-glaze technique applies surface stains without layering — faster but limits the depth of characterization achievable with layered porcelain.",
  },

  {
    id: "dental.acrylic-resins",
    group: "dental",
    title: "Acrylic resins (PMMA) in the lab",
    keywords: [
      "acrylic", "resin", "methyl methacrylate", "monomer", "polymer",
      "heat cured", "autopolymerizing", "self curing", "denture base",
      "reline", "rebase", "injection molded", "porosity",
    ],
    body: "Polymethyl methacrylate (PMMA/acrylic resin) is the dominant denture-base material. The lab receives powder (polymer) and liquid (monomer); mixing produces a dough that is packed into a flask mold and heat-cured (polymerized) in hot water — the most common method. Types: Heat-cured (most stable, best properties) — for complete and RPD bases; Autopolymerizing/self-curing (activator in liquid causes room-temperature polymerization in 10–20 min) — for repairs, relines, custom impression trays, and record bases; Injection-molded (vinyl or polystyrene) — claimed superior dimensional stability; Soft-lining resins (velum, silicone, ethyl methacrylate) — cushion liners for sensitive ridges. Common processing errors: porosity (from rapid heat, contamination, or improper monomer ratio), distortion/warpage, and dimensional change at the posterior palatal seal. Denture base characterization adds veins and stippling to simulate natural gingival tissue. Relining (new tissue surface, original teeth retained) and rebasing (entirely new base) use these same resins.",
  },

  {
    id: "dental.impression-materials",
    group: "dental",
    title: "Impression materials",
    keywords: [
      "impression", "alginate", "hydrocolloid", "pvs", "vps", "polyvinyl siloxane",
      "addition silicone", "condensation silicone", "polyether", "polysulfide",
      "elastomeric", "irreversible", "reversible", "disinfection",
    ],
    body: "Irreversible hydrocolloid (alginate): powder mixed with water; sets by gelation; fast and inexpensive; dimensional stability is poor — must be poured within 10 minutes of removal to avoid distortion from water loss (syneresis) or gain (imbibition). Good for study models and RPD impressions. Reversible hydrocolloid (agar): softened by heat, seated in a water-cooled tray; accurate but technique-sensitive. Elastomeric impressions — four types: (1) Addition silicone (PVS/VPS) — most accurate, excellent dimensional stability, can be poured multiple times, hydrophobic so field must be dry; (2) Condensation silicone — less stable, lower accuracy, lower cost; (3) Polyether — hydrophilic (good in moist field), high detail, rigid (may tear in deep undercuts), slight dimensional change over time; (4) Polysulfide — long working time, excellent accuracy, messy (brown staining), sulfur odor. Disinfection protocol before pouring: rinse under water, spray or immerse with an ADA-approved disinfectant (iodophor, sodium hypochlorite, or glutaraldehyde per type), then rinse and pour. Never immerse alginate or agar in disinfectant solution — brief spray only.",
  },

  {
    id: "dental.infection-control-lab",
    group: "dental",
    title: "Infection control in the lab",
    keywords: [
      "infection control", "disinfection", "sterilization", "ppe", "barrier",
      "receiving area", "universal precautions", "gloves", "mask",
      "iodophor", "hypochlorite", "glutaraldehyde", "osha",
    ],
    body: "The dental lab uses a barrier system to prevent cross-contamination. All contaminated items (impressions, prostheses, bite records) are processed through a designated receiving area before entering the production floor. PPE required in the receiving area: latex/nitrile gloves, mask, protective eyewear, and lab coat. OSHA Standard Universal Precautions require treating all blood, saliva, and body fluids as potentially infectious — lab techs face elevated hepatitis B exposure risk. Disinfectant selection by item type: impressions — iodophor (1:213 dilution, 10-min contact) or sodium hypochlorite (1:10, 10 min) depending on material; prostheses entering the lab — spray or immerse with iodophor or 2% glutaraldehyde, then rinse before handling. ADA classification of items: critical (must be sterile), semicritical (impressions, facebows, jaw records — high-level disinfection), noncritical (articulators, case pans — intermediate-to-low disinfection). The receiving area should be physically separated from production; any item that has not been disinfected must not cross into the clean zone. Rush-case protocols must maintain the barrier system — no exceptions.",
  },

  {
    id: "dental.articulators-face-bows",
    group: "dental",
    title: "Articulators & face-bow transfer",
    keywords: [
      "articulator", "face bow", "facebow", "mounting", "arcon", "semi adjustable",
      "class i articulator", "class ii articulator", "class iii articulator",
      "class iv articulator", "hanau", "whip mix", "centric relation", "vdo",
    ],
    body: "An articulator is a mechanical instrument representing the temporomandibular joints and jaws; it holds mounted casts and simulates mandibular movement so restorations can be fabricated with proper occlusion. Articulator classes: Class I (simple hinge) — opens and closes only, no lateral movement simulation; Class II (average movement) — fixed condylar inclination, simulates protrusive movement but not lateral; Class III (semi-adjustable, e.g. Hanau H2, Whip Mix) — adjustable condylar inclination and lateral settings from transfer records, most common in full-denture and complex cases; Class IV (fully adjustable) — replicates all mandibular movements via pantographic tracing. Arcon design places the condylar ball on the lower member (mimics anatomy); non-Arcon places the ball on the upper member. Face-bow transfer: captures the spatial relationship of the maxillary arch to the transverse hinge axis (condyles) so the cast can be mounted in the same orientation on the articulator. Without a face-bow, the maxillary cast must be arbitrarily mounted, which may introduce arc-of-closure errors. Mounted models allow occlusal correction, excursive movement testing, and tooth setup without returning to the patient.",
  },

  {
    id: "dental.complete-denture-fabrication",
    group: "dental",
    title: "Complete denture fabrication",
    keywords: [
      "complete denture", "full denture", "denture fabrication", "custom tray",
      "master cast", "jaw relation", "vdo", "vertical dimension", "face bow transfer",
      "tooth setup", "wax try-in", "flasking", "packing", "curing", "remounting",
      "lingualized occlusion", "balanced occlusion",
    ],
    body: "Complete denture fabrication follows a defined workflow: (1) Primary impression with stock tray → pour diagnostic cast → fabricate custom impression tray; (2) Final (master) impression with custom tray → pour master cast in Type III/IV stone; (3) Jaw relation records — establish centric relation and vertical dimension of occlusion (VDO) using record bases with occlusal rims; (4) Face-bow transfer and mounting of casts on articulator; (5) Tooth selection — shade, mold (size/shape), and material (acrylic vs. porcelain teeth); (6) Tooth setup — arrange denture teeth in wax following occlusal plane, midline, and lip support guides; (7) Occlusal scheme — lingualized or bilateral balanced occlusion improves stability; (8) Wax try-in — patient and dentist evaluate esthetics, phonetics, and VDO before processing; (9) Processing — flask and pour stone around wax denture, boil out wax, pack heat-cured acrylic, close flask, cure in hot water press; (10) Deflasking — remove set denture from stone; (11) Remounting and occlusal correction on articulator to remove processing errors; (12) Finish, polish, and characterize (stippling, veins). Each step requires accurate records — errors compound across the workflow.",
  },

  {
    id: "dental.rpd-fabrication",
    group: "dental",
    title: "RPD framework fabrication",
    keywords: [
      "rpd", "partial denture", "framework", "surveying", "survey", "path of insertion",
      "undercut", "rest seat", "clasp", "major connector", "minor connector",
      "chrome cobalt", "ticonium", "duplication", "refractory cast",
    ],
    body: "Removable partial denture (RPD) framework fabrication: (1) Study models and surveying — use a dental surveyor to determine the path of insertion, identify undercuts, locate rest seats, and select clasp assemblies and connector designs; (2) Design the framework on the master cast — draw the design in coded colors (major/minor connectors, rests, clasps, finish lines); (3) Block out undercuts with blockout wax; create relief under connectors; ledge and beading for border seal; (4) Duplication — invest the blocked-out master cast in agar hydrocolloid to create a duplicate; pour the duplicate in phosphate-bonded refractory material (refractory cast); (5) Wax-up the framework pattern on the refractory cast using preformed wax shapes and inlay wax; (6) Sprue, invest in phosphate-bonded investment, and burn out; (7) Cast in Co-Cr (ticonium) alloy via centrifugal casting; (8) Divest, finish, and polish the framework — inspect for fit on master cast; (9) Framework try-in by dentist; (10) Tooth setup in wax on processed acrylic record bases; (11) Wax try-in; (12) Flask, pack, and process acrylic denture base; (13) Deflask, finish, and polish completed RPD.",
  },

  {
    id: "dental.orthodontic-appliances",
    group: "dental",
    title: "Lab-fabricated orthodontic appliances",
    keywords: [
      "orthodontic", "retainer", "hawley", "essix", "vacuum formed", "space maintainer",
      "band and loop", "lingual arch", "habit appliance", "functional appliance",
      "frankel", "bionator", "stainless steel wire", "thermoforming",
    ],
    body: "Dental labs fabricate a range of orthodontic appliances from the treating dentist/orthodontist's Rx. Hawley retainer: the most common removable retainer — acrylic palatal/lingual body with stainless steel clasps (Adams or ball clasps) and a labial bow wire; holds teeth in corrected position post-treatment. Vacuum-formed/Essex retainer: clear thermoplastic sheet pressed over a stone model; thin, esthetic, and easy to fabricate. Space maintainers: band-and-loop (unilateral, single-tooth space) and lingual arch (bilateral mandibular) — stainless steel wire soldered to bands; prevent mesial drift when primary teeth are lost early. Habit appliances: cribs or rakes to deter thumb/finger sucking or tongue thrusting. Functional appliances (Frankel, Bionator): acrylic-and-wire devices that redirect growth forces; lab reads the Rx bite registration to set the mandibular advancement. Lab responsibilities: replicate wire position and dimensions precisely, relieve acrylic away from tissue pressure points, ensure smooth surfaces to avoid soft-tissue irritation. Use stone models (Type III) for model pours; thermoforming uses specialized pressure/vacuum units.",
  },

  {
    id: "dental.mouth-guards-splints",
    group: "dental",
    title: "Mouth guards & occlusal splints",
    keywords: [
      "mouth guard", "night guard", "splint", "occlusal splint", "bruxism",
      "tmd", "thermoform", "vacuum formed", "hard acrylic", "sport guard",
      "mouthguard", "athletic", "soft splint",
    ],
    body: "Custom mouth protectors (athletic guards) are vacuum-formed from thermoplastic sheets (EVA) over a stone model of the patient's teeth — far superior fit and protection versus stock or boil-and-bite guards. Thickness varies by sport: 3 mm for general sports, up to 5 mm for high-contact sports. Lab receives an alginate or PVS impression, pours a stone model, and vacuum-forms to spec. Occlusal splints (night guards) manage bruxism and TMD: Hard acrylic splints — fabricated with heat-cured or pressure-cured PMMA, cover all maxillary teeth, provide flat occlusal surface for even loading; preferred for bruxism due to durability. Soft splints — thermoformed EVA or soft acrylic; easier to tolerate but may exacerbate clenching in some patients. Lab receives a stone model, a bite registration, and an Rx specifying type (hard/soft), arch (upper/lower), and occlusal contact design (canine guidance, mutually protected, flat plane). Finish all surfaces smooth and free of sharp edges — rough borders cause soft-tissue irritation and patient non-compliance.",
  },

  {
    id: "dental.lab-workflow-process",
    group: "dental",
    title: "Dental lab workflow & operations",
    keywords: [
      "lab workflow", "prescription", "work order", "turnaround", "bench time",
      "barcode", "pan", "quality control", "intake", "receiving", "remake causes",
      "case tracking", "delivery",
    ],
    body: "The dental lab prescription (Rx) is the authoritative work order — it specifies the patient, restoration type, material, shade, bite, and special instructions. No work should begin without a complete, legible Rx. Lab intake: receive case → disinfect impression/prosthesis in receiving area → pour model (pour alginate within 10 minutes) → assign to technician. Case tracking moves through defined stages: received → in progress → quality check → ready → delivered. Turnaround time expectations vary by restoration type: PFM crowns typically 5–7 business days; zirconia/Emax 3–5 days; complete dentures 2–3 weeks (with try-in appointments); RPD frameworks 5–7 days. Pan/barcode labeling (common in larger labs) ties physical cases to the case-management system. Quality control checkpoints: model quality, margin clarity, occlusion, shade accuracy, and fit on model before dispatch. Common remake causes: incomplete Rx (unclear shade, missing bite, ambiguous design), poor impression (voids at margins, distortion), wrong bite record, incorrect shade, margin issues identified at delivery. Bench time (actual technician fabrication time) is distinct from total turnaround, which includes delivery logistics, dentist scheduling, and any try-in appointments.",
  },
];
