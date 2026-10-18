import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { useAuth } from "@/lib/auth-context";
import { apiFetch, apiUploadWithProgress, serverAssetUrl } from "@/lib/api";
import type { MeResponse } from "@/lib/types";

export function ProfilePhotoControl() {
  const { user, updateProfilePhoto } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const activeId = useRef(user?.id);
  activeId.current = user?.id;
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const key = ["auth", "me", user?.id];
  const me = useQuery({
    queryKey: key,
    queryFn: async () => {
      const profile = await apiFetch<MeResponse>("/auth/me");
      if (profile.user?.id !== user?.id) throw new Error("Profile response did not match this account.");
      return profile;
    },
    enabled: !!user,
    refetchOnMount: "always",
  });
  const photo = me.data?.user?.id === user?.id ? me.data?.user?.profilePhotoUrl : user?.profilePhotoUrl;
  let url: string | undefined;
  try { url = photo ? serverAssetUrl(photo) : undefined; } catch { /* initials for invalid legacy URLs */ }
  const initials = (user?.initials || `${user?.firstName?.[0] || user?.username?.[0] || "?"}${user?.lastName?.[0] || ""}`).slice(0, 2).toUpperCase();
  useEffect(() => { setError(null); }, [user?.id]);

  async function upload(file?: File) {
    if (input.current) input.current.value = "";
    if (!file || busy.current || !user) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setError("Choose a JPEG, PNG, WebP or GIF image."); return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Profile photos must be 5 MB or smaller."); return;
    }
    const id = user.id;
    const queryKey = ["auth", "me", id];
    busy.current = true;
    setUploading(true); setError(null); setProgress(0);
    let committed = false;
    try {
      const form = new FormData();
      form.append("photo", file);
      const result = await apiUploadWithProgress<{ profilePhotoUrl: string }>(
        `/auth/users/${encodeURIComponent(id)}/profile-photo`, form,
        { onProgress: (value) => setProgress(value) },
      );
      committed = true;
      if (activeId.current !== id) return;
      // Stop older reads before installing the server-confirmed photo.
      await qc.cancelQueries({ queryKey }).catch(() => {});
      if (activeId.current !== id) return;
      updateProfilePhoto?.(id, result.profilePhotoUrl);
      qc.setQueryData<MeResponse>(queryKey, (old) => old?.user.id === id
        ? { ...old, user: { ...old.user, profilePhotoUrl: result.profilePhotoUrl } }
        : { user: { ...user, profilePhotoUrl: result.profilePhotoUrl }, memberships: [] });
      void qc.invalidateQueries({ queryKey }).catch(() => {});
    } catch (err) {
      if (!committed && activeId.current === id) setError(err instanceof Error ? err.message : "Could not upload photo. Please try again.");
    } finally {
      busy.current = false; setUploading(false);
    }
  }

  return (
    <section aria-label="Profile photo" className="rounded-lg border border-border bg-secondary/20 p-4 mb-4">
      <div className="flex items-center gap-4">
        <Avatar key={`${user?.id}:${url}`} className="w-20 h-20">
          <AvatarImage src={url} alt="Your profile photo" className="object-cover" />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div>
          <h3 className="text-sm font-semibold">Profile photo</h3>
          <p className="text-xs text-muted-foreground mt-1">Your personal account picture, synced across LabTrax.</p>
          <p id="profile-photo-guidance" className="text-xs text-muted-foreground mt-1">JPEG, PNG, WebP or GIF · up to 5 MB</p>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only"
            aria-label="Choose profile photo" aria-describedby="profile-photo-guidance" disabled={uploading}
            onChange={(event) => { void upload(event.target.files?.[0]); }} />
          <button type="button" disabled={uploading} onClick={() => input.current?.click()}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50">
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {uploading ? `Uploading… ${Math.round(progress)}%` : photo ? "Change photo" : "Add photo"}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive mt-3">{error}</p>}
    </section>
  );
}
