/**
 * The API server's routing rules for Receive Payments saves, mirrored for the
 * fake servers in the desktop Receive Payments tests.
 *
 * Saved-card charges and ordinary receipts are separate server routes
 * (artifacts/api-server/src/routes/payment-sessions.ts), and each refuses the
 * other's payments with a 400 before anything is recorded. A fake that accepts
 * either route for any method lets a client post check payments to the
 * saved-card route and still pass, which is how that regression shipped.
 *
 * Cancellation has a matching rule: the server cancels every receipt recorded
 * as a card payment as a processor charge, so a card receipt that charged
 * nothing cannot be cancelled.
 */

export type ReceivePaymentRoute = "ordinary" | "saved-card";

/** The ordinary route's refusal of a positive card charge. */
export const ORDINARY_ROUTE_CARD_CHARGE_MESSAGE =
  "Use /billing/payment-sessions/card to charge a saved card securely.";
/** The saved-card route's refusal of every method other than card. */
export const SAVED_CARD_ROUTE_METHOD_MESSAGE =
  "Use this endpoint only for saved-card payments.";
/** The saved-card route's refusal of invoice applications that total zero or exceed the card amount. */
export const SAVED_CARD_ROUTE_AMOUNT_MESSAGE =
  "Saved-card invoice applications cannot exceed the card amount.";

interface PaymentSaveBody {
  paymentMethod?: string;
  receivedAmount?: number;
  applications?: Array<{ amount?: number }>;
}

/** The Receive Payments save route a request path targets, or null for any other path. */
export function receivePaymentRoute(path: string): ReceivePaymentRoute | null {
  if (path.endsWith("/billing/payment-sessions")) return "ordinary";
  if (path.endsWith("/billing/payment-sessions/card")) return "saved-card";
  return null;
}

/**
 * The message the server refuses this save with on this route, or null when
 * the route accepts it. The server sends these refusals as HTTP 400.
 */
export function receivePaymentRouteRefusal(
  route: ReceivePaymentRoute,
  body: PaymentSaveBody,
): string | null {
  const received = Number(body.receivedAmount) || 0;
  if (route === "ordinary") {
    return received > 0 && body.paymentMethod === "card"
      ? ORDINARY_ROUTE_CARD_CHARGE_MESSAGE
      : null;
  }
  if (body.paymentMethod !== "card") return SAVED_CARD_ROUTE_METHOD_MESSAGE;
  const applied = (body.applications ?? []).reduce(
    (sum, application) => sum + (Number(application.amount) || 0),
    0,
  );
  return applied <= 0 || applied > received + 0.005
    ? SAVED_CARD_ROUTE_AMOUNT_MESSAGE
    : null;
}

/** The server's refusal to cancel a card receipt that has no charge to reverse. */
export const UNCHARGED_CARD_RECEIPT_CANCEL_MESSAGE =
  "A deposited or reconciled payment cannot be reversed.";

/**
 * The message the server refuses to cancel the receipt recorded from this save
 * with, or null when it cancels it. The server reverses a card receipt as a
 * processor charge, which needs the charge's Undeposited Funds entry. A card
 * receipt that received nothing has none, so the server answers HTTP 409 and
 * any customer credit the receipt applied stays consumed.
 */
export function receivePaymentCancellationRefusal(
  recorded: PaymentSaveBody,
): string | null {
  return recorded.paymentMethod === "card" &&
    (Number(recorded.receivedAmount) || 0) <= 0
    ? UNCHARGED_CARD_RECEIPT_CANCEL_MESSAGE
    : null;
}
