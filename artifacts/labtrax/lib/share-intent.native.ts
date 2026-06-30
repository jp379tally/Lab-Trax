import {
  useShareIntent as useNativeShareIntent,
  type ShareIntent,
} from "expo-share-intent";

export type ShareIntentState = {
  hasShareIntent: boolean;
  shareIntent: ShareIntent | null;
  error: string | null;
  resetShareIntent: () => void;
};

type UseShareIntentOptions = Parameters<typeof useNativeShareIntent>[0];

export function useShareIntent(options?: UseShareIntentOptions): ShareIntentState {
  return useNativeShareIntent(options);
}
