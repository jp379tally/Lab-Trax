import React, { useEffect } from "react";
import { Stack, router, useGlobalSearchParams, useSegments } from "expo-router";
import { useTheme } from "@/lib/theme-context";
import { useMe, canOwnAnyLab } from "@/lib/auth-me";
import { CreatorGate } from "@/components/creator/CreatorGate";

export default function OwnerSettingsLayout() {
  const { colors } = useTheme();
  const me = useMe();
  const params = useGlobalSearchParams<{ organizationId?: string; transferOnly?: string }>();
  const segments = useSegments();
  // Standalone-practice Owners may use only the scoped handoff screen,
  // not lab management or deletion.
  const isScopedTransferRoute =
    params.transferOnly === "1" &&
    segments[segments.length - 1] === "danger-zone";
  const canTransferSelectedOrganization =
    isScopedTransferRoute &&
    me.data?.memberships.some(
      (m) => m.organizationId === params.organizationId && m.status === "active" && m.role === "owner",
    ) === true;

  useEffect(() => {
    if (me.isSuccess && !canOwnAnyLab(me.data) && !canTransferSelectedOrganization) {
      // After a successful scoped handoff the caller is no longer Owner.
      // Return to their account, not the lab settings default screen.
      router.replace((isScopedTransferRoute ? "/account" : "/settings") as never);
    }
  }, [me.isSuccess, me.data, canTransferSelectedOrganization, isScopedTransferRoute]);

  const screens = (
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.backgroundSolid },
          animation: "slide_from_right",
        }}
      />
  );
  // A direct organization Owner's confirmed handoff is not private Creator
  // administration. Keep this exception confined to the selected organization
  // and transfer-only screen; all other owner screens retain the Creator gate.
  return canTransferSelectedOrganization ? screens : <CreatorGate>{screens}</CreatorGate>;
}
