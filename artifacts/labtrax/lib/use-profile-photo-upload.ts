// Shared profile-photo picker + uploader used by both the Account tab quick
// action and the full Settings > Profile screen, so the two surfaces can't
// drift out of sync (e.g. one updating the shared auth-context avatar state,
// the other not).
import { useRef, useState } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getAccessToken, loadTokens, refreshAndGetAccessToken } from "@/lib/query-client";
import { ME_QUERY_KEY } from "@/lib/auth-me";
import { normalizeProfilePhotoUrl } from "@/lib/normalize-profile-photo-url";
import { useAuth } from "@/lib/auth-context";

async function uploadPhoto(userId: string, uri: string): Promise<{ profilePhotoUrl?: string }> {
  await loadTokens();

  const filename = uri.split("/").pop() ?? "photo.jpg";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "jpeg";
  const mime = ext === "png" ? "image/png" : "image/jpeg";
  const url = new URL(`/api/auth/users/${userId}/profile-photo`, getApiUrl()).toString();
  const fd = new FormData();
  fd.append("photo", { uri, name: filename, type: mime } as unknown as Blob);

  const doUpload = (token: string | null) =>
    new Promise<{ profilePhotoUrl?: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
          } catch {
            resolve({});
          }
        } else {
          let message = `Upload failed (${xhr.status}). Please try again.`;
          try {
            const body = JSON.parse(xhr.responseText);
            message = body.error || body.message || message;
          } catch { /* use status feedback */ }
          const err: any = new Error(message);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.timeout = 60_000;
      xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(fd);
    });

  try {
    return await doUpload(getAccessToken());
  } catch (err: any) {
    if (err?.status === 401) {
      // Access token expired — refresh and retry once, same as resilientFetch does.
      const newToken = await refreshAndGetAccessToken();
      return await doUpload(newToken);
    }
    throw err;
  }
}

/**
 * Launches the image library, resizes the pick to a 600x600 JPEG, uploads it
 * as the signed-in user's profile photo, and syncs the result into both the
 * `auth-me` react-query cache and the auth-context `profilePicUri` so every
 * screen reading either one updates immediately — no navigation required.
 */
export function useProfilePhotoUpload(userId: string | undefined | null) {
  const qc = useQueryClient();
  const { setProfilePicUri, currentUserId } = useAuth();
  const activeId = useRef(currentUserId || userId);
  activeId.current = currentUserId || userId;
  const busy = useRef(false);
  const [isUploading, setIsUploading] = useState(false);

  async function pickAndUploadPhoto() {
    if (busy.current) return;
    if (!userId) {
      Alert.alert("Not signed in", "Please sign in again to update your profile photo.");
      return;
    }
    const id = userId;
    busy.current = true;
    setIsUploading(true);
    let committed = false;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission required", "Allow access to your photo library to upload a profile photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (result.canceled || !result.assets[0]) return;

      if (activeId.current !== id) return;
      const resized = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 600, height: 600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      );
      if (activeId.current !== id) return;
      const data = await uploadPhoto(id, resized.uri);
      committed = true;
      if (activeId.current !== id) return;
      if (data?.profilePhotoUrl) {
        const normalized = normalizeProfilePhotoUrl(data.profilePhotoUrl) ?? data.profilePhotoUrl;
        // Passing the (already-absolute, non-file://) server URL means
        // auth-context just stores it — it won't try to re-upload.
        // A committed upload remains successful even if persistence/refetch fails.
        await qc.cancelQueries({ queryKey: ME_QUERY_KEY }).catch(() => {});
        if (activeId.current !== id) return;
        await Promise.resolve(setProfilePicUri(normalized, id)).catch(() => {});
        qc.setQueriesData<{ user?: { id?: string; profilePhotoUrl?: string | null } }>(
          { queryKey: ME_QUERY_KEY },
          (old) => old?.user?.id === id
            ? { ...old, user: { ...old.user, profilePhotoUrl: data.profilePhotoUrl } } : old,
        );
      }
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY }).catch(() => {});
    } catch (err: any) {
      if (!committed && activeId.current === id) Alert.alert("Photo upload failed", err?.message ?? "Unknown error");
    } finally {
      setIsUploading(false);
      busy.current = false;
    }
  }

  return { pickAndUploadPhoto, isUploading };
}
