import { useMemo } from "react";
import { CalendarDays, Clock, MapPin, SlidersHorizontal, Telescope } from "lucide-react";
import { useCommunityFavorites } from "../hooks/useCommunityFavorites";
import { hhmm } from "../lib/format";
import type { PlanResponse } from "../types/zenith";

// Normalize a target designation for matching across sources ("M 13" -> "M13").
const normName = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export type View = "tonight" | "compare" | "calendar" | "history" | "settings";

const NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "tonight", label: "Tonight", icon: <Telescope size={14} /> },
  { id: "compare", label: "Compare Sites", icon: <MapPin size={14} /> },
  { id: "calendar", label: "Calendar", icon: <CalendarDays size={14} /> },
  { id: "history", label: "History", icon: <Clock size={14} /> },
  { id: "settings", label: "Settings", icon: <SlidersHorizontal size={14} /> },
];

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  plan?: PlanResponse;
}

export function Sidebar({ view, onNavigate, plan }: Props) {
  // Fetch a deep slice of the community leaderboard, then keep only the
  // targets that are actually visible tonight from the user's location
  // (the current plan already computed that visibility for these exact
  // coordinates/date), so "Nearby favorites" is genuinely location-aware.
  const community = useCommunityFavorites(50);
  const favorites = useMemo(() => {
    const all = community.data?.favorites ?? [];
    const visible = plan?.targets ?? [];
    if (visible.length === 0) return [];
    const visibleSet = new Set(visible.map((t) => normName(t.name)));
    return all.filter((f) => visibleSet.has(normName(f.target_name))).slice(0, 5);
  }, [community.data, plan]);

  const darkWindow = darkWindowLabel(plan);
  const modelLoaded = plan?.seeing_model_loaded ?? null;

  return (
    <nav className="sidebar">
      <div className="sidebar__nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${view === n.id ? "active" : ""}`}
            onClick={() => onNavigate(n.id)}
          >
            <span className="nav-item__icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </div>

      <div className="sidebar__spacer" />

      {plan && (
        <div className="sidebar__block">
          <div className="label sidebar__block-title">Nearby favorites</div>
          {favorites.length > 0 ? (
            <div className="community-list">
              {favorites.map((f) => (
                <div className="community-row" key={f.target_name}>
                  <span className="community-row__name">{f.target_name}</span>
                  <span className="community-row__score">
                    {f.net_score > 0 ? `+${f.net_score}` : f.net_score}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="community-empty">No community favorites above the horizon tonight.</div>
          )}
        </div>
      )}

      <div className="sidebar__block">
        <div className="status-block">
          <div className="status-row">
            <span className="status-row__k">Model</span>
            <span
              className="status-row__v"
              style={{ color: modelLoaded == null ? undefined : modelLoaded ? "var(--good)" : "var(--poor)" }}
            >
              {modelLoaded == null ? "—" : modelLoaded ? "loaded" : "fallback"}
            </span>
          </div>
          <div className="status-bortle">
            <span className="status-bortle__main">
              {plan ? `Bortle ${plan.bortle_class}` : "Bortle —"}
            </span>
            {plan && (
              <span className="status-bortle__sub">{bortleWord(plan.bortle_class)}</span>
            )}
          </div>
          <div className="status-row">
            <span className="status-row__k">Darkness</span>
            <span className="status-row__v">{darkWindow}</span>
          </div>
        </div>
      </div>
    </nav>
  );
}

// Coarse sky-brightness descriptor for the Bortle class shown in the status block.
function bortleWord(b: number): string {
  if (b <= 3) return "rural";
  if (b <= 4) return "rural/suburban";
  if (b <= 7) return "suburban";
  return "city";
}

// Derive a coarse dark-window label from the seeing-forecast slot span — the
// forecast is generated only across the observable dark hours.
function darkWindowLabel(plan?: PlanResponse): string {
  const slots = plan?.seeing_forecast ?? [];
  if (slots.length < 2) return "—";
  return `${hhmm(slots[0].slot)}–${hhmm(slots[slots.length - 1].slot)}`;
}
