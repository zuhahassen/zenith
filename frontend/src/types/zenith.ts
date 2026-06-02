// TypeScript shapes that match the FastAPI responses verbatim. Update both
// sides when the backend contracts change.

export type Mode = "observer" | "astrophotographer";

export type ObjectKind =
  | "Galaxy"
  | "Nebula"
  | "GlCl"
  | "OpenCl"
  | "Unknown"
  | string; // SIMBAD may return raw codes we haven't mapped

export interface PlanRequest {
  lat: number;
  lon: number;
  aperture_mm: number;
  date?: string | null;
  user_id?: string | null;
  mode: Mode;
  elevation_m?: number;
  duration_hours?: number;
  min_alt_deg?: number;
}

export interface ScoredTarget {
  name: string;
  common_name: string | null;
  kind: ObjectKind;
  ra_deg: number;
  dec_deg: number;
  magnitude: number | null;
  score: number;
  components: Record<string, number>;
  window_start: string | null;
  window_end: string | null;
  window_minutes: number;
  transit_time: string | null;
  max_alt_deg: number;
  min_airmass: number;
  moon_sep_deg: number;
  surface_brightness: number | null;
  sb_limit: number;
  why: string;
}

export interface SeeingSlot {
  slot: string; // ISO 8601 timestamp (UTC)
  predicted_seeing_arcsec: number;
  confidence: number;
}

export interface ReferenceImage {
  url: string;
  source: string;
}

export interface AIPlanItem {
  name: string;
  slot: string;
  object_type: string;
  why: string;
  seeing_at_slot: number;
  reference_image?: ReferenceImage | null;
}

export interface AIPlan {
  ordered_targets: AIPlanItem[];
  session_summary: string;
  session_notes: string;
  error?: string;
  error_type?: string;
}

export interface WeatherSnapshot {
  temperature_c?: number | null;
  humidity?: number | null;
  cloud_cover?: number | null;
  wind_speed?: number | null;
  description?: string | null;
  [key: string]: unknown;
}

export interface PlanResponse {
  request: {
    lat: number;
    lon: number;
    aperture_mm: number;
    mode: Mode;
    user_id: string | null;
    date: string | null;
  };
  count: number;
  moon_illumination: number | null;
  weather: WeatherSnapshot | null;
  seeing_forecast: SeeingSlot[];
  seeing_model_loaded: boolean;
  targets: ScoredTarget[];
  catalog_source: "simbad" | "seed";
  // Present when the plan is empty: a human-readable reason (no darkness,
  // nothing above the horizon, or no catalog match). null when targets exist.
  notice?: string | null;
  // Only present on /api/plan-ai. Always present in PlanResponse so
  // components can render it conditionally.
  ai_plan?: AIPlan;
}

export interface ExplainRequest {
  question: string;
  plan_context: Record<string, unknown>;
  history: ChatMessage[];
}

export interface ExplainResponse {
  answer: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
