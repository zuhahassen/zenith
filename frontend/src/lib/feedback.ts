// Feedback POST. Identity (signed-in account UUID or anonymous guest id) is
// resolved through lib/auth so the whole app uses a single source of truth.

import axios from "axios";

import { authHeaders, getUserId } from "./auth";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Re-exported so existing imports (`import { getUserId } from "./feedback"`)
// keep working while the canonical implementation lives in lib/auth.
export { getUserId };

export async function submitFeedback(
  targetName: string,
  rating: number,
  note?: string,
): Promise<void> {
  // Fire-and-forget: a failed rating should never disrupt the session.
  try {
    await axios.post(
      `${API_BASE}/api/feedback`,
      { user_id: getUserId(), target_name: targetName, rating, note },
      { timeout: 8000, headers: { ...authHeaders() } },
    );
  } catch {
    /* swallow — no toast, no modal per spec */
  }
}
