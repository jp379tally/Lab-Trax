import { useMemo } from "react";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";

export function useProviderFilteredNotifications() {
  const { notifications, cases } = useApp();
  const { userType, currentUser, registeredUsers } = useAuth();
  return useMemo(() => {
    if (!notifications || !Array.isArray(notifications)) return [];
    if (userType !== "provider") {
      return notifications;
    }
    if (!currentUser) return [];
    const lowerUser = currentUser.toLowerCase();
    const users = Array.isArray(registeredUsers) ? registeredUsers : [];
    const currentUserData = users.find(u => u.username && u.username.toLowerCase() === lowerUser);
    const myDoctorName = (currentUserData?.doctorName || "").toLowerCase();
    const isAffiliated = !!currentUserData?.practiceName;
    if (!isAffiliated) return [];
    const safeCases = Array.isArray(cases) ? cases : [];
    const myCaseIds = new Set(
      safeCases
        .filter(c => {
          if (!c.doctorName) return false;
          const docLower = c.doctorName.toLowerCase();
          return (myDoctorName && docLower === myDoctorName) || docLower === lowerUser;
        })
        .map(c => c.id)
    );
    if (myCaseIds.size === 0) return [];
    return notifications.filter(n => n.caseId && myCaseIds.has(n.caseId));
  }, [notifications, userType, currentUser, registeredUsers, cases]);
}
