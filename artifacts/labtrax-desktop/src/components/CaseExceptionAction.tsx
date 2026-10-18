import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Loader2,
  Lock,
  Pause,
  Upload,
  Mic,
  MicOff,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import {
  ApiError,
  apiFetch,
  apiUrl,
  getAccessToken,
  getApiOrigin,
} from "@/lib/api";
import { AuthedImage } from "@/components/AuthedMedia";
import { uploadMediaFile } from "@/lib/upload-media-file";
import { formatDateTime } from "@/lib/format";
import type {
  CreateCaseExceptionRequest,
  CaseExceptionDetail,
  CaseExceptionSummary,
} from "@/lib/types";
import { EXCEPTION_QUEUE_QUERY_KEY } from "@/components/ExceptionCasesCard";

export const CASE_ACTION_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 h-8 min-w-32 rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-colors shrink-0";

export const EXCEPTION_FILE_INPUT_CLASS =
  "text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-primary file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground file:transition-colors hover:file:bg-primary/90";

interface LabLocationOption {
  id: string;
  name: string;
  status: string;
}

export const EXCEPTION_DESTINATION_LOCATIONS_QUERY_KEY = [
  "case-exception-destination-locations",
] as const;

export const EXCEPTION_CREATE_LOCATIONS_QUERY_KEY = [
  "case-exception-create-locations",
] as const;

/**
 * Invalidate every surface that shows exception state: the dashboard queue,
 * the case list (which carries `hasActiveException`), the case detail, and
 * the exception detail itself.
 */
function useExceptionRefresh(caseId: string) {
  const qc = useQueryClient();
  return (exceptionId?: string) => {
    void qc.invalidateQueries({ queryKey: EXCEPTION_QUEUE_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["cases"] });
    void qc.invalidateQueries({ queryKey: ["case", caseId] });
    if (exceptionId) {
      void qc.invalidateQueries({
        queryKey: ["case-exception", exceptionId],
      });
    }
  };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

function useBrowserExceptionDictation({
  active,
  setText,
  fieldName,
}: {
  active: boolean;
  setText: React.Dispatch<React.SetStateAction<string>>;
  fieldName: string;
}) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
  } | null>(null);
  const sessionRef = useRef(0);
  const activeRef = useRef(active);

  function cancel() {
    sessionRef.current += 1;
    const current = recorderRef.current;
    recorderRef.current = null;
    if (current) {
      try {
        current.recorder.stop();
      } catch {
        // It may already be stopped.
      }
      current.stream.getTracks().forEach((track) => track.stop());
    }
    setState("idle");
  }

  useEffect(() => {
    activeRef.current = active;
    if (!active) cancel();
  }, [active]);

  useEffect(
    () => () => {
      activeRef.current = false;
      cancel();
    },
    [],
  );

  async function start() {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        `Microphone recording isn't supported in this browser. You can still type the ${fieldName}.`,
      );
      return;
    }
    cancel();
    const session = ++sessionRef.current;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== sessionRef.current || !activeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorderRef.current = { recorder, stream };
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (session !== sessionRef.current) return;
        recorderRef.current = null;
        setState("idle");
        setError(`Recording failed. Please try again or type the ${fieldName}.`);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (recorderRef.current?.recorder === recorder) recorderRef.current = null;
        if (session !== sessionRef.current || !activeRef.current) return;
        const audio = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        if (audio.size === 0) {
          setState("idle");
          setError(
            `No audio was captured. Please try again or type the ${fieldName}.`,
          );
          return;
        }
        setState("transcribing");
        try {
          const token = getAccessToken();
          const formData = new FormData();
          formData.append("audio", audio, "exception-note.webm");
          const response = await fetch(apiUrl("/ai-stt"), {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          });
          const body = (await response.json().catch(() => ({}))) as {
            transcript?: string;
            error?: string;
          };
          if (session !== sessionRef.current || !activeRef.current) return;
          if (!response.ok) {
            setError(
              body.error ||
                `Voice transcription is temporarily unavailable. You can still type the ${fieldName}.`,
            );
          } else {
            const transcript = body.transcript?.trim() ?? "";
            if (transcript) {
              setText((current) =>
                current.trim()
                  ? `${current.trimEnd()}\n${transcript}`
                  : transcript,
              );
            } else {
              setError(
                `No speech was detected. Please try again or type the ${fieldName}.`,
              );
            }
          }
        } catch {
          if (session === sessionRef.current && activeRef.current) {
            setError(
              `Voice transcription is temporarily unavailable. You can still type the ${fieldName}.`,
            );
          }
        } finally {
          if (session === sessionRef.current && activeRef.current) setState("idle");
        }
      };
      recorder.start();
      setState("recording");
    } catch (err) {
      if (session !== sessionRef.current || !activeRef.current) return;
      const name = (err as { name?: string }).name;
      setError(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Microphone access is blocked. Allow it in your browser or OS settings, then try again."
          : `Couldn't access the microphone. Please try again or type the ${fieldName}.`,
      );
      setState("idle");
    }
  }

  function stop() {
    const current = recorderRef.current;
    if (!current) return;
    setState("transcribing");
    try {
      current.recorder.stop();
    } catch {
      setState("idle");
      setError(`Recording failed. Please try again or type the ${fieldName}.`);
    }
  }

  return { state, error, start, stop, cancel };
}

function Overlay({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 p-4"
      data-testid={testId}
    >
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-card border border-border rounded-xl shadow-2xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-500" />
            {title}
          </h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The "Exception case" control that sits beside the patient name on the case
 * overview, plus the create and detail/resolve dialogs it opens.
 *
 * Creation is open to any active lab member; the resolve form only renders
 * when the server says the viewer is an owner/admin (`viewerCanResolve`).
 * The server enforces both regardless of what the UI shows.
 */
export function CaseExceptionAction({
  caseId,
  labOrganizationId,
  activeException,
}: {
  caseId: string;
  labOrganizationId: string | null | undefined;
  activeException: CaseExceptionSummary | null | undefined;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  if (activeException) {
    return (
      <>
        <button
          type="button"
          data-testid="case-exception-open"
          onClick={() => setDetailOpen(true)}
          className={CASE_ACTION_BUTTON_CLASS}
          title="View this case's exception"
        >
          <AlertTriangle size={14} />
          Exception case
        </button>
        {detailOpen && (
          <ExceptionDetailDialog
            caseId={caseId}
            labOrganizationId={labOrganizationId}
            exceptionId={activeException.id}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        data-testid="case-exception-create"
        onClick={() => setCreateOpen(true)}
        className={CASE_ACTION_BUTTON_CLASS}
        title="Create an exception case"
      >
        <AlertTriangle size={14} />
        Create Exception Case
      </button>
      {createOpen && (
        <ExceptionCreateDialog
          caseId={caseId}
          labOrganizationId={labOrganizationId}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </>
  );
}

function ExceptionCreateDialog({
  caseId,
  labOrganizationId,
  onClose,
}: {
  caseId: string;
  labOrganizationId: string | null | undefined;
  onClose: () => void;
}) {
  const [issueText, setIssueText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [putOnHold, setPutOnHold] = useState<boolean | null>(null);
  const [labLocationId, setLabLocationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dictation = useBrowserExceptionDictation({
    active: true,
    setText: setIssueText,
    fieldName: "issue",
  });
  const dictationError = dictation.error;
  const dictationState = dictation.state;
  const cancelDictation = dictation.cancel;
  const startDictation = dictation.start;
  const stopDictation = dictation.stop;
  const refresh = useExceptionRefresh(caseId);
  const locationsQuery = useQuery<LabLocationOption[]>({
    enabled: putOnHold === false && !!labOrganizationId,
    queryKey: [...EXCEPTION_CREATE_LOCATIONS_QUERY_KEY, labOrganizationId],
    queryFn: () =>
      apiFetch<LabLocationOption[]>(
        `/locations?organizationId=${labOrganizationId}&activeOnly=true`,
      ),
  });
  const locations = locationsQuery.data ?? [];
  const selectedLocationIsValid = locations.some(
    (location) => location.id === labLocationId,
  );
  const locationState = !labOrganizationId
    ? "unavailable"
    : locationsQuery.isPending
      ? "loading"
      : locationsQuery.isError
        ? "error"
        : locations.length === 0
          ? "empty"
          : "ready";
  const canSubmit =
    putOnHold === true ||
    (putOnHold === false &&
      locationState === "ready" &&
      selectedLocationIsValid);

  function closeDialog() {
    cancelDictation();
    onClose();
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (putOnHold === null) {
        throw new Error("Choose whether to put this case on hold.");
      }
      if (putOnHold === false && !selectedLocationIsValid) {
        throw new Error("Choose an active current location.");
      }
      const request: CreateCaseExceptionRequest =
        putOnHold === true
          ? {
              caseId,
              putOnHold: true,
              ...(issueText.trim() ? { issueText: issueText.trim() } : {}),
            }
          : {
              caseId,
              putOnHold: false,
              labLocationId,
              ...(issueText.trim() ? { issueText: issueText.trim() } : {}),
            };
      const created = await apiFetch<CaseExceptionSummary>("/case-exceptions", {
        method: "POST",
        body: JSON.stringify(request),
      });
      // Media is optional and best-effort: the exception itself is already
      // created, so a failed upload must not roll the user back to the form.
      const failures: string[] = [];
      for (const file of files) {
        try {
          const { url } = await uploadMediaFile(file);
          await apiFetch(`/cases/${caseId}/attachments`, {
            method: "POST",
            body: JSON.stringify({
              storageKey: url,
              fileName: file.name,
              fileType: file.type || "application/octet-stream",
              caseExceptionId: created.id,
            }),
          });
        } catch (err) {
          failures.push(`${file.name}: ${errorMessage(err, "upload failed")}`);
        }
      }
      return { created, failures };
    },
    onSuccess: ({ created, failures }) => {
      refresh(created.id);
      if (failures.length > 0) {
        setError(
          `Exception created, but some files failed — ${failures.join(" · ")}`,
        );
        setFiles([]);
        return;
      }
      closeDialog();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.status === 409
          ? "This case already has an active exception."
          : errorMessage(err, "Could not create this exception case."),
      );
    },
  });

  const statusCard = (selected: boolean) =>
    `flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      selected
        ? "border-primary bg-primary/10"
        : "border-border bg-card hover:bg-secondary"
    }`;
  const radioDot = (selected: boolean) => (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
        selected ? "border-primary" : "border-input"
      }`}
    >
      {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
    </span>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 p-4"
      data-testid="case-exception-create-dialog"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="exception-create-title"
        className="flex w-full max-w-4xl max-h-[90vh] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header
          data-testid="case-exception-create-header"
          className="flex items-start gap-3 border-b border-border px-5 py-4"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
            <AlertTriangle size={20} className="text-amber-500" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="exception-create-title" className="text-base font-semibold">
              Create Exception Case
            </h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock size={11} />
              Notes and files added here are internal to your lab.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeDialog}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[1.6fr_1fr]">
          <div
            data-testid="case-exception-create-left-column"
            className="space-y-5 p-5"
          >
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label htmlFor="exception-issue" className="text-sm font-semibold">
                  Issue Details{" "}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    Optional
                  </span>
                </label>
                <button
                  type="button"
                  data-testid="case-exception-dictation"
                  disabled={mutation.isPending || dictationState === "transcribing"}
                  onClick={() => {
                    if (dictationState === "recording") {
                      stopDictation();
                    } else {
                      void startDictation();
                    }
                  }}
                  aria-label={
                    dictationState === "recording"
                      ? "Stop recording issue description"
                      : dictationState === "transcribing"
                        ? "Transcribing issue description"
                        : "Dictate issue description"
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary bg-card px-3 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  {dictationState === "recording" ? (
                    <Square size={11} fill="currentColor" />
                  ) : dictationState === "transcribing" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : dictationError ? (
                    <MicOff size={13} />
                  ) : (
                    <Mic size={13} />
                  )}
                  {dictationState === "recording"
                    ? "Stop recording"
                    : dictationState === "transcribing"
                      ? "Transcribing…"
                      : "Dictate"}
                </button>
              </div>
              <textarea
                id="exception-issue"
                data-testid="case-exception-issue-input"
                value={issueText}
                onChange={(e) => setIssueText(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                placeholder="Describe what needs attention…"
              />
              {dictationState === "recording" ? (
                <p
                  className="mt-1 text-[11px] text-destructive"
                  data-testid="case-exception-dictation-status"
                  role="status"
                  aria-live="polite"
                >
                  Recording issue description — tap Dictate to stop.
                </p>
              ) : dictationState === "transcribing" ? (
                <p
                  className="mt-1 text-[11px] text-muted-foreground"
                  data-testid="case-exception-dictation-status"
                  role="status"
                  aria-live="polite"
                >
                  Transcribing your recording…
                </p>
              ) : null}
              {dictationError ? (
                <p
                  className="mt-1 text-[11px] text-destructive"
                  data-testid="case-exception-dictation-error"
                  role="alert"
                >
                  {dictationError}
                </p>
              ) : null}
            </section>

            <section>
              <label htmlFor="exception-files" className="mb-2 block text-sm font-semibold">
                Photos &amp; Files{" "}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  Optional
                </span>
              </label>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
                <Upload size={22} className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">Add Supporting Files</p>
                  {files.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      {files.length} file{files.length === 1 ? "" : "s"} selected
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      No files selected
                    </p>
                  )}
                  <input
                    id="exception-files"
                    data-testid="case-exception-file-input"
                    type="file"
                    multiple
                    className={`${EXCEPTION_FILE_INPUT_CLASS} mt-2 max-w-full`}
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  />
                </div>
              </div>
            </section>
          </div>

          <aside
            data-testid="case-exception-create-right-column"
            className="border-t border-border bg-secondary/50 p-5 md:border-l md:border-t-0"
          >
            <fieldset>
              <legend className="text-sm font-semibold">Production Status</legend>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Should this case continue?
              </p>
              <span className="sr-only">Do you want to put this case on hold?</span>
              <div className="mt-3 space-y-2">
                <button
                  type="button"
                  data-testid="case-exception-put-on-hold-no"
                  aria-pressed={putOnHold === false}
                  disabled={mutation.isPending}
                  onClick={() => {
                    setPutOnHold(false);
                    setError(null);
                  }}
                  className={statusCard(putOnHold === false)}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {radioDot(putOnHold === false)}
                    Keep Active
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground">
                    Continue through production.
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="case-exception-put-on-hold-yes"
                  aria-pressed={putOnHold === true}
                  disabled={mutation.isPending}
                  onClick={() => {
                    setPutOnHold(true);
                    setLabLocationId("");
                    setError(null);
                  }}
                  className={statusCard(putOnHold === true)}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {radioDot(putOnHold === true)}
                    <Pause size={14} className="text-amber-500" />
                    Place on Hold
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground">
                    Pause production for this case.
                  </span>
                </button>
              </div>
            </fieldset>

            <div className="mt-5" data-testid="case-exception-create-location-section">
              <label
                className="mb-1 block text-sm font-semibold"
                htmlFor="exception-current-location"
              >
                Current Location
              </label>
              {putOnHold === false ? (
                <>
                  <span className="sr-only">Where is the case currently located?</span>
                  {locationState === "loading" && (
                    <p
                      className="mb-1 text-[11px] text-muted-foreground"
                      data-testid="case-exception-create-location-loading"
                      role="status"
                    >
                      Loading active locations…
                    </p>
                  )}
                  {locationState === "unavailable" && (
                    <p
                      className="mb-1 text-[11px] text-muted-foreground"
                      data-testid="case-exception-create-location-unavailable"
                      role="status"
                    >
                      Active locations are unavailable for this case.
                    </p>
                  )}
                  {locationState === "error" && (
                    <div
                      className="mb-1 flex items-center justify-between gap-2 text-[11px] text-destructive"
                      data-testid="case-exception-create-location-error"
                      role="alert"
                    >
                      <span>Couldn't load active locations.</span>
                      <button
                        type="button"
                        data-testid="case-exception-create-location-retry"
                        onClick={() => void locationsQuery.refetch()}
                        className="shrink-0 rounded border border-input bg-card px-2 py-1 text-foreground hover:bg-secondary"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {locationState === "empty" && (
                    <p
                      className="mb-1 text-[11px] text-muted-foreground"
                      data-testid="case-exception-create-location-empty"
                      role="status"
                    >
                      No active locations are available.
                    </p>
                  )}
                  <select
                    id="exception-current-location"
                    data-testid="case-exception-create-location-select"
                    value={labLocationId}
                    onChange={(e) => setLabLocationId(e.target.value)}
                    disabled={locationState !== "ready" || mutation.isPending}
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs disabled:opacity-60"
                  >
                    <option value="">
                      {locationState === "loading"
                        ? "Loading locations…"
                        : locationState === "error"
                          ? "Locations unavailable"
                          : locationState === "empty"
                            ? "No active locations"
                            : locationState === "unavailable"
                              ? "Locations unavailable"
                              : "Select current location"}
                    </option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className="rounded-md border border-dashed border-input px-2.5 py-2 text-xs text-muted-foreground">
                  {putOnHold === true
                    ? "Held cases are placed at On Hold."
                    : "Choose Keep Active to set the case's location."}
                </p>
              )}
            </div>
          </aside>
        </div>

        {error && (
          <p
            className="border-t border-border px-5 py-2 text-xs text-destructive"
            data-testid="case-exception-create-error"
          >
            {error}
          </p>
        )}

        <footer
          data-testid="case-exception-create-footer"
          className="flex justify-end gap-2 border-t border-border px-5 py-3"
        >
          <button
            type="button"
            data-testid="case-exception-create-cancel"
            onClick={closeDialog}
            className="h-9 rounded-md border border-input bg-secondary px-4 text-xs font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="case-exception-create-submit"
            disabled={mutation.isPending || !canSubmit}
            onClick={() => {
              cancelDictation();
              setError(null);
              mutation.mutate();
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground disabled:opacity-60"
          >
            {mutation.isPending && <Loader2 size={12} className="animate-spin" />}
            Create Exception Case
          </button>
        </footer>
      </div>
    </div>
  );
}

function ExceptionDetailDialog({
  caseId,
  labOrganizationId,
  exceptionId,
  onClose,
}: {
  caseId: string;
  labOrganizationId: string | null | undefined;
  exceptionId: string;
  onClose: () => void;
}) {
  const refresh = useExceptionRefresh(caseId);
  const [destination, setDestination] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [additionalNote, setAdditionalNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noteDictation = useBrowserExceptionDictation({
    active: true,
    setText: setAdditionalNote,
    fieldName: "note",
  });

  const detailQuery = useQuery({
    queryKey: ["case-exception", exceptionId],
    queryFn: () =>
      apiFetch<CaseExceptionDetail>(`/case-exceptions/${exceptionId}`),
  });

  const detail = detailQuery.data;
  const locationsQuery = useQuery<LabLocationOption[]>({
    enabled:
      !!labOrganizationId &&
      detail?.status === "active" &&
      detail.viewerCanResolve === true,
    queryKey: [...EXCEPTION_DESTINATION_LOCATIONS_QUERY_KEY, labOrganizationId],
    queryFn: () =>
      apiFetch<LabLocationOption[]>(
        `/locations?organizationId=${labOrganizationId}&activeOnly=true`,
      ),
  });

  const uploadMutation = useMutation({
    mutationFn: async (fileList: File[]) => {
      for (const file of fileList) {
        const { url } = await uploadMediaFile(file);
        await apiFetch(`/cases/${caseId}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            storageKey: url,
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
            caseExceptionId: exceptionId,
          }),
        });
      }
    },
    onSuccess: () => refresh(exceptionId),
    onError: (err) => setError(errorMessage(err, "Could not upload the file.")),
  });

  const noteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/case-exceptions/${exceptionId}/notes`, {
        method: "POST",
        body: JSON.stringify({ noteText: additionalNote.trim() }),
      }),
    onSuccess: () => {
      setAdditionalNote("");
      setError(null);
      refresh(exceptionId);
    },
    onError: (err) =>
      setError(errorMessage(err, "Could not add the additional note.")),
  });

  const locations = locationsQuery.data ?? [];
  const selectedDestinationIsValid = locations.some(
    (location) => location.id === destination,
  );
  const destinationState = !labOrganizationId
    ? "unavailable"
    : locationsQuery.isPending
      ? "loading"
      : locationsQuery.isError
        ? "error"
        : locations.length === 0
          ? "empty"
          : "ready";
  // The resolution note is mandatory; the destination stays optional.
  const canSubmitResolution =
    !!resolutionNote.trim() &&
    (!destination ||
      (destinationState === "ready" && selectedDestinationIsValid));

  const resolveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/case-exceptions/${exceptionId}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          ...(destination && selectedDestinationIsValid
            ? { labLocationId: destination }
            : {}),
          resolutionNote: resolutionNote.trim(),
        }),
      }),
    onSuccess: () => {
      refresh(exceptionId);
      onClose();
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.status === 403
          ? "Only a lab owner or admin can resolve an exception."
          : errorMessage(err, "Could not resolve this exception."),
      ),
  });

  return (
    <Overlay
      title="Exception case"
      onClose={() => {
        noteDictation.cancel();
        onClose();
      }}
      testId="case-exception-detail-dialog"
    >
      {detailQuery.isPending ? (
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="case-exception-detail-loading"
        >
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : detailQuery.isError || !detail ? (
        <p
          className="text-xs text-destructive"
          data-testid="case-exception-detail-error"
        >
          Couldn't load this exception.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div data-testid="case-exception-conversation">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              Exception conversation
            </div>
            <div className="mt-1 flex flex-col gap-2">
              <div data-testid="case-exception-conversation-original">
                <p className="text-sm whitespace-pre-wrap">
                  {detail.issueText || "No description provided."}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {detail.createdByName ?? "A lab member"} ·{" "}
                  {formatDateTime(detail.createdAt)}
                </p>
              </div>
              {[...detail.notes]
                .sort(
                  (a, b) =>
                    new Date(a.createdAt).getTime() -
                    new Date(b.createdAt).getTime(),
                )
                .map((note) => (
                  <div
                    key={note.id}
                    data-testid={`case-exception-conversation-note-${note.id}`}
                    className="border-l-2 border-border pl-3"
                  >
                    <p className="text-sm whitespace-pre-wrap">{note.noteText}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {note.authorName ?? "A lab member"} ·{" "}
                      {formatDateTime(note.createdAt)}
                    </p>
                  </div>
                ))}
            </div>
            {detail.status === "active" && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label
                    className="block text-xs font-medium"
                    htmlFor="exception-additional-note"
                  >
                    Additional note
                  </label>
                  <button
                    type="button"
                    data-testid="case-exception-note-dictation"
                    disabled={
                      noteMutation.isPending ||
                      noteDictation.state === "transcribing"
                    }
                    onClick={() =>
                      noteDictation.state === "recording"
                        ? noteDictation.stop()
                        : void noteDictation.start()
                    }
                    aria-label={
                      noteDictation.state === "recording"
                        ? "Stop recording additional exception note"
                        : noteDictation.state === "transcribing"
                          ? "Transcribing additional exception note"
                          : "Dictate additional exception note"
                    }
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-secondary px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {noteDictation.state === "recording" ? (
                      <Square size={11} fill="currentColor" />
                    ) : noteDictation.state === "transcribing" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : noteDictation.error ? (
                      <MicOff size={13} />
                    ) : (
                      <Mic size={13} />
                    )}
                    {noteDictation.state === "recording"
                      ? "Stop recording"
                      : noteDictation.state === "transcribing"
                        ? "Transcribing…"
                        : "Dictate"}
                  </button>
                </div>
                <textarea
                  id="exception-additional-note"
                  data-testid="case-exception-note-input"
                  value={additionalNote}
                  onChange={(e) => setAdditionalNote(e.target.value)}
                  rows={3}
                  placeholder="Add additional exception notes."
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs"
                />
                {noteDictation.state !== "idle" && (
                  <p
                    className="mt-1 text-[11px] text-muted-foreground"
                    data-testid="case-exception-note-dictation-status"
                  >
                    {noteDictation.state === "recording"
                      ? "Recording… Select stop when finished."
                      : "Transcribing…"}
                  </p>
                )}
                {noteDictation.error && (
                  <p
                    className="mt-1 text-[11px] text-destructive"
                    data-testid="case-exception-note-dictation-error"
                  >
                    {noteDictation.error}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="case-exception-note-submit"
                  disabled={!additionalNote.trim() || noteMutation.isPending}
                  onClick={() => {
                    noteDictation.cancel();
                    setError(null);
                    noteMutation.mutate();
                  }}
                  className="mt-2 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
                >
                  {noteMutation.isPending && (
                    <Loader2 size={12} className="animate-spin" />
                  )}
                  Submit additional notes
                </button>
              </div>
            )}
          </div>

          <div
            className="rounded-md border border-border bg-secondary/30 px-2.5 py-2"
            data-testid="case-exception-current-location"
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              Current location
            </div>
            <p className="text-sm mt-0.5">
              {detail.currentLocationName ?? "Location unavailable"}
            </p>
            {detail.currentLocationStatus && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Status: {detail.currentLocationStatus.replace(/_/g, " ")}
              </p>
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
              Photos &amp; files
            </div>
            {detail.attachments.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No files attached.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {detail.attachments.map((a) => {
                  const href = `${getApiOrigin()}/api/cases/${caseId}/attachments/${a.id}/file`;
                  const isImage = (a.fileType || "").startsWith("image/");
                  return (
                    <li
                      key={a.id}
                      data-testid={`case-exception-attachment-${a.id}`}
                    >
                      {isImage ? (
                        <AuthedImage
                          url={href}
                          alt={a.fileName}
                          title={a.fileName}
                          className="w-16 h-16 object-cover rounded-md border border-border"
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs rounded-md border border-border px-2 py-1">
                          <Paperclip size={11} />
                          {a.fileName}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {detail.status === "active" && (
              <input
                type="file"
                multiple
                data-testid="case-exception-detail-file-input"
                className={`${EXCEPTION_FILE_INPUT_CLASS} mt-2`}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length === 0) return;
                  setError(null);
                  uploadMutation.mutate(picked);
                }}
              />
            )}
            {uploadMutation.isPending && (
              <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> Uploading…
              </p>
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
              History
            </div>
            <ul className="flex flex-col gap-1">
              {detail.history.map((h, i) => (
                <li key={i} className="text-[11px] text-muted-foreground">
                  {formatDateTime(h.occurredAt ?? "")} ·{" "}
                  {h.type.replace(/_/g, " ")}
                  {h.actorName ? ` · ${h.actorName}` : ""}
                  {h.detail ? ` — ${h.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>

          {detail.status === "active" && detail.viewerCanResolve && (
            <div
              className="border-t border-border pt-4"
              data-testid="case-exception-resolve-form"
            >
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                Resolve
              </div>
              <label
                className="block text-xs font-medium mb-1"
                htmlFor="exception-destination"
              >
                Move case to (optional)
              </label>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Leave this blank to resolve the exception without moving the
                case.
              </p>
              {destinationState === "loading" && (
                <p
                  className="mb-1 text-[11px] text-muted-foreground"
                  data-testid="case-exception-destination-loading"
                  role="status"
                >
                  Loading active locations…
                </p>
              )}
              {destinationState === "unavailable" && (
                <p
                  className="mb-1 text-[11px] text-muted-foreground"
                  data-testid="case-exception-destination-unavailable"
                  role="status"
                >
                  Destination locations are unavailable for this case.
                </p>
              )}
              {destinationState === "error" && (
                <div
                  className="mb-1 flex items-center justify-between gap-2 text-[11px] text-destructive"
                  data-testid="case-exception-destination-error"
                  role="alert"
                >
                  <span>Couldn't load destination locations.</span>
                  <button
                    type="button"
                    data-testid="case-exception-destination-retry"
                    onClick={() => {
                      void locationsQuery.refetch();
                    }}
                    className="shrink-0 rounded border border-input px-2 py-1 text-foreground hover:bg-secondary"
                  >
                    Retry
                  </button>
                </div>
              )}
              {destinationState === "empty" && (
                <p
                  className="mb-1 text-[11px] text-muted-foreground"
                  data-testid="case-exception-destination-empty"
                  role="status"
                >
                  No active destination locations are available.
                </p>
              )}
              <select
                id="exception-destination"
                data-testid="case-exception-destination-select"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                disabled={destinationState !== "ready"}
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">
                  {destinationState === "loading"
                    ? "Loading locations…"
                    : destinationState === "error"
                      ? "Locations unavailable"
                      : destinationState === "empty"
                        ? "No active locations"
                        : destinationState === "unavailable"
                          ? "Locations unavailable"
                          : "Select a location…"}
                </option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
              <label
                className="block text-xs font-medium mt-3 mb-1"
                htmlFor="exception-resolution-note"
              >
                Resolution note (required)
              </label>
              <textarea
                id="exception-resolution-note"
                data-testid="case-exception-resolution-note"
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={3}
                required
                placeholder="How was this resolved?"
                className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs"
              />
              <button
                type="button"
                data-testid="case-exception-resolve-submit"
                disabled={!canSubmitResolution || resolveMutation.isPending}
                onClick={() => {
                  setError(null);
                  resolveMutation.mutate();
                }}
                className="mt-2 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {resolveMutation.isPending && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                Resolve exception
              </button>
            </div>
          )}

          {detail.status === "active" && !detail.viewerCanResolve && (
            <p
              className="text-xs text-muted-foreground border-t border-border pt-4"
              data-testid="case-exception-resolve-denied"
            >
              Only a lab owner or admin can resolve an exception.
            </p>
          )}

          {error && (
            <p
              className="text-xs text-destructive"
              data-testid="case-exception-detail-action-error"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </Overlay>
  );
}
