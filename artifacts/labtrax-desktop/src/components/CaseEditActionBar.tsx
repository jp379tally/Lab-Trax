import { AlertTriangle, Loader2 } from "lucide-react";

interface CaseEditActionBarProps {
  editor?: {
    onCancel: () => void;
    onSave: () => void;
    disabled: boolean;
    error: string | null;
  };
  restorationEditor?: {
    onCancel: () => void;
    onAdd: () => void;
    error: string | null;
    disabled: boolean;
  };
  pending?: {
    onDiscard: () => void;
    onSave: () => void;
    isSaving: boolean;
    error: string | null;
  };
}

/** A flex sibling of the drawer's scroll pane, never an overlay on its fields. */
export function CaseEditActionBar({ editor, restorationEditor, pending }: CaseEditActionBarProps) {
  if (!editor && !restorationEditor && !pending) return null;

  return (
    <footer
      data-testid="case-edit-action-bar"
      aria-label="Case edit actions"
      className="shrink-0 border-t border-border bg-card px-3 sm:px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-3"
    >
      {editor && (
        <>
        {editor.error && <p role="alert" className="text-xs text-destructive break-words">{editor.error}</p>}
        <div data-testid="case-details-edit-actions" className="flex gap-2">
          <button
            type="button"
            data-testid="case-details-edit-cancel"
            onClick={editor.onCancel}
            disabled={editor.disabled}
            className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="case-details-edit-save"
            onClick={editor.onSave}
            disabled={editor.disabled}
            className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
          >
            {editor.disabled && <Loader2 size={13} className="animate-spin" />}
            {editor.disabled ? "Saving…" : "Save changes"}
          </button>
        </div>
        </>
      )}
      {restorationEditor && (
        <>
          {restorationEditor.error && <p role="alert" className="text-xs text-destructive break-words">{restorationEditor.error}</p>}
          <div data-testid="case-restoration-edit-actions" className="flex gap-2">
            <button type="button" onClick={restorationEditor.onCancel} disabled={restorationEditor.disabled} className="flex-1 min-w-0 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={restorationEditor.onAdd} disabled={restorationEditor.disabled} className="flex-1 min-w-0 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              Add restoration
            </button>
          </div>
        </>
      )}
      {pending && (
        <div
          data-testid="case-pending-actions"
          className="rounded-md px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 flex flex-wrap items-center gap-3"
        >
          <div className="flex flex-1 min-w-[8rem] items-start gap-2">
            <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="min-w-0">
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Unsaved changes
              </span>
              {pending.error && (
                <p role="alert" className="text-xs text-destructive break-words">
                  {pending.error}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="case-pending-discard"
              onClick={pending.onDiscard}
              disabled={pending.isSaving}
              className="h-8 min-w-[4.5rem] px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            >
              Discard
            </button>
            <button
              type="button"
              data-testid="case-pending-save"
              onClick={pending.onSave}
              disabled={pending.isSaving}
              className="h-8 min-w-[6.25rem] px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              {pending.isSaving && <Loader2 size={11} className="animate-spin" />}
              {pending.isSaving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
