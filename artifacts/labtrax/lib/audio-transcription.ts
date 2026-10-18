import { Platform } from "react-native";
import {
  getApiUrl,
  getCsrfToken,
  refreshAndGetAccessToken,
} from "@/lib/query-client";

/**
 * Upload a completed audio recording to the authenticated speech-to-text
 * endpoint. XHR is deliberate here: Expo's fetch implementation does not
 * support React Native's native `{ uri, name, type }` FormData descriptors.
 */
export async function uploadAudioForTranscript(
  fileUri: string,
  mimeType: string,
): Promise<string> {
  const token = await refreshAndGetAccessToken();
  const url = new URL("api/ai-stt", getApiUrl()).toString();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (Platform.OS === "web") {
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  const formData = new FormData();
  if (Platform.OS === "web") {
    const blob = await globalThis.fetch(fileUri).then((response) =>
      response.blob(),
    );
    formData.append("audio", blob, "audio.webm");
  } else {
    (formData as any).append("audio", {
      uri: fileUri,
      name: "audio.m4a",
      type: mimeType,
    });
  }

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (Platform.OS === "web") xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as {
          transcript?: string;
          error?: string;
        };
        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          body.transcript !== undefined
        ) {
          resolve(body.transcript);
        } else {
          reject(new Error(body.error || "STT failed"));
        }
      } catch {
        reject(new Error("STT parse error"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData as any);
  });
}