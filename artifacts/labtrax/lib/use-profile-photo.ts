import { useState } from "react";
import { useAuth } from "./auth-context";
import { normalizeProfilePhotoUrl } from "./normalize-profile-photo-url";

/** Each image failure is bound to its account and URL, not a persistent flag. */
export function useProfilePhoto(user?: { id?: string; profilePhotoUrl?: string | null }) {
  const { currentUserId } = useAuth();
  const [failed, setFailed] = useState<string | null>(null);
  const photo = user && currentUserId && user.id === currentUserId
    ? normalizeProfilePhotoUrl(user.profilePhotoUrl)
    : null;
  const identity = `${currentUserId || user?.id}:${photo}`;
  return {
    photoUrl: failed === identity ? null : photo,
    onPhotoError: () => setFailed(identity),
  };
}
