import type { KnowledgeSection } from "../types";

/**
 * OSHA / hazardous-waste knowledge for dental labs. General compliance
 * reference only — not legal advice and contains no patient data.
 * Covers EPA amalgam rule, OSHA exposure limits, and chemical disposal
 * requirements relevant to dental laboratory operations.
 */
export const OSHA_SECTIONS: KnowledgeSection[] = [
  {
    id: "osha.epa-amalgam-rule",
    group: "osha",
    title: "EPA Amalgam Rule (40 CFR Part 441)",
    keywords: [
      "epa", "amalgam", "amalgam rule", "40 cfr", "part 441", "separator",
      "dental effluent", "wastewater", "pretreatment", "discharge",
    ],
    body: "The EPA Amalgam Rule (40 CFR Part 441) requires dental offices that place or remove amalgam to install and maintain an amalgam separator that captures at least 95% of amalgam particles before wastewater enters the sanitary sewer. Dental laboratories that do not place or remove amalgam in patients are generally not directly subject to Part 441, but labs that cut, grind, or adjust amalgam restorations may generate amalgam-containing wastewater. Contact your local sewer authority (POTW) to confirm whether a separator is required. The rule also prohibits using certain line cleaners that may mobilize settled amalgam and bans flushing amalgam scrap or used chair-side traps down drains.",
  },
  {
    id: "osha.amalgam-separator-maintenance",
    group: "osha",
    title: "Amalgam separator maintenance & recordkeeping",
    keywords: [
      "separator", "amalgam separator", "maintenance", "inspection", "cartridge",
      "replace", "replacement", "iso 11143", "recordkeeping", "records",
    ],
    body: "Amalgam separators must meet ISO 11143 or equivalent standards. Follow the manufacturer's instructions for inspection, cleaning, and cartridge replacement — typically when the separator reaches its rated capacity (weight or volume) or annually, whichever comes first. Keep maintenance records for at least three years: installation date, inspection dates, cartridge change dates, and the name of the technician or vendor. Send spent cartridges only to a licensed amalgam recycler — never landfill them. Retain the recycler's chain-of-custody documentation.",
  },
  {
    id: "osha.mercury-disposal",
    group: "osha",
    title: "Mercury and amalgam disposal",
    keywords: [
      "mercury", "amalgam", "disposal", "recycle", "recycler", "scrap", "waste",
      "hazardous waste", "universal waste", "spent amalgam", "amalgam waste",
    ],
    body: "Amalgam scrap (non-contact scrap from trimming restorations, contact scrap from used capsules, and separator waste) is classified as hazardous waste under RCRA because it contains mercury. Most states allow dental amalgam to be managed as a Universal Waste or under state dental amalgam exemptions, which simplifies storage and shipping requirements compared to full RCRA hazardous-waste rules. Store amalgam scrap in a sealed, labeled, non-reactive container away from heat sources. Ship only to a permitted amalgam recycler. Never pour mercury or amalgam down the drain, into regular trash, or incinerate it. Contact your state environmental agency for the specific generator category and manifest requirements in your jurisdiction.",
  },
  {
    id: "osha.beryllium",
    group: "osha",
    title: "Beryllium exposure limits and controls",
    keywords: [
      "beryllium", "beryllium alloy", "beryllium oxide", "berylliosis",
      "cbd", "chronic beryllium disease", "exposure limit", "pel", "al",
      "action level", "sensitization",
    ],
    body: "Beryllium-containing dental alloys (historically used in some base-metal and porcelain systems) are subject to OSHA's Beryllium Standard (29 CFR 1910.1024 for general industry). The permissible exposure limit (PEL) is 0.2 µg/m³ as an 8-hour TWA; the action level (AL) is 0.1 µg/m³. Grinding, sandblasting, or porcelain firing of beryllium-containing alloys can release beryllium dust or fumes. Controls: use beryllium-free alloys whenever possible; if beryllium alloys are used, enclose grinding operations, use local exhaust ventilation (LEV), and provide respiratory protection (P100 or supplied air). Medical surveillance is required for workers exposed at or above the AL. Inform workers of beryllium content — check the SDS before working with any unfamiliar alloy.",
  },
  {
    id: "osha.silica-dust",
    group: "osha",
    title: "Silica dust controls",
    keywords: [
      "silica", "silica dust", "crystalline silica", "quartz", "sandblasting",
      "investment", "gypsum", "respirable", "pel", "action level", "respirator",
      "silicosis", "al",
    ],
    body: "Respirable crystalline silica (RCS) is present in dental investments, some gypsums, porcelains, and as carborundum or quartz in polishing compounds. OSHA's Silica Standard (29 CFR 1910.1053) sets a PEL of 50 µg/m³ as an 8-hour TWA and an action level of 25 µg/m³. Dry grinding, trimming, or sandblasting investment or gypsum models generates RCS dust. Controls: wet grinding (suppress dust at source), local exhaust ventilation, enclosed sandblasting cabinets with HEPA exhaust filtration, and N95 or P100 respirators when engineering controls alone cannot reduce exposures below the PEL. A written exposure control plan and medical surveillance are required when exposures reach or exceed the action level.",
  },
  {
    id: "osha.acid-solvent-disposal",
    group: "osha",
    title: "Acid and solvent chemical disposal",
    keywords: [
      "acid", "solvent", "chemical disposal", "hydrofluoric", "hf",
      "hydrochloric", "hcl", "phosphoric", "acetone", "alcohol", "ipa",
      "isopropanol", "monomer", "methyl methacrylate", "hazardous waste",
      "rcra", "sds", "storage",
    ],
    body: "Dental labs use acids (hydrofluoric acid for etching ceramics, hydrochloric or phosphoric acid for metal treatment) and solvents (acetone, isopropanol, methyl methacrylate monomer). These are typically RCRA hazardous wastes when discarded and must not be poured down drains or into regular trash. Steps: (1) Identify waste streams using the SDS — HF waste is particularly dangerous and requires special neutralization before disposal. (2) Store hazardous waste in compatible, labeled, closed containers in a designated accumulation area. (3) Quantity thresholds determine your generator category (very small, small, or large) — most labs fall under very small quantity generator (VSQG, formerly CESQG) rules. (4) Contract with a licensed hazardous-waste hauler for pickup and manifest. Check state rules, which may be more stringent than federal RCRA.",
  },
  {
    id: "osha.ppe-lab-chemical",
    group: "osha",
    title: "PPE for chemical and dust hazards",
    keywords: [
      "ppe", "personal protective equipment", "gloves", "respirator", "goggles",
      "face shield", "ventilation", "hazard communication", "sds",
      "safety data sheet", "ghs", "right to know",
    ],
    body: "OSHA's Hazard Communication Standard (HazCom, 29 CFR 1910.1200) requires a written hazard-communication program, Safety Data Sheets (SDS) for all hazardous chemicals, and employee training on chemical hazards and GHS labels. In a dental lab: always wear nitrile gloves when handling acids, solvents, or amalgam; use chemical splash goggles and a face shield when working with hydrofluoric or other corrosive acids; ensure adequate ventilation or LEV for solvent-heavy tasks (monomer, acetone); and wear a minimum N95 respirator (P100 preferred) during dry grinding, sandblasting, or beryllium-alloy work. Keep a current SDS for every chemical on-site and accessible to all employees.",
  },
  {
    id: "osha.hazardous-waste-storage",
    group: "osha",
    title: "Hazardous waste storage and generator categories",
    keywords: [
      "hazardous waste", "generator", "vsqg", "cesqg", "sqg", "lqg",
      "accumulation", "storage", "manifest", "epa id", "rcra",
      "satellite accumulation", "90 day", "container",
    ],
    body: "Under RCRA, dental labs are classified by the amount of hazardous waste generated per month: Very Small Quantity Generator (VSQG) — ≤ 100 kg/month, fewer requirements; Small Quantity Generator (SQG) — 100–1,000 kg/month; Large Quantity Generator (LQG) — > 1,000 kg/month. Most dental labs qualify as VSQG and have relaxed storage and manifest requirements, but the waste must still be sent to a permitted facility. Keep hazardous waste in closed, compatible, clearly labeled containers; separate incompatibles (acids from solvents, oxidizers from flammables). Satellite accumulation (near the point of generation) is limited to one container per waste stream and 55 gallons total. Contact the EPA or your state agency for an EPA ID number if required for your generator category.",
  },
];
