import React from "react";
import { createRoot } from "react-dom/client";
import { ToothChart } from "@/components/ToothChart";
import "@/index.css";

// Component-only fixture: it renders no app shell or protected case data.
const panelWidth = new URLSearchParams(window.location.search).get("panelWidth") ?? "320";

document.documentElement.style.background = "#f8fafc";
document.body.style.margin = "0";
document.body.style.padding = "12px";

createRoot(document.getElementById("root")!).render(
  <main
    data-testid="tooth-chart-panel"
    style={{
      width: `min(${panelWidth}px, calc(100vw - 24px))`,
      margin: "0 auto",
    }}
  >
    <ToothChart
      value="1, 2, 3"
      onChange={() => {}}
      onToothClick={() => {}}
      crownTeeth={new Set(["1"])}
      ponticTeeth={new Set(["2"])}
      missingTeeth={new Set(["3"])}
      billedTeeth={new Set(["4"])}
      connectedPairs={new Set(["1-2"])}
      onConnectedPairsChange={() => {}}
      summaryText="3 units · 1 connected group"
    />
  </main>,
);
