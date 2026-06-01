import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import type { PlanRequest, PlanResponse } from "../types/zenith";

const API_BASE = "";

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
