import { RotateCcw, X } from "lucide-react";
import { seeingHex, typeInfo } from "../lib/format";
import type { HistorySession } from "../types/zenith";

interface Props {
  session: HistorySession;
  onPlanAgain: (session: HistorySession) => void;
  onClose: () => void;
}

// Right-panel detail for a past session — mirrors the target detail panel so
// clicking a history row opens to the side instead of expanding inline.
export function HistorySessionDetail({ session: s, onPlanAgain, onClose }: Props) {
  const info = typeInfo(s.top_target_type);
  const moonPct = s.moon_illumination != null ? Math.round(s.moon_illumination * 100) : null;

  return (
    <div className="tdetail">
      <div className="tdetail__head">
        <div className="tdetail__title">
          <div className="tdetail__name">{fmtDate(s.timestamp)}</div>
          <div className="tdetail__sub">{s.location_name || coords(s)}</div>
        </div>
        <div className="tdetail__fb">
          <button className="icon-btn tdetail__close" onClick={onClose} aria-label="Close session detail">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="tsection">
        <div className="label tsection__label">Session</div>
        <div className="kvline">
          <span className="kvline__k">Mode</span>
          <span className="kvline__v">
            {s.mode === "astrophotographer" ? "Astrophotographer" : "Visual observer"}
          </span>
        </div>
        {s.aperture_mm != null && (
          <div className="kvline">
            <span className="kvline__k">Aperture</span>
            <span className="kvline__v">{s.aperture_mm} mm</span>
          </div>
        )}
        {s.bortle != null && (
          <div className="kvline">
            <span className="kvline__k">Bortle</span>
            <span className="kvline__v">{s.bortle}</span>
          </div>
        )}
        <div className="kvline">
          <span className="kvline__k">Targets</span>
          <span className="kvline__v">{s.target_count ?? "—"}</span>
        </div>
        {moonPct != null && (
          <div className="kvline">
            <span className="kvline__k">Moon</span>
            <span className="kvline__v">{moonPct}% illuminated</span>
          </div>
        )}
        {s.seeing_median != null && (
          <div className="kvline">
            <span className="kvline__k">Seeing</span>
            <span className="kvline__v" style={{ color: seeingHex(s.seeing_median) }}>
              {s.seeing_median.toFixed(1)}″ median
            </span>
          </div>
        )}
        {s.top_target && (
          <div className="kvline">
            <span className="kvline__k">Top target</span>
            <span className="kvline__v">
              {s.top_target}
              {s.top_target_type && (
                <span style={{ color: info.color }}> ({info.code})</span>
              )}
            </span>
          </div>
        )}
      </div>

      {s.session_summary && (
        <div className="tsection">
          <div className="label tsection__label">Summary</div>
          <div className="tnote">{s.session_summary}</div>
        </div>
      )}

      <div className="tsection">
        <button className="primary" style={{ width: "100%" }} onClick={() => onPlanAgain(s)}>
          <RotateCcw size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
          Plan this session again
        </button>
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function coords(s: HistorySession): string {
  if (s.lat == null || s.lon == null) return "Unknown";
  return `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`;
}
