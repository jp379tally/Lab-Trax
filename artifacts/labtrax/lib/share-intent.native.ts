import {
  useShareIntent as useNativeShareIntent,
  type ShareIntent,
  type UseShareIntentOptions,
} from "expo-share-intent";

export type ShareIntentState = {
  hasShareIntent: boolean;
  shareIntent: ShareIntent | null;
  error: string | null;
  resetShareIntent: () => void;
};

export function useShareIntent(options?: UseShareIntentOptions): ShareIntentState {
  return useNativeShareIntent(options);
}
