import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import { authHeaders } from "../lib/auth";
import type { CalendarRequest, CalendarResponse } from "../types/zenith";

// Empty in dev (Vite proxies /api -> :8000). In production this is the
// Cloudflare Worker URL (VITE_API_BASE).
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export function useCalendar() {
  return useMutation<CalendarResponse, Error, CalendarRequest>({
    mutationFn: async (req) => {
      try {
        const { data } = await axios.post<CalendarResponse>(
          `${API_BASE}/api/calendar`,
          req,
          { timeout: 30_000, headers: { ...authHeaders() } },
        );
        return data;
      } catch (err) {
        // Surface the backend's "Target not found" suggestion as a clean
        // message rather than a raw 404.
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          const body = err.response.data as { error?: string; suggestion?: string };
          const suggestion = body?.suggestion ? ` ${body.suggestion}.` : "";
          throw new Error(`${body?.error || "Target not found"}.${suggestion}`);
        }
        if (axios.isAxiosError(err) && err.response?.status === 429) {
          throw new Error("Too many requests — try again in a few minutes.");
        }
        throw err;
      }
    },
  });
}
