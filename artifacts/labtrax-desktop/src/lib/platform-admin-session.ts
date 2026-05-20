import { useState, useEffect } from "react";

let _secret: string | null = null;
let _version = 0;
const _listeners = new Set<() => void>();

export function setSessionSecret(s: string): void {
  _secret = s;
  _version++;
  _notify();
}

export function getSessionSecret(): string | null {
  return _secret;
}

export function clearSessionSecret(): void {
  _secret = null;
  _version++;
  _notify();
}

function _notify(): void {
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function subscribeSessionSecret(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * React hook that causes the calling component to re-render whenever the
 * in-memory session secret changes (set, cleared). Call this inside any
 * component or hook that needs to react to unlock/lock transitions.
 */
export function useSessionSecretVersion(): number {
  const [v, setV] = useState(_version);
  useEffect(() => {
    return subscribeSessionSecret(() => setV((prev) => prev + 1));
  }, []);
  return v;
}
