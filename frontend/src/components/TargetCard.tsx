import { Sparkles, Telescope, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { format } from "date-fns";
import type { AIPlan, Mode, ScoredTarget } from "../types/zenith";

const FILTER_ORDER = ["L", "R", "G", "B", "Ha", "OIII", "SII"];

const ACCENT = "#4a9eff";
const NEGATIVE = "#e05c5c";

const TYPE_COLORS: Record<string, string> = {
  Galaxy: "#4a9eff",
  Nebula: "#36c9c6",
  GlCl: "#e8edf5",
  OpenCl: "#6b8fa8",
};

function typeColor(kind: string): string {
  return TYPE_COLORS[kind] ?? "#6b8fa8";
}

function seeingColor(value: number): string {
  if (value < 1.5) return "#36c9c6";
  if (value <= 2.5) return "#4a9eff";
  return "#4a5568";
}

// Decimal degrees → sexagesimal RA (hours) and Dec (degrees).
function formatRA(deg: number): string {
  let h = (deg / 15) % 24;
  if (h < 0) h += 24;
  const hh = Math.floor(h);
  const mFloat = (h - hh) * 60;
  const mm = Math.floor(mFloat);
  const ss = Math.round((mFloat - mm) * 60);
  return `${pad(hh)}h ${pad(mm)}m ${pad(ss)}s`;
}

function formatDec(deg: number): string {
  const sign = deg < 0 ? "−" : "+";
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const mFloat = (a - dd) * 60;
  const mm = Math.floor(mFloat);
  const ss = Math.round((mFloat - mm) * 60);
  return `${sign}${pad(dd)}° ${pad(mm)}′ ${pad(ss)}″`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

interface Props {
  target: ScoredTarget | null;
  aiPlan?: AIPlan;
  predictedSeeing?: number;
  mode?: Mode;
  rating?: number; // 1 = up, -1 = down, 0/undefined = unrated
  onRate?: (name: string, rating: number) => void;
  onClose: () => void;
}

export function TargetCard({
  target,
  aiPlan,
  predictedSeeing,
  mode = "observer",
  rating = 0,
  onRate,
  onClose,
}: Props) {
  const open = target !== null;
  const isAstro = mode === "astrophotographer";

  const aiItem = aiPlan?.ordered_targets.find((t) => t.name === target?.name);
  const why = aiItem?.why || target?.why;
  const referenceImage = aiItem?.reference_image ?? null;
  const filterWindows = target?.filter_windows ?? null;

  return (
    <aside className={`target-card ${open ? "open" : ""}`} aria-hidden={!open}>
      {target && (
        <div className="target-card__inner">
          <button className="target-card__close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>

          <div>
            <div className="target-card__name">{target.name}</div>
            <div className="target-card__sub">
              <span className="type-badge" style={{ color: typeColor(target.kind) }}>
                {target.kind}
              </span>
              {target.common_name ? <span>{target.common_name}</span> : null}
            </div>
            {isAstro && target.fov_note && (
              <div
                style={{
                  fontSize: 11,
                  fontStyle: "italic",
                  marginTop: 6,
                  color: "var(--text-tertiary)",
                }}
              >
                {target.fov_note}
              </div>
            )}
          </div>

          {onRate && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button
                className="feedback-btn"
                aria-label="Rate up"
                onClick={() => onRate(target.name, rating === 1 ? 0 : 1)}
                style={{ color: rating === 1 ? ACCENT : undefined }}
              >
                <ThumbsUp size={16} fill={rating === 1 ? ACCENT : "none"} />
              </button>
              <button
                className="feedback-btn"
                aria-label="Rate down"
                onClick={() => onRate(target.name, rating === -1 ? 0 : -1)}
                style={{ color: rating === -1 ? NEGATIVE : undefined }}
              >
                <ThumbsDown size={16} fill={rating === -1 ? NEGATIVE : "none"} />
              </button>
            </div>
          )}

          <div className="target-card__field">
            <div className="target-card__field-label">Coordinates</div>
            <div className="target-card__field-value">
              α {formatRA(target.ra_deg)} &nbsp; δ {formatDec(target.dec_deg)}
            </div>
          </div>

          <div className="target-card__field">
            <div className="target-card__field-label">Score</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="score-bar" style={{ flex: 1 }}>
                <div
                  className="score-bar__fill"
                  style={{ transform: `scaleX(${Math.min(target.score, 1)})` }}
                />
              </div>
              <span className="mono" style={{ fontSize: 12, color: "var(--text-mono)" }}>
                {target.score.toFixed(3)}
              </span>
            </div>
          </div>

          {why && (
            <div className="target-card__why">
              <Sparkles size={14} />
              <span>{why}</span>
            </div>
          )}

          <div className="target-card__field">
            <div className="target-card__field-label">Observation window</div>
            <div className="target-card__field-value">
              {target.window_start && target.window_end ? (
                <>
                  {format(new Date(target.window_start), "HH:mm")} →{" "}
                  {format(new Date(target.window_end), "HH:mm")} UTC
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {" "}
                    · {target.window_minutes.toFixed(0)} min
                  </span>
                </>
              ) : (
                "—"
              )}
            </div>
          </div>

          <div className="target-card__field">
            <div className="target-card__field-label">Peak altitude</div>
            <div className="target-card__field-value">
              {target.max_alt_deg.toFixed(1)}°
              <span style={{ color: "var(--text-tertiary)" }}>
                {" "}
                · airmass {target.min_airmass.toFixed(2)}
              </span>
            </div>
          </div>

          {predictedSeeing !== undefined && (
            <div className="target-card__field">
              <div className="target-card__field-label">Seeing at slot</div>
              <div className="target-card__field-value">
                <span
                  className="seeing-dot"
                  style={{ background: seeingColor(predictedSeeing) }}
                />
                <span style={{ color: seeingColor(predictedSeeing) }}>
                  {predictedSeeing.toFixed(2)}″
                </span>
              </div>
            </div>
          )}

          {target.magnitude !== null && (
            <div className="target-card__field">
              <div className="target-card__field-label">Magnitude / surface brightness</div>
              <div className="target-card__field-value">
                mag {target.magnitude.toFixed(1)}
                {target.surface_brightness !== null
                  ? ` · SB ${target.surface_brightness.toFixed(2)} mag/arcmin²`
                  : ""}
              </div>
            </div>
          )}

          {isAstro && filterWindows && (
            <div className="target-card__field">
              <div className="target-card__field-label">Filter schedule</div>
              <table className="filter-table">
                <thead>
                  <tr>
                    <th style={{ padding: "2px 6px 2px 8px" }}>Filter</th>
                    <th style={{ padding: "2px 6px" }}>Window</th>
                    <th style={{ padding: "2px 8px 2px 0" }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {FILTER_ORDER.filter((f) => filterWindows[f]).map((f) => {
                    const w = filterWindows[f];
                    return (
                      <tr key={f}>
                        <td className="filter-name" style={{ padding: "4px 6px 4px 8px" }}>
                          {f}
                        </td>
                        <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                          {w.start}–{w.end}
                        </td>
                        <td style={{ padding: "4px 8px 4px 0", lineHeight: 1.4 }}>{w.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {referenceImage ? (
            <ReferenceImageBlock
              url={referenceImage.url}
              source={referenceImage.source}
              name={target.name}
            />
          ) : (
            <div className="target-card__image-placeholder">
              <Telescope size={26} strokeWidth={1.25} />
              No reference image available
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function ReferenceImageBlock({
  url,
  source,
  name,
}: {
  url: string;
  source: string;
  name: string;
}) {
  const isHST = /hst|hubble|hla/i.test(source);
  return (
    <div className="target-card__image">
      <div className={`target-card__image-frame ${isHST ? "hst" : ""}`}>
        <img src={url} alt={`${name} reference image`} />
      </div>
      <div
        className="target-card__image-source"
        style={{ color: isHST ? ACCENT : "var(--text-tertiary)" }}
        title={source}
      >
        <Telescope size={12} />
        <span>{isHST ? "Hubble Legacy Archive" : "DSS2 Survey"}</span>
      </div>
    </div>
  );
}
