import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import type { HistoryResponse } from "../types/zenith";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Per-user session history from the Worker (D1-backed, KV-cached 5 min).
export function useHistory(userId: string, limit = 20) {
  return useQuery<HistoryResponse, Error>({
    queryKey: ["history", userId, limit],
    queryFn: async () => {
      const { data } = await axios.get<HistoryResponse>(
        `${API_BASE}/api/history?user_id=${encodeURIComponent(userId)}&limit=${limit}`,
        { timeout: 15_000 },
      );
      return data;
    },
    staleTime: 60_000,
    retry: 1,
  });
}
