// Client UUID + feedback POST. The user_id is generated once and persisted
// in localStorage so the Worker can associate ratings with a browser and feed
// them back into the Claude planner on the next plan.

import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const STORAGE_KEY = "zenith_user_id";

export function getUserId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

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
      { timeout: 8000 },
    );
  } catch {
    /* swallow — no toast, no modal per spec */
  }
}
