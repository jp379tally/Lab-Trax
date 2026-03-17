import { useMemo } from "react";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";

export function useProviderFilteredNotifications() {
  const { notifications, cases, groups } = useApp();
  const { userType, currentUser, registeredUsers } = useAuth();
  return useMemo(() => {
    if (userType !== "provider") {
      return notifications;
    }
    const lowerUser = (currentUser || "").toLowerCase();
    const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === lowerUser);
    const myDoctorName = (currentUserData?.doctorName || "").toLowerCase();
    const myGroups = groups.filter(g => g.members.some(m => m.username.toLowerCase() === lowerUser));
    if (myGroups.length === 0) return [];
    const myCaseIds = new Set(
      cases
        .filter(c => {
          const docLower = c.doctorName.toLowerCase();
          return (myDoctorName && docLower === myDoctorName) || docLower === lowerUser;
        })
        .map(c => c.id)
    );
    if (myCaseIds.size === 0) return [];
    return notifications.filter(n => n.caseId && myCaseIds.has(n.caseId));
  }, [notifications, userType, currentUser, registeredUsers, cases, groups]);
}
