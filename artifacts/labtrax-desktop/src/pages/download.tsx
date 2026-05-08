import { Download, FolderOpen, Monitor, Package } from "lucide-react";

const VERSION = "1.0.0";
const ZIP_NAME = "LabTrax-Windows-Portable.zip";
const DOWNLOAD_URL = "/downloads/" + ZIP_NAME;

export default function DownloadPage() {
  return (
    <div className="px-8 py-7 max-w-[760px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Download LabTrax Desktop</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Install the native Windows desktop app for the best LabTrax experience.
        </p>
      </div>

      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start gap-5">
          <div className="shrink-0 h-16 w-16 rounded-xl bg-primary/10 flex items-center justify-center">
            <Monitor size={32} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="text-lg font-semibold">LabTrax Desktop for Windows</h2>
              <span className="text-xs font-medium bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">
                v{VERSION}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Portable ZIP — no installer required. Works on Windows 10 and 11 (64-bit).
            </p>
            <a
              href={DOWNLOAD_URL}
              download={ZIP_NAME}
              className="mt-4 inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-5 py-2.5 rounded-md transition-colors"
            >
              <Download size={16} />
              Download LabTrax-Windows-Portable.zip
            </a>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg divide-y divide-border">
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold mb-3">Installation instructions</h3>
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                1
              </span>
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Download size={14} className="text-muted-foreground" />
                  Download the ZIP
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Click the download button above. The file is approximately 145 MB.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                2
              </span>
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Package size={14} className="text-muted-foreground" />
                  Extract the ZIP
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Right-click the downloaded ZIP and choose <strong>Extract All…</strong> to unzip
                  it to a folder of your choice (e.g. <code className="text-xs bg-secondary px-1 py-0.5 rounded">C:\LabTrax</code>).
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                3
              </span>
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderOpen size={14} className="text-muted-foreground" />
                  Run LabTrax.exe
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Open the extracted folder and double-click <strong>LabTrax.exe</strong> to launch
                  the app. No installation or admin rights required.
                </p>
              </div>
            </li>
          </ol>
        </div>
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold mb-1">Notes</h3>
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc list-inside">
            <li>
              Windows may show a SmartScreen warning on first launch — click{" "}
              <strong>More info</strong> then <strong>Run anyway</strong> to proceed.
            </li>
            <li>
              The app connects to your LabTrax server automatically — no extra configuration needed.
            </li>
            <li>
              Keep the entire extracted folder together; <strong>LabTrax.exe</strong> requires the
              other files in that folder to run.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
