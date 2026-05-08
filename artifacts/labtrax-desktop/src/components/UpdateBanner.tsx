import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Download, RefreshCw, X } from "lucide-react";

type Phase = "downloading" | "ready";

interface UpdateState {
  phase: Phase;
  version: string;
  percent: number;
  releaseNotes: string | null;
}

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          releaseNotes: prev?.releaseNotes ?? null,
        };
      });
    });

    const unsubDownloaded = api.onUpdateDownloaded(
      (info: { version: string; releaseNotes: string | null }) => {
        setUpdate({
          phase: "ready",
          version: info.version ?? "",
          percent: 100,
          releaseNotes: info.releaseNotes ?? null,
        });
        setDismissed(false);
        // Auto-expand notes on first arrival so users see them immediately.
        if (info.releaseNotes) {
          setNotesExpanded(true);
        }
      },
    );

    return () => {
      unsubProgress?.();
      unsubDownloaded?.();
      if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    };
  }, []);

  if (!update || dismissed) return null;

  async function handleInstall() {
    const api = (window as any).electronAPI;
    if (!api) return;
    setInstalling(true);
    await api.installUpdate();
  }

  function handleDismiss() {
    setDismissed(true);
    if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
  }

  function handleSnooze() {
    setDismissed(true);
    snoozeTimerRef.current = setTimeout(() => {
      setDismissed(false);
    }, 60 * 60 * 1000);
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

  const hasNotes = Boolean(update.releaseNotes);

  return (
    <div className="shrink-0 border-b border-primary/20 bg-primary/10 text-sm">
      <div className="flex items-center gap-3 px-4 py-2">
        <RefreshCw size={14} className="text-primary shrink-0" />
        <span className="text-primary font-medium flex-1">
          LabTrax{update.version ? ` v${update.version}` : " update"} is ready to install.
        </span>
        {hasNotes && (
          <button
            type="button"
            onClick={() => setNotesExpanded((v) => !v)}
            className="shrink-0 flex items-center gap-1 text-primary/70 hover:text-primary text-xs transition-colors"
            aria-expanded={notesExpanded}
            aria-label="Toggle release notes"
          >
            {notesExpanded ? (
              <>
                Hide notes <ChevronUp size={12} />
              </>
            ) : (
              <>
                What&apos;s new <ChevronDown size={12} />
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={handleInstall}
          disabled={installing}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={12} className={installing ? "animate-spin" : ""} />
          {installing ? "Restarting…" : "Restart & Update"}
        </button>
        <button
          type="button"
          onClick={handleSnooze}
          title="Remind me in 1 hour"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-primary/70 text-xs hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <Clock size={12} />
          1 hr
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          title="Dismiss"
          aria-label="Dismiss update banner"
          className="shrink-0 p-1 rounded-md text-primary/60 hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {hasNotes && notesExpanded && (
        <div className="px-4 pb-3">
          <div className="rounded-md border border-primary/20 bg-background/60 px-3 py-2 max-h-48 overflow-y-auto">
            <p className="text-[11px] font-semibold text-primary/60 uppercase tracking-wide mb-1.5">
              Release notes
            </p>
            <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-sans leading-relaxed">
              {update.releaseNotes}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
