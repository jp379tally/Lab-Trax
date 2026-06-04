import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function isElectron(): boolean {
  return !!(window as unknown as Record<string, unknown>).electronAPI;
}

function getScriptSrcs(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[src]"),
  ).map((s) => s.src);
}

export function useWebUpdate(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const hadControllerRef = useRef(
    typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      !!navigator.serviceWorker.controller,
  );
  const initialSrcsRef = useRef<string[]>([]);

  useEffect(() => {
    if (isElectron()) return;

    initialSrcsRef.current = getScriptSrcs();

    if (!("serviceWorker" in navigator)) return;

    const onControllerChange = () => {
      if (hadControllerRef.current) {
        setUpdateAvailable(true);
      }
      hadControllerRef.current = true;
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  useEffect(() => {
    if (isElectron()) return;

    const check = async () => {
      try {
        const res = await fetch(window.location.href, {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const fetchedSrcs = Array.from(
          doc.querySelectorAll<HTMLScriptElement>("script[src]"),
        ).map((s) => s.getAttribute("src") ?? "");
        const initial = initialSrcsRef.current;
        const hasNew = fetchedSrcs.some(
          (src) => src && !initial.some((h) => h.endsWith(src)),
        );
        if (hasNew) setUpdateAvailable(true);
      } catch {
        /* network error — ignore */
      }
    };

    const timer = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return updateAvailable;
}
