import { createContext, useContext } from "react";

export interface AiCaseContext {
  caseId: string;
  caseNumber: string;
  patientName: string;
}

export interface AiPanelContextValue {
  openPanel: (ctx?: AiCaseContext | AiCaseContext[]) => void;
}

export const AiPanelContext = createContext<AiPanelContextValue | null>(null);

export function useAiPanel(): AiPanelContextValue {
  const ctx = useContext(AiPanelContext);
  if (!ctx) throw new Error("useAiPanel must be used inside AppLayout");
  return ctx;
}
