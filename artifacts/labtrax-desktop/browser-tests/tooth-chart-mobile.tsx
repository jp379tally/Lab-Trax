import React from "react";
import { createRoot } from "react-dom/client";
import { ReadOnlyToothChart } from "../../labtrax/components/ReadOnlyToothChart";
import { ToothChart } from "../../labtrax/components/ToothChart";

// Component-only fixture: no auth, case data, or production navigation is loaded.
const panelWidth = new URLSearchParams(window.location.search).get("panelWidth") ?? "320";
const panelStyle: React.CSSProperties = {
  width: `min(${panelWidth}px, calc(100vw - 24px))`,
  margin: "0 auto 20px",
};

document.documentElement.style.background = "#f8fafc";
document.body.style.margin = "0";
document.body.style.padding = "12px";

createRoot(document.getElementById("root")!).render(
  <main>
    <section data-testid="mobile-read-only-panel" style={panelStyle}>
      <ReadOnlyToothChart
        crownTeeth={new Set(["1"])}
        ponticTeeth={new Set(["2"])}
        missingTeeth={new Set(["3"])}
        billedTeeth={new Set(["4"])}
        selected={new Set(["1"])}
        connectedPairs={new Set(["1-2"])}
        summaryText="2 units · 1 connected group"
      />
    </section>
    <section data-testid="mobile-editable-panel" style={panelStyle}>
      <div style={{ width: "100%" }}>
        <ToothChart
          readOnly={false}
          onToothClick={() => {}}
          crownTeeth={new Set(["1", "2"])}
          connectedPairs={new Set(["1-2"])}
          onConnectedPairsChange={() => {}}
          summaryText="2 prepared units"
        />
      </div>
    </section>
  </main>,
);
