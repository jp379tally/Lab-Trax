import { FileDown, RefreshCw } from "lucide-react";

export type AuthorizationRecord = {
  id: string;
  authorizationType: "card_on_file" | "autopay";
  originalFilename: string;
  byteSize?: number | null;
  uploaderUserId: string;
  createdAt: string;
  supersedesDocumentId?: string | null;
  status: "current" | "superseded";
};

export function AuthorizationHistory({
  records,
  onView,
  onDownload,
  onReplace,
}: {
  records: AuthorizationRecord[];
  onView: (record: AuthorizationRecord) => void;
  onDownload: (record: AuthorizationRecord) => void;
  onReplace?: (record: AuthorizationRecord) => void;
}) {
  return (
    <section data-testid="authorization-history" className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Completed authorizations</h3>
        <p className="text-xs text-muted-foreground mt-1">Immutable signed PDFs retained for your practice.</p>
      </div>
      {records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No completed authorization PDFs on file.</p>
      ) : records.map((record) => (
        <div key={record.id} data-testid={`authorization-record-${record.id}`} className="flex items-center gap-3 border-t border-border pt-3 text-xs">
          <FileDown size={15} className="text-muted-foreground" />
          <span className="flex-1">
            <strong>{record.authorizationType === "card_on_file" ? "Card on File" : "Auto-Pay"}</strong>
            <br />
            <span className="text-muted-foreground">
              {record.originalFilename} · {new Date(record.createdAt).toLocaleDateString()}
              {record.byteSize ? ` · ${record.byteSize.toLocaleString()} bytes` : ""}
            </span>
          </span>
          <span
            data-testid={`authorization-status-${record.id}`}
            className={record.status === "current" ? "text-emerald-600" : "text-muted-foreground"}
          >
            {record.status === "current" ? "Current" : "Superseded"}
          </span>
          <button type="button" data-testid={`button-view-authorization-${record.id}`} onClick={() => onView(record)} className="px-2 py-1 rounded hover:bg-secondary">View</button>
          <button type="button" data-testid={`button-download-authorization-${record.id}`} onClick={() => onDownload(record)} className="px-2 py-1 rounded hover:bg-secondary">Download</button>
          {record.status === "current" && onReplace && (
            <button type="button" data-testid={`button-replace-authorization-${record.id}`} onClick={() => onReplace(record)} className="px-2 py-1 rounded hover:bg-secondary inline-flex items-center gap-1">
              <RefreshCw size={12} /> Replace
            </button>
          )}
        </div>
      ))}
    </section>
  );
}