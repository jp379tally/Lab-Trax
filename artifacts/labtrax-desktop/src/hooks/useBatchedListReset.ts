import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Restart a batched ("Load more") list at its first page whenever the queries
 * behind it are invalidated.
 *
 * A batched list accumulates batches in component state. When a mutation
 * invalidates the list, React Query refetches only the batch the list is
 * currently sitting on — the one anchored deep in the list, say — and that
 * batch merges into rows fetched before the mutation. A record created by the
 * mutation belongs at the head and would never appear; a record deleted from
 * the head would stay visible. Restarting drops the anchor so the refetch
 * arrives at the head of the list and replaces the accumulated rows instead
 * of merging into them.
 *
 * `rootKey` is matched against the first element of each query key, the same
 * prefix the mutations pass to `invalidateQueries`.
 *
 * `restart` must be referentially stable (e.g. from `useCallback`), otherwise
 * the cache subscription is torn down and rebuilt on every render.
 */
export function useBatchedListReset(rootKey: string, restart: () => void): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const action = (event as { action?: { type?: string } }).action;
      if (action?.type !== "invalidate") return;
      if (event.query.queryKey[0] !== rootKey) return;
      restart();
    });
  }, [queryClient, rootKey, restart]);
}
