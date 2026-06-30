import {
  useShareIntent as useNativeShareIntent,
  type ShareIntent,
} from "expo-share-intent";
import type { ShareIntentState } from "@/lib/share-intent.types";

type NativeShareIntentState = ShareIntentState<ShareIntent>;

type UseShareIntentOptions = Parameters<typeof useNativeShareIntent>[0];

export function useShareIntent(options?: UseShareIntentOptions): NativeShareIntentState {
  return useNativeShareIntent(options);
}
