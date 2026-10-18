type PaymentSheetResult = {
  error?: {
    code?: string;
    message?: string;
  };
};

export const AddressCollectionMode = {
  AUTOMATIC: "automatic",
} as const;

export const CollectionMode = {
  ALWAYS: "always",
} as const;

export async function initStripe(): Promise<void> {
  // Stripe's React Native SDK is intentionally unavailable in browser bundles.
}

export function useStripe() {
  const unsupported = async (): Promise<PaymentSheetResult> => ({
    error: {
      code: "UnsupportedPlatform",
      message: "Secure card entry is available in the LabTrax iOS and Android apps.",
    },
  });

  return {
    initPaymentSheet: unsupported,
    presentPaymentSheet: unsupported,
  };
}