import { useQuery, useQueryClient } from "@tanstack/react-query";
import { resilientFetch } from "./query-client";

export const IN_APP_NOTIFICATIONS_QUERY_KEY = ["in-app-notifications"] as const;

export interface InAppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  dataJson?: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await resilientFetch(path, init);
  if (!response.ok) throw new Error(`Notifications request failed (${response.status}).`);
  const body = (await response.json()) as { data?: T } | T;
  return body && typeof body === "object" && "data" in body
    ? (body as { data: T }).data
    : (body as T);
}

export function useInAppNotifications() {
  const query = useQuery({
    queryKey: IN_APP_NOTIFICATIONS_QUERY_KEY,
    queryFn: () => request<InAppNotification[]>("/api/notifications"),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  return {
    ...query,
    items: query.data ?? [],
    unreadCount: (query.data ?? []).filter((item) => !item.readAt).length,
  };
}

export function useNotificationActions() {
  const queryClient = useQueryClient();
  return {
    markRead: async (id: string) => {
      await request(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: "PATCH",
      });
      await queryClient.invalidateQueries({ queryKey: IN_APP_NOTIFICATIONS_QUERY_KEY });
    },
    markAllRead: async () => {
      await request("/api/notifications/mark-all-read", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: IN_APP_NOTIFICATIONS_QUERY_KEY });
    },
  };
}