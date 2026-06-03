import { GitCompare, History, Moon, Settings, Telescope } from "lucide-react";
import { useCommunityFavorites } from "../hooks/useCommunityFavorites";
import { seeingQuality } from "../lib/format";
import type { PlanResponse } from "../types/zenith";

export type View = "tonight" | "compare" | "history" | "settings";

const NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "tonight", label: "Tonight", icon: <Telescope size={15} /> },
  { id: "compare", label: "Compare Sites", icon: <GitCompare size={15} /> },
  { id: "history", label: "History", icon: <History size={15} /> },
  { id: "settings", label: "Settings", icon: <Settings size={15} /> },
];

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  plan?: PlanResponse;
}

export function Sidebar({ view, onNavigate, plan }: Props) {
  const community = useCommunityFavorites(5);
  const favorites = community.data?.favorites ?? [];

  const seeingVals = (plan?.seeing_forecast ?? [])
    .map((s) => s.predicted_seeing_arcsec)
    .filter((v) => v > 0);
  const meanSeeing = seeingVals.length
    ? seeingVals.reduce((a, b) => a + b, 0) / seeingVals.length
    : null;
  const darkWindow = darkWindowLabel(plan);

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

      {favorites.length > 0 && (
        <div className="sidebar__block">
          <div className="label sidebar__block-title">Community · nearby</div>
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
        </div>
      )}

      <div className="sidebar__block">
        <div className="status-block">
          <div className="status-row">
            <span className="status-row__k">Seeing model</span>
            <span className="status-row__v">
              {plan ? (plan.seeing_model_loaded ? "loaded" : "fallback") : "—"}
            </span>
          </div>
          <div className="status-row">
            <span className="status-row__k">Bortle</span>
            <span className="status-row__v">{plan ? plan.bortle_class : "—"}</span>
          </div>
          <div className="status-row">
            <span className="status-row__k">Seeing</span>
            <span className="status-row__v">
              {meanSeeing != null ? (
                <>
                  <span
                    className="status-dot"
                    style={{ background: seeingQuality(meanSeeing).color }}
                  />
                  {meanSeeing.toFixed(1)}″
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="status-row">
            <span className="status-row__k">
              <Moon size={11} style={{ verticalAlign: "middle", marginRight: 3 }} />
              Dark
            </span>
            <span className="status-row__v">{darkWindow}</span>
          </div>
        </div>
      </div>
    </nav>
  );
}

// Derive a coarse dark-window label from the seeing-forecast slot span — the
// forecast is generated only across the observable dark hours.
function darkWindowLabel(plan?: PlanResponse): string {
  const slots = plan?.seeing_forecast ?? [];
  if (slots.length < 2) return "—";
  const start = new Date(slots[0].slot);
  const end = new Date(slots[slots.length - 1].slot);
  const f = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${f(start)}–${f(end)}`;
}
