export type ShareIntentPayload = {
  files?: Array<{ path?: string | null } | null>;
};

export type ShareIntentState<TShareIntent = ShareIntentPayload> = {
  hasShareIntent: boolean;
  shareIntent: TShareIntent | null;
  error: string | null;
  resetShareIntent: () => void;
};

export type UseShareIntentOptions = {
  debug?: boolean;
  resetOnBackground?: boolean;
};
