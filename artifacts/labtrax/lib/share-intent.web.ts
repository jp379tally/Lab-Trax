import type { ShareIntentState, UseShareIntentOptions } from "@/lib/share-intent.types";

const DEFAULT_STATE: ShareIntentState = {
  hasShareIntent: false,
  shareIntent: null,
  error: null,
  resetShareIntent: () => {},
};

export function useShareIntent(options?: UseShareIntentOptions): ShareIntentState {
  void options;
  return DEFAULT_STATE;
}
