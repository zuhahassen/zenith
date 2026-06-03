import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import type { CommunityFavoritesResponse } from "../types/zenith";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export function useCommunityFavorites(limit = 8) {
  return useQuery<CommunityFavoritesResponse, Error>({
    queryKey: ["community-favorites", limit],
    queryFn: async () => {
      const { data } = await axios.get<CommunityFavoritesResponse>(
        `${API_BASE}/api/community-favorites?limit=${limit}`,
        { timeout: 15_000 },
      );
      return data;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
