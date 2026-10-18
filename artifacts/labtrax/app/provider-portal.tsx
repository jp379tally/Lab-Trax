// Route host for the mobile provider portal.
//
// Providers land here instead of the lab `(tabs)` group (see the guard in
// app/_layout.tsx). The practice provider wraps the shell rather than the app:
// the selected practice is only meaningful inside the portal, and scoping it
// here guarantees the request header is cleared when the portal unmounts.
import React from "react";
import { StyleSheet } from "react-native";
import { ProviderPracticeProvider } from "@/lib/provider-practice";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { ProviderPortalShell } from "@/components/provider-portal/ProviderPortalShell";

export default function ProviderPortalRoute() {
  return (
    <ProviderPracticeProvider>
      {/*
        The portal's sections carry the text inputs (billing amounts, account
        details, the message composer), so the tap-to-dismiss layer belongs
        here, once, around the whole shell — the same place the lab side puts
        it. Each section pairs it with a drag dismissal on its own scrollable.
        The Pay My Bill sheet is a Modal and wraps itself: a modal renders in
        its own touch tree, which this layer cannot reach into.
      */}
      <DismissKeyboardView style={styles.fill}>
        <ProviderPortalShell />
      </DismissKeyboardView>
    </ProviderPracticeProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
