import "./_group.css";
import { useState } from "react";
import { ToothChart as Corrected } from "./_corrected/ToothChart";

/**
 * Uploaded Exocad references beside copied application chart source.
 * Synthetic #2/#3/#4 bridge only; no patient data, app authentication, or persistence.
 */
export function Compare() {
  const crown = new Set(["2", "4"]);
  const pontic = new Set(["3"]);
  const [pairs, setPairs] = useState<Set<string>>(new Set(["2-3", "3-4"]));
  const [, setSel] = useState<Set<string>>(new Set(["5"]));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="min-h-screen bg-stone-100 p-4 text-stone-900">
      <div className="mx-auto grid max-w-[1100px] gap-4 md:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">New reference (screenshot 5)</h2>
          <img src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/tooth-compare/reference5.png`} alt="New gray occlusal reference with crown, pontic and green connectors"
            className="w-full rounded-xl border border-stone-300 bg-white" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <img src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/tooth-compare/reference3.png`} alt="New reference 3: indication menu" className="w-full rounded border border-stone-300" />
            <img src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/tooth-compare/reference4.png`} alt="New reference 4: material panel" className="w-full rounded border border-stone-300" />
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">Actual chart component (SYNTHETIC)</h2>
          <Corrected value="" onChange={() => {}} onToothClick={toggle} crownTeeth={crown} ponticTeeth={pontic}
            assignments={[
              { toothNumber: "2", restorationType: "Crown", material: "Zirconia", shade: "A2" },
              { toothNumber: "3", restorationType: "Pontic", material: "Zirconia", shade: "A2" },
              { toothNumber: "4", restorationType: "Crown", material: "Zirconia", shade: "A2" },
            ]}
            onArchSelect={() => {}}
            connectedPairs={pairs} onConnectedPairsChange={setPairs}
            summaryText="Zirconia A2 bridge #2-4 | crowns #2, #4 | pontic #3" />
        </section>
      </div>
      <p className="mx-auto mt-3 max-w-[1100px] text-xs text-stone-600">
        SYNTHETIC component-only comparison; not the signed-in main app and not an exact-match claim. Fixture: #2 Crown, #3 Pontic, #4 Crown, Zirconia A2, connectors 2-3 and 3-4. Reference images are the user screenshots 5, 3 and 4.
      </p>
    </div>
  );
}
