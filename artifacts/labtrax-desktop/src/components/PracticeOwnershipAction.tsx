import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { MeResponse } from "@/lib/types";

/** Resolve direct practice ownership independently of a lab-first user profile. */
export function PracticeOwnershipAction({
  preferredOrganizationId,
  onTransfer,
}: {
  preferredOrganizationId?: string | null;
  onTransfer: (organizationId: string) => void;
}) {
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const [selectedId, setSelectedId] = useState("");
  const ownedPractices = (me.data?.memberships ?? []).filter(
    (m) => m.status === "active" && m.role === "owner" && m.organization?.type === "provider",
  );
  const selected =
    ownedPractices.find((m) => m.organizationId === selectedId) ??
    ownedPractices.find((m) => m.organizationId === preferredOrganizationId) ??
    ownedPractices[0];
  if (!selected) return null;

  return (
    <div className="mb-3 space-y-2">
      {ownedPractices.length > 1 && (
        <label className="block text-sm">
          Practice for ownership transfer
          <select
            className="ml-2 rounded border border-input bg-background p-1"
            value={selected.organizationId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {ownedPractices.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.displayName || m.organization?.name || "Practice"}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={() => onTransfer(selected.organizationId)}
        className="text-sm font-medium text-primary"
      >
        Transfer practice ownership…
      </button>
      <p className="text-xs text-muted-foreground">
        {selected.organization?.displayName || selected.organization?.name || "Practice"}
      </p>
    </div>
  );
}
