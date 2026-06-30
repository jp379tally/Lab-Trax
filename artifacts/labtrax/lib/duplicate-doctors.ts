// Shared accessor for the possible-duplicate doctor clusters surfaced by the
// nav badge (More tab + More menu row) and the suspects-list screen. Wraps the
// shared GET /doctors/duplicate-clusters endpoint so the tab badge, the menu
// row badge, and the screen all read one source of truth and stay in sync.
//
// The server already scopes detection to labs the caller owns/admins and honors
// each lab's duplicateSuggestionThreshold, so non-admins get an empty result.
// We still gate the query on canAdminAnyLab to avoid an unnecessary call for
// provider/read-only users.
import {
  useGetDoctorDuplicateClusters,
  getGetDoctorDuplicateClustersQueryKey,
  type DoctorDuplicateCluster,
} from "@workspace/api-client-react";
import { useMe, canAdminAnyLab } from "@/lib/auth-me";

export { getGetDoctorDuplicateClustersQueryKey };
export type { DoctorDuplicateCluster };

export function useDuplicateDoctorClusters() {
  const meQuery = useMe();
  const enabled = canAdminAnyLab(meQuery.data);
  const query = useGetDoctorDuplicateClusters({
    query: {
      queryKey: getGetDoctorDuplicateClustersQueryKey(),
      enabled,
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });
  const clusters: DoctorDuplicateCluster[] = enabled
    ? query.data?.data?.clusters ?? []
    : [];
  const totalGroups = enabled ? query.data?.data?.totalGroups ?? 0 : 0;
  return { query, clusters, totalGroups, enabled };
}
