import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import type {
  CompareSitesRequest,
  CompareSitesResponse,
} from "../types/zenith";

// Empty in dev (Vite proxies /api -> :8000). In production this is the
// Cloudflare Worker URL (VITE_API_BASE).
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const RATE_LIMIT_MESSAGE =
  "You've run several comparisons recently. Try again in a few minutes.";

export function useCompareSites() {
  return useMutation<CompareSitesResponse, Error, CompareSitesRequest>({
    mutationFn: async (req) => {
      try {
        const { data } = await axios.post<CompareSitesResponse>(
          `${API_BASE}/api/compare-sites`,
          req,
          { timeout: 90_000 },
        );
        return data;
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 429) {
          throw new Error(RATE_LIMIT_MESSAGE);
        }
        throw err;
      }
    },
  });
}
