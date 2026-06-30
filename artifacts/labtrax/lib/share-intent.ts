export type ShareIntentState = {
  hasShareIntent: boolean;
  shareIntent: { files?: Array<{ path?: string | null } | null> } | null;
  error: string | null;
  resetShareIntent: () => void;
};

type UseShareIntentOptions = {
  debug?: boolean;
  resetOnBackground?: boolean;
};

const DEFAULT_STATE: ShareIntentState = {
  hasShareIntent: false,
  shareIntent: null,
  error: null,
  resetShareIntent: () => {},
};

export function useShareIntent(_options?: UseShareIntentOptions): ShareIntentState {
  return DEFAULT_STATE;
}
