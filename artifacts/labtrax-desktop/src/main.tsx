import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/print.css";
import { registerPwaUpdates } from "./pwa-updater";

createRoot(document.getElementById("root")!).render(<App />);

registerPwaUpdates();
