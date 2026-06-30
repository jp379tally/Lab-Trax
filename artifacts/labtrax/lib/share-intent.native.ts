import {
  useShareIntent as useNativeShareIntent,
  type ShareIntent,
} from "expo-share-intent";
import type { ShareIntentState } from "@/lib/share-intent.types";

type NativeShareIntentState = ShareIntentState<ShareIntent>;

type NativeUseShareIntentOptions = Parameters<typeof useNativeShareIntent>[0];

export function useShareIntent(options?: NativeUseShareIntentOptions): NativeShareIntentState {
  return useNativeShareIntent(options);
}
