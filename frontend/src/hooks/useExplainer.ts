import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import type { ChatMessage, ExplainResponse } from "../types/zenith";

// Empty in dev (Vite proxies /api -> :8000). In production this is the
// Cloudflare Worker URL (VITE_API_BASE) so POSTs hit the Worker directly
// instead of the Pages _redirects proxy, which 405s on non-GET methods.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface AskArgs {
  question: string;
  plan_context: Record<string, unknown>;
  history: ChatMessage[];
}

export function useExplainer() {
  return useMutation<ExplainResponse, Error, AskArgs>({
    mutationFn: async ({ question, plan_context, history }) => {
      const { data } = await axios.post<ExplainResponse>(
        `${API_BASE}/api/explain`,
        { question, plan_context, history },
        { timeout: 30_000 },
      );
      return data;
    },
  });
}
