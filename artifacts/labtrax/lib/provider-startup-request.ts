import { providerRequest } from "./provider-api";

export async function providerStartupRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await providerRequest<T>(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Practice request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
