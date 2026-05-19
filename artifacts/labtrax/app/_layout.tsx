import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import { ThemeProvider as NavThemeProvider } from "@react-navigation/native";
import * as SplashScreen from "expo-splash-screen";
import * as Linking from "expo-linking";
import React, { useEffect, useMemo } from "react";
import { View, ActivityIndicator, StyleSheet, PanResponder, Platform } from "react-native";
import { pushSharedFile } from "@/lib/shared-file-inbox";
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
import { queryClient } from "@/lib/query-client";
import { AppProvider } from "@/lib/app-context";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { RevenueCatProvider } from "@/lib/revenuecat";
import LoginScreen from "@/components/LoginScreen";
import LockScreen from "@/components/LockScreen";
import Colors from "@/constants/colors";

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

function RootLayoutNav() {
  return (
    <NavThemeProvider value={TransparentNavTheme}>
      <Stack screenOptions={{ headerBackTitle: "Back", contentStyle: { backgroundColor: Colors.light.backgroundSolid } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="case/[id]"
          options={{ headerShown: false, presentation: "card" }}
        />
        <Stack.Screen
          name="settings"
          options={{ headerShown: false, presentation: "card" }}
        />
        <Stack.Screen
          name="chat"
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="smile-preview"
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="customers"
          options={{ headerShown: false, presentation: "card" }}
        />
        <Stack.Screen
          name="privacy-policy"
          options={{ headerShown: false, presentation: "modal" }}
        />
        <Stack.Screen
          name="terms-of-service"
          options={{ headerShown: false, presentation: "modal" }}
        />
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
  const { isAuthenticated, isAuthLoading, isLocked, currentUserId } = useAuth();

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
    <RevenueCatProvider userId={currentUserId}>
      <ThemeProvider>
        <AppProvider>
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
            <RootLayoutNav />
          </View>
          </InactivityWrapper>
        </AppProvider>
      </ThemeProvider>
    </RevenueCatProvider>
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

  // Capture content shared from the iOS/Android Share sheet (e.g. a screenshot)
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    debug: false,
    resetOnBackground: true,
  });

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;
    const files = shareIntent.files || [];
    if (files.length === 0) {
      resetShareIntent();
      return;
    }
    Promise.all(
      files
        .filter((f) => !!f?.path)
        .map((f) => pushSharedFile(f.path).catch(() => {})),
    )
      .catch(() => {})
      .finally(() => {
        resetShareIntent();
        // Jump to the dashboard so the LabFileDropZone picks the shared
        // file(s) up into the lab's case media intake area. We intentionally
        // do NOT route to the new-case (scan) flow — shared screenshots
        // should land in the intake/drop zone, not auto-start a new case.
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

  // Handle files shared to LabTrax from iOS/Android share sheet
  useEffect(() => {
    if (Platform.OS === "web") return;

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
        } catch {}
      }
    }

    // Incoming URL while app is running
    const sub = Linking.addEventListener("url", handleUrl);
    // File opened while app was closed
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
