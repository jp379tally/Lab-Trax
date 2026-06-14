import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Minimal auth value that satisfies every component calling `useAuth()` without
 * mounting the real `AuthProvider` (which makes network calls on mount).
 *
 * Use as-is for anonymous/unauthenticated renders, or spread and override
 * specific fields via `makeAuthWrapper`'s `authOverrides` param.
 */
export const MOCK_AUTH_DEFAULTS: AuthContextValue = {
  user: null,
  status: "anonymous",
  restoreStatus: "empty",
  restoreNoticeDismissed: false,
  acknowledgeRestoreNotice: () => {},
  login: async () => {},
  completeTwoFactor: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: async () => ({ user: null as any, token: "" }),
  logout: async () => {},
  refresh: async () => {},
};

export function makeWrapper(initialPath = "/") {
  const queryClient = makeQueryClient();
  const { hook } = memoryLocation({ path: initialPath });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  };
}

/**
 * Like `makeWrapper` but also injects a mock `AuthContext` value so components
 * that call `useAuth()` never reach the real `AuthProvider` (which makes
 * network calls on mount).
 *
 * @param initialPath  - Initial router path (default `"/"`)
 * @param authOverrides - Fields to merge on top of `MOCK_AUTH_DEFAULTS`.
 *   Pass `{ user: {...}, status: "authed" }` for an authenticated render.
 *
 * @example
 * // Anonymous (default)
 * const Wrapper = makeAuthWrapper("/cases");
 *
 * @example
 * // Authenticated admin
 * const Wrapper = makeAuthWrapper("/settings", {
 *   user: { id: "u1", username: "admin", role: "admin" } as SessionUser,
 *   status: "authed",
 *   restoreStatus: "ok",
 *   restoreNoticeDismissed: true,
 * });
 */
export function makeAuthWrapper(
  initialPath = "/",
  authOverrides: Partial<AuthContextValue> = {},
) {
  const queryClient = makeQueryClient();
  const { hook } = memoryLocation({ path: initialPath });
  const authValue: AuthContextValue = { ...MOCK_AUTH_DEFAULTS, ...authOverrides };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Router hook={hook}>
          <AuthContext.Provider value={authValue}>
            {children}
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>
    );
  };
}
