import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

type Phase = "downloading" | "ready";

interface UpdateState {
  phase: Phase;
  version: string;
  percent: number;
}

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    const unsubProgress = api.onUpdateDownloadProgress((percent: number) => {
      setUpdate((prev) => {
        if (prev?.phase === "ready") return prev;
        return {
          phase: "downloading",
          version: prev?.version ?? "",
          percent,
        };
      });
    });

    const unsubDownloaded = api.onUpdateDownloaded((version: string) => {
      setUpdate({ phase: "ready", version, percent: 100 });
    });

    return () => {
      unsubProgress?.();
      unsubDownloaded?.();
    };
  }, []);

  if (!update) return null;

  async function handleInstall() {
    const api = (window as any).electronAPI;
    if (!api) return;
    setInstalling(true);
    await api.installUpdate();
  }

  if (update.phase === "downloading") {
    return (
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-primary/10 border-b border-primary/20 text-sm">
        <Download size={14} className="text-primary shrink-0 animate-bounce" />
        <span className="text-primary font-medium">
          Downloading update{update.version ? ` v${update.version}` : ""}…
        </span>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={update.percent}
          aria-label="Update download progress"
          className="flex-1 max-w-[160px] h-1.5 rounded-full bg-primary/20 overflow-hidden"
        >
          <div
            className="h-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${update.percent}%` }}
          />
        </div>
        <span className="text-primary/70 tabular-nums text-xs">{update.percent}%</span>
      </div>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-primary/10 border-b border-primary/20 text-sm">
      <RefreshCw size={14} className="text-primary shrink-0" />
      <span className="text-primary font-medium flex-1">
        LabTrax{update.version ? ` v${update.version}` : " update"} is ready to install.
      </span>
      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        <RefreshCw size={12} className={installing ? "animate-spin" : ""} />
        {installing ? "Restarting…" : "Restart & Update"}
      </button>
    </div>
  );
}
