import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import type { PlanRequest, PlanResponse } from "../types/zenith";

// Empty in dev (Vite proxies /api -> :8000). In production this is the
// Cloudflare Worker URL (VITE_API_BASE) so POSTs hit the Worker directly
// instead of the Pages _redirects proxy, which 405s on non-GET methods.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export function usePlan() {
  return useMutation<PlanResponse, Error, PlanRequest>({
    mutationFn: async (req) => {
      const { data } = await axios.post<PlanResponse>(
        `${API_BASE}/api/plan-ai`,
        req,
        { timeout: 60_000 },
      );
      return data;
    },
  });
}
