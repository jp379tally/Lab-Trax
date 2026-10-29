import React from "react";
import { createRoot } from "react-dom/client";
import { ToothChart } from "@/components/ToothChart";
import "@/index.css";

// Component-only fixture: it renders no app shell or protected case data.
const panelWidth = new URLSearchParams(window.location.search).get("panelWidth") ?? "320";
const bridgeScenario = new URLSearchParams(window.location.search).get("scenario") === "bridge";

document.documentElement.style.background = "#f8fafc";
document.body.style.margin = "0";
document.body.style.padding = "12px";

createRoot(document.getElementById("root")!).render(
  <main
    data-testid="tooth-chart-panel"
    style={{
      width: `min(${panelWidth}px, calc(100vw - 24px))`,
      margin: "0 auto",
      display: bridgeScenario ? "grid" : "block",
      gridTemplateColumns: bridgeScenario ? "minmax(0, 1.35fr) minmax(250px, 0.8fr)" : undefined,
      alignItems: "start",
      gap: "20px",
      padding: bridgeScenario ? "20px" : undefined,
      borderRadius: bridgeScenario ? "16px" : undefined,
      background: bridgeScenario ? "#ffffff" : undefined,
      boxShadow: bridgeScenario ? "0 12px 36px rgba(15, 23, 42, .10)" : undefined,
    }}
  >
    <div>
      {bridgeScenario && <h1 style={{ margin: "0 0 12px", font: "600 20px system-ui", color: "#172b3a" }}>Tooth &amp; Restoration Assignment</h1>}
      <ToothChart
        value={bridgeScenario ? "2, 3, 4" : "1, 2, 3"}
        onChange={() => {}}
        onToothClick={() => {}}
        crownTeeth={new Set(bridgeScenario ? ["2", "4"] : ["1"])}
        ponticTeeth={new Set(bridgeScenario ? ["3"] : ["2"])}
        missingTeeth={new Set(bridgeScenario ? [] : ["3"])}
        billedTeeth={new Set(bridgeScenario ? [] : ["4"])}
        connectedPairs={new Set(bridgeScenario ? ["2-3", "3-4"] : ["1-2"])}
        onConnectedPairsChange={() => {}}
        summaryText={bridgeScenario ? "3 units · 2 crowns · 1 pontic · 1 connected group" : "3 units · 1 connected group"}
      />
    </div>
    {bridgeScenario && (
      <aside style={{ paddingTop: "44px", font: "13px/1.55 system-ui", color: "#334155" }}>
        <h2 style={{ margin: "0 0 10px", fontSize: "14px", color: "#172b3a" }}>Assigned restorations</h2>
        <div style={{ border: "1px solid #dbe4e8", borderRadius: "10px", padding: "10px", marginBottom: "8px" }}>
          <strong>#2 · Crown</strong><br /><span style={{ color: "#64748b" }}>Zirconia · A2</span>
        </div>
        <div style={{ border: "1px solid #dbe4e8", borderRadius: "10px", padding: "10px", marginBottom: "8px" }}>
          <strong>#3 · Pontic</strong><br /><span style={{ color: "#64748b" }}>Zirconia · A2</span>
        </div>
        <div style={{ border: "1px solid #dbe4e8", borderRadius: "10px", padding: "10px", marginBottom: "8px" }}>
          <strong>#4 · Crown</strong><br /><span style={{ color: "#64748b" }}>Zirconia · A2</span>
        </div>
        <p style={{ marginTop: "14px", fontWeight: 600 }}>Bridge membership</p>
        <p style={{ padding: "9px 10px", borderRadius: "10px", background: "#ecfdf5", color: "#047857" }}>#2 – #3 – #4 · 3 connected units</p>
      </aside>
    )}
  </main>,
);
