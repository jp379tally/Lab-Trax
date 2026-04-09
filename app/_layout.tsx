import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { ThemeProvider as NavThemeProvider } from "@react-navigation/native";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useMemo } from "react";
import { View, ActivityIndicator, StyleSheet, PanResponder } from "react-native";
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
  const { isAuthenticated, isAuthLoading, isLocked } = useAuth();

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
      <AppProvider>
        <InactivityWrapper>
          <View style={{ flex: 1, backgroundColor: "#E0EDFB" }}>
            <LinearGradient
              colors={["rgba(255,255,255,0.7)", "rgba(255,255,255,0)", "rgba(255,255,255,0)", "rgba(255,255,255,0.7)"]}
              locations={[0, 0.12, 0.88, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <LinearGradient
              colors={["rgba(255,255,255,0.6)", "rgba(255,255,255,0)", "rgba(255,255,255,0)", "rgba(255,255,255,0.6)"]}
              locations={[0, 0.1, 0.9, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <RootLayoutNav />
          </View>
        </InactivityWrapper>
      </AppProvider>
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

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);


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
