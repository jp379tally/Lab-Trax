import { useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { MeResponse } from "@/lib/types";
import type { PendingCustomerRequest } from "@/components/CustomerRequestsSection";

export function customerRequestLabs(me: MeResponse | undefined) {
  return (me?.memberships ?? []).filter((m) =>
    m.status === "active" &&
    (m.role === "admin" || m.role === "owner") &&
    m.organization?.type === "lab" &&
    m.organization.isActive !== false &&
    !m.organization.deletedAt,
  );
}

// Keep the established prefix so Settings review invalidates every observer.
export function customerRequestsKey(userId: string | undefined, labId: string | null) {
  return ["lab-team", "customer-requests", userId, labId] as const;
}

function requestOptions(userId: string | undefined, labId: string | null) {
  return {
    queryKey: customerRequestsKey(userId, labId),
    queryFn: async () => {
      const result = await apiFetch<{ pendingJoinRequests?: PendingCustomerRequest[] }>(
        `/auth/lab-team?orgId=${encodeURIComponent(labId!)}`,
      );
      if (!Array.isArray(result.pendingJoinRequests)) {
        throw new Error("The server returned an invalid request list.");
      }
      return result.pendingJoinRequests;
    },
    enabled: !!userId && !!labId,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always" as const,
    refetchOnMount: "always" as const,
    retry: false,
  };
}

export function useCustomerRequestCounts(userId: string | undefined, labIds: string[]) {
  return useQueries({ queries: labIds.map((id) => requestOptions(userId, id)) });
}

export function useCustomerRequests(userId: string | undefined, labId: string | null) {
  const query = useQuery(requestOptions(userId, labId));
  const { refetch } = query;
  useEffect(() => {
    if (!userId || !labId) return;
    const refresh = () => { void refetch(); };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, labId, refetch]);
  return query;
}
