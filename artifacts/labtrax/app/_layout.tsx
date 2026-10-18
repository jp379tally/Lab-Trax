import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import { ThemeProvider as NavThemeProvider } from "@react-navigation/native";
import * as SplashScreen from "expo-splash-screen";
import * as Linking from "expo-linking";
import React, { useEffect, useMemo, useRef } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet, PanResponder, Platform } from "react-native";
import { pushSharedFile } from "@/lib/shared-file-inbox";
// query-client side-effect: registers the hydration-safe token getter + refresher
// with @workspace/api-client-react before any hook mounts (single source of truth).
import { resilientFetch, queryClient } from "@/lib/query-client";
import { useShareIntent } from "expo-share-intent";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { LinearGradient } from "expo-linear-gradient";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { useProviderPortalDecision } from "@/lib/provider-portal";
import { useMe } from "@/lib/auth-me";
import {
  parseProviderCardSetupReturn,
  resetProviderCardSetupRouting,
  routeProviderCardSetupReturn,
  setProviderCardSetupShell,
} from "@/lib/provider-card-setup-return";
import {
  deliverProviderCheckoutReturn,
  parseProviderCheckoutReturnUrl,
  type ProviderCheckoutReturn,
} from "@/lib/provider-checkout-return";
import { ThemeProvider } from "@/lib/theme-context";
import { ReconnectingBanner } from "@/components/ReconnectingBanner";
import LoginScreen from "@/components/LoginScreen";
import LockScreen from "@/components/LockScreen";
import Colors from "@/constants/colors";
import EntitlementDecisionGate from "@/components/EntitlementDecisionGate";

const TransparentNavTheme = {
  dark: false,
  colors: {
    primary: Colors.light.tint,
    background: Colors.light.backgroundSolid,
    card: Colors.light.backgroundSolid,
    text: Colors.light.text,
    border: Colors.light.border,
    notification: Colors.light.error,
  },
  fonts: {
    regular: { fontFamily: "Inter_400Regular", fontWeight: "400" as const },
    medium: { fontFamily: "Inter_500Medium", fontWeight: "500" as const },
    bold: { fontFamily: "Inter_700Bold", fontWeight: "700" as const },
    heavy: { fontFamily: "Inter_700Bold", fontWeight: "700" as const },
  },
};

SplashScreen.preventAutoHideAsync();

// Module-level storage for a QR-scan deep-link that arrives before the user
// is authenticated. AuthGate drains this once login completes.
let pendingCaseNumber: string | null = null;

let pendingProviderReturn: ProviderCheckoutReturn | null = null;

async function resolveCaseAndNavigate(caseNumber: string): Promise<boolean> {
  try {
    const res = await resilientFetch(
      `/api/cases/by-number/${encodeURIComponent(caseNumber)}`,
    );
    if (res.ok) {
      const body = (await res.json()) as { data?: { id?: string } };
      const caseId = body?.data?.id;
      if (caseId) {
        router.push(`/case/${caseId}` as any);
        return true;
      }
    }
  } catch {
    // Network error or not authenticated — fall through
  }
  return false;
}

function RootLayoutNav() {
  // Providers get the provider portal instead of the lab tab group. Gating the
  // two at the navigator (rather than inside `(tabs)`) keeps the lab shell
  // byte-for-byte unchanged and stops the lab tab screens from ever mounting
  // for a provider. "pending" is only reachable for provider accounts whose
  // memberships are still loading — lab users never see an added gate.
  const shell = useProviderPortalDecision();
  const me = useMe();
  const { logout } = useAuth();

  // A card-setup return can arrive before the shell is known (cold start, or
  // while signed out). Publishing the answer hands over whatever was waiting
  // on it; until then the return stays queued rather than defaulting to the
  // lab settings screen.
  useEffect(() => {
    if (shell === "pending") return;
    setProviderCardSetupShell(shell === "provider" ? "provider" : "lab");
  }, [shell]);

  if (shell === "pending") {
    return (
      <View style={authStyles.loading}>
        <ActivityIndicator size="large" color={Colors.light.tint} />
        <Text style={{ color: "#fff", marginTop: 16 }}>Checking your practice access…</Text>
        <Pressable onPress={() => void me.refetch()} style={{ padding: 12 }}>
          <Text style={{ color: "#fff" }}>Try again</Text>
        </Pressable>
        <Pressable onPress={() => void logout()} style={{ padding: 12 }}>
          <Text style={{ color: "#fff" }}>Sign out</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <NavThemeProvider value={TransparentNavTheme}>
      <Stack screenOptions={{ headerBackTitle: "Back", contentStyle: { backgroundColor: Colors.light.backgroundSolid } }}>
        <Stack.Protected guard={shell === "provider"}>
          <Stack.Screen name="provider-portal" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={shell === "lab"}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Screen name="case/[id]" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="new-case" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="pdf-viewer" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="invoice-editor/[id]" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/invoices" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/receive-payments" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/make-deposits" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/customers" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/provider-authorizations" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/statements" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/bank-register" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/bills" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/pay-bills" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="finance/ap-aging" options={{ headerShown: false, presentation: "card", title: "A/P & A/R Aging" }} />
        <Stack.Screen name="manage/accounts" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/pricing" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/lists" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/reports" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/stats" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/sales-forecast" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="manage/ai-knowledge" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="duplicate-doctors" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="messages/index" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="messages/[threadId]" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="settings" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="settings/provider-billing" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="settings/shared-account" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="settings/report-issue" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="ai-reader" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="ai-assistant" options={{ headerShown: false, presentation: "card" }} />
        <Stack.Screen name="privacy-policy" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="terms-of-service" options={{ headerShown: false, presentation: "modal" }} />
      </Stack>
    </NavThemeProvider>
  );
}

function InactivityWrapper({ children }: { children: React.ReactNode }) {
  const { resetInactivityTimer } = useAuth();
  const panResponder = useMemo(() =>
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        resetInactivityTimer();
        return false;
      },
      onMoveShouldSetPanResponderCapture: () => {
        resetInactivityTimer();
        return false;
      },
    }),
  [resetInactivityTimer]);

  return (
    <View style={{ flex: 1 }} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

function AuthGate() {
  const { isAuthenticated, isAuthLoading, isLocked } = useAuth();

  // After login, drain any QR-scan deep-link that arrived before auth. Signing
  // out forgets which shell card-setup returns belong to: the next account may
  // get the other one, and an unhandled return belongs to the session that
  // started it.
  useEffect(() => {
    deepLinkAuthenticated = isAuthenticated;
    if (!isAuthenticated) resetProviderCardSetupRouting();
    if (!isAuthenticated || !pendingCaseNumber) return;
    const cn = pendingCaseNumber;
    pendingCaseNumber = null;
    resolveCaseAndNavigate(cn).catch(() => {});
  }, [isAuthenticated]);

  // A Stripe return that landed on the login screen is delivered once the
  // provider is back in: on a cold launch the portal is only mounted now, so
  // the destination is resolved here rather than when the link arrived.
  useEffect(() => {
    if (!isAuthenticated || !pendingProviderReturn) return;
    const providerReturn = pendingProviderReturn;
    pendingProviderReturn = null;
    void deliverProviderCheckoutReturn(providerReturn).catch(() => {});
  }, [isAuthenticated]);

  // A pending card-setup return is drained in RootLayoutNav instead: it needs
  // to know whether this user gets the lab shell or the provider portal, and
  // that is only decided once the account's memberships have loaded.

  if (isAuthLoading) {
    return (
      <View style={authStyles.loading}>
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  if (isLocked) {
    return <LockScreen />;
  }

  return (
    <ThemeProvider>
      <InactivityWrapper>
        <View style={{ flex: 1, backgroundColor: Colors.light.backgroundSolid }}>
          <LinearGradient
            colors={["rgba(20,93,160,0.14)", "rgba(20,93,160,0.03)", "rgba(244,247,251,0)"]}
            locations={[0, 0.35, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <LinearGradient
            colors={["rgba(15,118,110,0.08)", "rgba(15,118,110,0)", "rgba(8,17,29,0.06)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 1, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
           <EntitlementDecisionGate>
             <RootLayoutNav />
           </EntitlementDecisionGate>
          <ReconnectingBanner />
        </View>
      </InactivityWrapper>
    </ThemeProvider>
  );
}

const authStyles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0F172A",
  },
});

// Recognize and store any file URL shared to LabTrax from the iOS/Android share sheet.
function isFileUrl(url: string): boolean {
  return (
    url.startsWith("file://") ||
    url.startsWith("content://") ||
    /\.(jpe?g|png|heic|heif|gif|webp|pdf|mp4|mov|avi)(\?|$)/i.test(url)
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Capture content shared from the iOS/Android Share sheet (e.g. a screenshot).
  // The native share target stays registered (app.json plugin); shared files are
  // stored in the inbox and the app lands on the cases list.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    debug: false,
    resetOnBackground: true,
  });
  // The hook recreates resetShareIntent on each render. Keep the accepted
  // payload until a distinct native delivery arrives, even after reset begins.
  const acceptedShareIntent = useRef<typeof shareIntent>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent || acceptedShareIntent.current === shareIntent) return;
    acceptedShareIntent.current = shareIntent;
    const files = (shareIntent.files || []).filter((file) => !!file?.path);
    if (files.length === 0) {
      resetShareIntent();
      return;
    }
    // pushSharedFile reads and rewrites the inbox; parallel writes can lose
    // siblings from the same native batch.
    void (async () => {
      for (const file of files) {
        await pushSharedFile(file.path);
      }
    })()
      .finally(() => {
        if (acceptedShareIntent.current === shareIntent) resetShareIntent();
        try {
          router.replace("/(tabs)");
        } catch {}
      });
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Handle files shared to LabTrax from iOS/Android share sheet + case deep-links
  useEffect(() => {
    if (Platform.OS === "web") return;

    // Stripe's return link only says a return happened; the surface that
    // launched the checkout decides where it lands (see provider-checkout-return).
    // A card-setup return is routed separately: routing holds it until the
    // shell is known, so a cold start does not have to guess whether this
    // account gets the lab shell or the provider portal.
    function handleProviderReturn(
      providerReturn: ProviderCheckoutReturn,
      params: Record<string, unknown>,
    ) {
      const setupReturn = parseProviderCardSetupReturn(params);
      if (setupReturn) {
        routeProviderCardSetupReturn(setupReturn);
        return;
      }
      if (deepLinkAuthenticated) {
        void deliverProviderCheckoutReturn(providerReturn).catch(() => {});
      } else {
        pendingProviderReturn = providerReturn;
      }
    }

    function handleUrl(event: { url: string }) {
      const { url } = event;
      if (!url) return;
      // Accept direct file URLs and labtrax:// scheme with a ?file= param
      if (isFileUrl(url)) {
        pushSharedFile(url).catch(() => {});
      } else if (url.startsWith("labtrax://")) {
        try {
          const parsed = Linking.parse(url);
          const fileParam = parsed.queryParams?.file;
          if (fileParam && typeof fileParam === "string") {
            pushSharedFile(fileParam).catch(() => {});
          }
          const providerReturn = parseProviderCheckoutReturnUrl(url);
          if (providerReturn) {
            handleProviderReturn(
              providerReturn,
              (parsed.queryParams ?? {}) as Record<string, unknown>,
            );
          }
        } catch {}
      } else {
        // Handle case deep-links: https://<domain>/cases/<caseNumber>
        // Produced by QR codes embedded in case drawers and invoice PDFs.
        try {
          const parsed = new URL(url);
          const caseMatch = parsed.pathname.match(/^\/cases\/([^/?#]+)/);
          if (caseMatch) {
            const caseNumber = decodeURIComponent(caseMatch[1]);
            resolveCaseAndNavigate(caseNumber)
              .then((resolved) => {
                if (!resolved) {
                  pendingCaseNumber = caseNumber;
                }
              })
              .catch(() => {
                pendingCaseNumber = caseNumber;
              });
          }
          const providerReturn = parseProviderCheckoutReturnUrl(url);
          if (providerReturn) {
            handleProviderReturn(
              providerReturn,
              Object.fromEntries(parsed.searchParams.entries()),
            );
          }
        } catch {}
      }
    }

    const sub = Linking.addEventListener("url", handleUrl);
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    }).catch(() => {});

    return () => sub.remove();
  }, []);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView>
          <KeyboardProvider>
            <AuthProvider>
              <AuthGate />
            </AuthProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

let deepLinkAuthenticated = false;
