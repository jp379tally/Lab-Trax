import crown from "../../labtrax/assets/images/tooth-atlas-crown.png";
import missing from "../../labtrax/assets/images/tooth-atlas-missing.png";
import pontic from "../../labtrax/assets/images/tooth-atlas-pontic.png";
import unassigned from "../../labtrax/assets/images/tooth-atlas-unassigned.png";
import veneer from "../../labtrax/assets/images/tooth-atlas-veneer.png";

const assets: Record<string, string> = {
  "../assets/images/tooth-atlas-crown.png": crown,
  "../assets/images/tooth-atlas-missing.png": missing,
  "../assets/images/tooth-atlas-pontic.png": pontic,
  "../assets/images/tooth-atlas-unassigned.png": unassigned,
  "../assets/images/tooth-atlas-veneer.png": veneer,
};

(globalThis as typeof globalThis & { require?: (path: string) => string }).require =
  (path) => {
    const asset = assets[path];
    if (!asset) throw new Error(`Unexpected tooth-chart fixture asset: ${path}`);
    return asset;
  };
