/**
 * Tiny pub/sub that lets the dashboard's RX intake card and summary cards drive
 * the existing UnassignedDocumentsCard workflows (browse, photo, reveal)
 * without duplicating any upload or query logic.
 */
export type RxIntakeAction = "browse" | "photo" | "reveal";
type Listener = (action: RxIntakeAction) => void;
const listeners = new Set<Listener>();

export function subscribeRxIntake(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function requestRxIntake(action: RxIntakeAction): void {
  listeners.forEach((l) => l(action));
}
