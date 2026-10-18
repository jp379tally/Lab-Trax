import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { formatDateTime } from "@/lib/format";

export type PendingCustomerRequest = {
  id: string;
  organizationId: string;
  labName: string | null;
  organizationType?: string | null;
  requestedByUserId: string;
  requestedRole: string | null;
  message: string | null;
  createdAt: string | null;
  requesterName: string | null;
  requesterUsername: string | null;
  requesterEmail: string | null;
  requesterPhone?: string | null;
  requesterUserType?: string | null;
  requesterDoctorName?: string | null;
  requesterPracticeName?: string | null;
  requesterPracticeAddress?: string | null;
};

type Props = {
  requests: PendingCustomerRequest[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  focused: boolean;
};

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{value}</dd>
    </div>
  );
}

export function CustomerRequestsSection({
  requests,
  isLoading,
  isError,
  onRetry,
  focused,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const hasRequests = requests.length > 0;

  useEffect(() => {
    if (!focused) return;
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }, [focused]);

  const retry = (
    <button
      type="button"
      onClick={onRetry}
      className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
    >
      Retry
    </button>
  );

  return (
    <section
      id="customer-requests"
      tabIndex={-1}
      ref={ref}
      aria-labelledby="customer-requests-heading"
      className="mt-4 rounded-lg border border-border bg-card p-4 outline-none"
    >
      <h2 id="customer-requests-heading" className="text-base font-semibold">
        Requests awaiting review
        {hasRequests && (
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            ({requests.length})
          </span>
        )}
      </h2>

      {isError && (
        <div
          role="alert"
          className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
        >
          <span>
            {hasRequests
              ? "Unable to refresh requests. Showing the last loaded list."
              : "Unable to load requests."}
          </span>
          {retry}
        </div>
      )}

      {isLoading && !hasRequests && !isError && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Loading requests...
        </p>
      )}

      {isLoading && hasRequests && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Refreshing requests...
        </p>
      )}

      {!isLoading && !isError && !hasRequests && (
        <p className="mt-3 text-sm text-muted-foreground">No requests awaiting review</p>
      )}

      {hasRequests && (
        <ul className="mt-3 divide-y divide-border">
          {requests.map((r) => {
            const who =
              r.requesterName || r.requesterUsername || r.requesterEmail || "Unknown requester";
            return (
              <li key={r.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {who}
                    {r.requesterUsername && r.requesterUsername !== who && (
                      <span className="ml-2 font-normal text-muted-foreground">
                        @{r.requesterUsername}
                      </span>
                    )}
                  </p>
                  <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    <Detail label="Email" value={r.requesterEmail} />
                    <Detail label="Phone" value={r.requesterPhone} />
                    <Detail label="Doctor" value={r.requesterDoctorName} />
                    <Detail label="Practice" value={r.requesterPracticeName} />
                    <Detail label="Practice address" value={r.requesterPracticeAddress} />
                    <Detail label="Account type" value={r.requesterUserType} />
                    <Detail label="Requested lab" value={r.labName} />
                    <Detail label="Requested role" value={r.requestedRole} />
                    <Detail label="Submitted" value={formatDateTime(r.createdAt)} />
                  </dl>
                  {r.message && (
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-sm">
                      {r.message}
                    </p>
                  )}
                </div>
                <div className="shrink-0">
                  <Link
                    href={`/settings?tab=profile&joinRequestId=${encodeURIComponent(r.id)}`}
                    aria-label={`Review request from ${who}`}
                    className="inline-flex rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  >
                    Review request
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
