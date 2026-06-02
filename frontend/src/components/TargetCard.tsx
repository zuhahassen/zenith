import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { format } from "date-fns";
import type { AIPlan, Mode, ScoredTarget } from "../types/zenith";

const FILTER_ORDER = ["L", "R", "G", "B", "Ha", "OIII", "SII"];

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

  // Prefer Claude's "why" if available — falls back to the deterministic one.
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
              {target.kind}
              {target.common_name ? ` — ${target.common_name}` : ""}
            </div>
            {isAstro && target.fov_note && (
              <div
                className="muted"
                style={{ fontSize: 11, fontStyle: "italic", marginTop: 4 }}
              >
                {target.fov_note}
              </div>
            )}
          </div>

          {onRate && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                aria-label="Rate up"
                onClick={() => onRate(target.name, rating === 1 ? 0 : 1)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: rating === 1 ? "#e8a045" : "#555",
                  padding: 2,
                }}
              >
                <ThumbsUp size={16} fill={rating === 1 ? "#e8a045" : "none"} />
              </button>
              <button
                aria-label="Rate down"
                onClick={() => onRate(target.name, rating === -1 ? 0 : -1)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: rating === -1 ? "#888680" : "#555",
                  opacity: rating === -1 ? 0.6 : 1,
                  padding: 2,
                }}
              >
                <ThumbsDown size={16} />
              </button>
            </div>
          )}

          <div className="target-card__field">
            <div className="target-card__field-label">Coordinates</div>
            <div className="target-card__field-value">
              RA {target.ra_deg.toFixed(4)}° &nbsp; DEC {target.dec_deg.toFixed(4)}°
            </div>
          </div>

          <div className="target-card__field">
            <div className="target-card__field-label">
              Score &nbsp;
              <span className="mono">{target.score.toFixed(3)}</span>
            </div>
            <div className="score-bar">
              <div
                className="score-bar__fill"
                style={{ transform: `scaleX(${Math.min(target.score, 1)})` }}
              />
            </div>
          </div>

          {why && <div className="target-card__why">{why}</div>}

          <div className="target-card__field">
            <div className="target-card__field-label">Best window</div>
            <div className="target-card__field-value">
              {target.window_start && target.window_end ? (
                <>
                  {format(new Date(target.window_start), "HH:mm")} →{" "}
                  {format(new Date(target.window_end), "HH:mm")} UTC
                  <span className="muted"> · {target.window_minutes.toFixed(0)} min</span>
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
              <span className="muted"> · airmass {target.min_airmass.toFixed(2)}</span>
            </div>
          </div>

          {predictedSeeing !== undefined && (
            <div className="target-card__field">
              <div className="target-card__field-label">Predicted seeing</div>
              <div className="target-card__field-value">{predictedSeeing.toFixed(2)}″</div>
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
              <table
                className="mono"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 11,
                  color: "#888680",
                  marginTop: 4,
                }}
              >
                <thead>
                  <tr style={{ color: "#c4bfb8", textAlign: "left" }}>
                    <th style={{ padding: "2px 6px 2px 0" }}>Filter</th>
                    <th style={{ padding: "2px 6px" }}>Window</th>
                    <th style={{ padding: "2px 0" }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {FILTER_ORDER.filter((f) => filterWindows[f]).map((f) => {
                    const w = filterWindows[f];
                    return (
                      <tr key={f} style={{ borderTop: "1px solid #1a1a1a" }}>
                        <td style={{ padding: "3px 6px 3px 0", color: "#e8a045" }}>{f}</td>
                        <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>
                          {w.start}–{w.end}
                        </td>
                        <td style={{ padding: "3px 0", lineHeight: 1.4 }}>{w.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {referenceImage ? (
            <div className="target-card__image">
              <img
                src={referenceImage.url}
                alt={`${target.name} reference image`}
                style={{
                  width: "100%",
                  aspectRatio: "1",
                  objectFit: "cover",
                  filter: "brightness(0.9) contrast(1.1)",
                }}
              />
              <p style={{ fontSize: "10px", color: "#888680", marginTop: "4px" }}>
                {referenceImage.source} · {target.name}
              </p>
            </div>
          ) : (
            <div className="target-card__image-placeholder">
              No reference image available
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
