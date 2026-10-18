/**
 * Pre-submit "this doctor already has an account" warning (Task #4398).
 *
 * Adding a doctor who already has a provider account attaches that account
 * instead of minting a second one — correct, but the admin used to only find
 * out afterwards, in the result panel. These helpers surface the same
 * decision *before* submit so the admin can attach knowingly, fix a typo, or
 * say "this is a genuinely different person" (two real doctors do share
 * names).
 *
 * The match itself always comes from the server's single shared resolver via
 * the read-only `/doctors/match-preview` endpoint. There is deliberately no
 * client-side matching here — a second rule would drift from the one the add
 * call actually applies, and the warning would start lying.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, UserPlus2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatAccountNumberForDisplay } from "@workspace/account-number";

/** One doctor row being typed into an add-doctor form. */
export interface DoctorMatchRow {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** Accounts the admin has already declared to be a different person. */
  distinctFromUserIds: string[];
}

/** An existing account the add call would attach to, as reported by the server. */
export interface DoctorMatch {
  index: number;
  userId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  platformAccountNumber: string | null;
  matchedOn: "email" | "phone" | "name";
  similarity: number;
  practices: string[];
  alreadyMemberOfPractice: boolean;
}

interface PreviewPayloadRow {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  distinctFromUserIds: string[];
}

function useDebouncedKey<T>(value: T, key: string, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
    // `key` is the serialized form of `value`, so it changes exactly when
    // the payload does — depending on the object identity would re-arm the
    // timer on every render and the query would never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);
  return settled;
}

export interface DoctorMatchPreview {
  /** Live match per row index; a row the admin dismissed reports the next one. */
  matchByIndex: Map<number, DoctorMatch>;
  /**
   * Rows whose typed email already belongs to an account the add would not
   * attach to. The server refuses those rows, so the form must say so.
   */
  emailConflictRows: Set<number>;
  /**
   * A lookup is debouncing or in flight. Callers MUST block submit on this:
   * otherwise an admin who types and immediately submits attaches an existing
   * account without ever seeing the warning, which is the whole point of the
   * check. While it is true, no match is reported — a result for the previous
   * keystrokes would name the wrong account.
   */
  isChecking: boolean;
}

/**
 * Debounced, read-only lookup of the accounts an add-doctor submit would
 * attach to.
 *
 * `scopeOrgId` may be the provider practice being added to, or the parent lab
 * when the practice does not exist yet (the "add practice" dialog) — matching
 * is scoped per lab either way.
 */
export function useDoctorMatchPreview(
  scopeOrgId: string | null | undefined,
  rows: DoctorMatchRow[],
  options?: { enabled?: boolean },
): DoctorMatchPreview {
  const active = options?.enabled ?? true;

  // Every row goes to the server exactly as typed, and rows are never
  // dropped — the server's per-row index has to line up with the caller's.
  //
  // There is deliberately no "is this long enough to be worth asking about?"
  // threshold here. The add call accepts any non-empty first name and the
  // resolver exact-matches any non-empty normalized name, so a real account
  // named "Al" is attachable the instant those two characters are typed. A
  // client-side minimum would be a second rule about who can match, and it
  // would silently skip the warning for exactly those short names.
  const payload = useMemo<PreviewPayloadRow[]>(
    () =>
      rows.map((r) => ({
        firstName: r.firstName.trim(),
        lastName: r.lastName.trim(),
        email: r.email.trim(),
        phone: r.phone.trim(),
        distinctFromUserIds: r.distinctFromUserIds,
      })),
    [rows],
  );
  const payloadKey = JSON.stringify(payload);

  const settled = useDebouncedKey(payload, payloadKey, 400);
  const settledKey = JSON.stringify(settled);
  const anyTyped = (rows: PreviewPayloadRow[]) =>
    rows.some((r) => r.firstName || r.lastName || r.email || r.phone);
  const enabled = active && !!scopeOrgId && anyTyped(settled);

  const query = useQuery({
    queryKey: ["doctor-match-preview", scopeOrgId, settledKey],
    queryFn: () =>
      apiFetch<{ matches: DoctorMatch[]; emailConflicts?: number[] }>(
        `/organizations/${scopeOrgId}/doctors/match-preview`,
        { method: "POST", body: JSON.stringify({ doctors: settled }) },
      ),
    enabled,
    staleTime: 30_000,
    // A failed preview must never block the add itself — the server still
    // resolves on submit, so a silent miss degrades to today's behaviour.
    retry: false,
  });

  // The answer belongs to `settled`. While the admin is still typing, that is
  // an answer about text they have already changed, so report nothing rather
  // than name an account the current entry may not match.
  const stale = payloadKey !== settledKey;
  // Anything typed *now* — the debounce hasn't reached `settled` yet, and
  // submit has to stay blocked through that window.
  const isChecking =
    active &&
    !!scopeOrgId &&
    anyTyped(payload) &&
    (stale || query.isFetching || (enabled && query.isPending));

  const matchByIndex = useMemo(() => {
    const map = new Map<number, DoctorMatch>();
    if (!enabled || stale) return map;
    for (const m of query.data?.matches ?? []) map.set(m.index, m);
    return map;
  }, [enabled, stale, query.data]);

  const emailConflictRows = useMemo(() => {
    const set = new Set<number>();
    if (!enabled || stale) return set;
    for (const i of query.data?.emailConflicts ?? []) set.add(i);
    return set;
  }, [enabled, stale, query.data]);

  return { matchByIndex, emailConflictRows, isChecking };
}

/** "#P-2024-0014", or a readable stand-in when the account has no number. */
function accountLabel(n: string | null | undefined): string {
  return n && n.trim()
    ? `#${formatAccountNumberForDisplay(n.trim()).replace(/^#/, "")}`
    : "an account already on file";
}

function matchedOnLabel(match: DoctorMatch): string {
  if (match.matchedOn === "email") return "email address";
  if (match.matchedOn === "phone") return "phone number";
  return match.similarity >= 1 ? "name" : "a similar name";
}

/**
 * The warning itself. Renders one of three states:
 *  - an existing account this row would attach to,
 *  - confirmation that the admin called it a different person, or
 *  - nothing at all.
 */
export function DoctorMatchNotice({
  match,
  dismissedCount,
  onMarkDistinct,
  onUndoDistinct,
  emailConflict = false,
  checking = false,
  compact = false,
}: {
  match: DoctorMatch | undefined;
  dismissedCount: number;
  onMarkDistinct: (userId: string) => void;
  onUndoDistinct: () => void;
  emailConflict?: boolean;
  checking?: boolean;
  compact?: boolean;
}) {
  // The server refuses a row whose email belongs to an account it would not
  // attach to, so say that instead of promising anything about the name.
  if (emailConflict) {
    return (
      <div
        role="status"
        className={`rounded-md border border-destructive/40 bg-destructive/10 text-destructive ${
          compact ? "px-2.5 py-2" : "px-3 py-2.5"
        }`}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={compact ? 13 : 15} className="mt-0.5 shrink-0" />
          <div className={compact ? "text-[11px] leading-snug" : "text-xs leading-snug"}>
            That email address already belongs to another account, so this row
            will be rejected. Use a different address, or clear it to match on
            the name instead.
          </div>
        </div>
      </div>
    );
  }

  if (match) {
    const meta = [`Matched on ${matchedOnLabel(match)}`];
    if (match.practices.length > 0) meta.push(match.practices.join(", "));
    if (match.alreadyMemberOfPractice) meta.push("already at this practice");

    return (
      <div
        role="status"
        className={`rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 ${
          compact ? "px-2.5 py-2" : "px-3 py-2.5"
        }`}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={compact ? 13 : 15} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className={compact ? "text-[11px] leading-snug" : "text-xs leading-snug"}>
              Looks like{" "}
              <span className="font-mono font-semibold">
                {accountLabel(match.platformAccountNumber)}
              </span>{" "}
              <span className="font-semibold">({match.displayName})</span> — will
              attach to that account.
            </div>
            <div
              className={`mt-0.5 opacity-80 ${compact ? "text-[10px]" : "text-[11px]"}`}
            >
              {meta.join(" · ")}
            </div>
            <button
              type="button"
              onClick={() => onMarkDistinct(match.userId)}
              className={`mt-1.5 underline font-medium hover:no-underline ${
                compact ? "text-[10px]" : "text-[11px]"
              }`}
            >
              Not the same person — create a separate account
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (dismissedCount > 0) {
    return (
      <div
        role="status"
        className={`rounded-md border border-border bg-muted/40 text-muted-foreground ${
          compact ? "px-2.5 py-2" : "px-3 py-2.5"
        }`}
      >
        <div className="flex items-start gap-2">
          <UserPlus2 size={compact ? 13 : 15} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className={compact ? "text-[11px] leading-snug" : "text-xs leading-snug"}>
              You confirmed this is a different person — a separate account will
              be created.
            </div>
            <button
              type="button"
              onClick={onUndoDistinct}
              className={`mt-1.5 underline font-medium hover:no-underline ${
                compact ? "text-[10px]" : "text-[11px]"
              }`}
            >
              Undo — attach to the existing account instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (checking) {
    return (
      <div
        className={`text-muted-foreground ${compact ? "text-[10px]" : "text-[11px]"}`}
      >
        Checking for an existing account…
      </div>
    );
  }

  return null;
}
