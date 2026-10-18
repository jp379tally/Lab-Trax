import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useElements, useStripe } from "@stripe/react-stripe-js";

export type StripeInstance = ReturnType<typeof useStripe>;
export type ElementsInstance = ReturnType<typeof useElements>;

/**
 * Hands the mounted Stripe Elements instance to the save mutation, and
 * reports which card form (`scopeKey`) is ready so Save stays disabled until
 * the form for the current customer, draft and amount has mounted.
 */
export function StripeCapture({
  scopeKey,
  stripeRef,
  elementsRef,
  onReady,
}: {
  scopeKey: string;
  stripeRef: MutableRefObject<StripeInstance>;
  elementsRef: MutableRefObject<ElementsInstance>;
  onReady: Dispatch<SetStateAction<string | null>>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  useEffect(() => {
    stripeRef.current = stripe;
    elementsRef.current = elements;
    if (stripe && elements) onReady(scopeKey);
    return () => {
      if (stripeRef.current === stripe) stripeRef.current = null;
      if (elementsRef.current === elements) elementsRef.current = null;
      onReady((current) => (current === scopeKey ? null : current));
    };
  }, [stripe, elements, stripeRef, elementsRef, onReady, scopeKey]);
  return null;
}
