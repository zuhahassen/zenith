// TypeScript shapes that match the FastAPI responses verbatim. Update both
// sides when the backend contracts change.

export type Mode = "observer" | "astrophotographer";

export type CatalogFilter = "messier" | "caldwell" | "herschel400";

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
  bortle_class?: number | null;
  catalog_filter?: CatalogFilter | null;
  focal_length_mm?: number | null;
  sensor_width_mm?: number | null;
  sensor_height_mm?: number | null;
  liked_targets?: string[];
  disliked_targets?: string[];
  elevation_m?: number;
  duration_hours?: number;
  min_alt_deg?: number;
}

export interface FilterWindow {
  start: string;
  end: string;
  note: string;
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
  bortle_class: number | null;
  sb_penalty: number;
  // Astrophotographer-only fields (null/undefined in observer mode).
  filter_windows?: Record<string, FilterWindow> | null;
  fov_note?: string | null;
  fov_score?: number | null;
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
  // Plain-English, jargon-free note on what a visual observer will actually
  // see through the eyepiece. Requested from Claude per target (see planner).
  observer_note?: string | null;
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
  bortle_class: number;
  estimated_bortle: number;
  fov_deg?: { width: number; height: number } | null;
  // Present when the plan is empty: a human-readable reason (no darkness,
  // nothing above the horizon, or no catalog match). null when targets exist.
  notice?: string | null;
  // Only present on /api/plan-ai. Always present in PlanResponse so
  // components can render it conditionally.
  ai_plan?: AIPlan;
}

// --- Multi-site comparison (POST /api/compare-sites) ----------------------

export interface CompareSiteInput {
  label: string;
  lat: number;
  lon: number;
}

export interface CompareSitesRequest {
  sites: CompareSiteInput[];
  aperture_mm: number;
  mode: Mode;
  date?: string | null;
  catalog_filter?: CatalogFilter | null;
  duration_hours?: number;
  min_alt_deg?: number;
}

export interface CompareSiteSubscores {
  darkness: number;
  weather: number;
  seeing: number;
  targets: number;
}

export interface CompareSiteResult {
  label: string;
  lat: number;
  lon: number;
  bortle_class: number | null;
  cloud_cover: number | null;
  weather_score: number | null;
  median_seeing_arcsec: number | null;
  visible_target_count: number;
  top_targets: string[];
  subscores: CompareSiteSubscores | null;
  composite_score: number;
  error: string | null;
}

export interface CompareSitesResponse {
  sites: CompareSiteResult[];
  best_site: string | null;
  recommendation: string;
  generated_at: string;
}

// --- Community favorites (GET /api/community-favorites) --------------------

export interface CommunityFavorite {
  target_name: string;
  net_score: number;
  up_votes: number;
  down_votes: number;
  total_votes: number;
  approval: number; // 0..1 fraction of positive votes
}

export interface CommunityFavoritesResponse {
  favorites: CommunityFavorite[];
  total_targets_rated: number;
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
