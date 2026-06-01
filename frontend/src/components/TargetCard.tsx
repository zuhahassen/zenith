import { X } from "lucide-react";
import { format } from "date-fns";
import type { AIPlan, ScoredTarget } from "../types/zenith";

interface Props {
  target: ScoredTarget | null;
  aiPlan?: AIPlan;
  predictedSeeing?: number;
  onClose: () => void;
}

export function TargetCard({ target, aiPlan, predictedSeeing, onClose }: Props) {
  const open = target !== null;

  // Prefer Claude's "why" if available — falls back to the deterministic one.
  const aiWhy = aiPlan?.ordered_targets.find((t) => t.name === target?.name)?.why;
  const why = aiWhy || target?.why;

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
          </div>

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

          <div className="target-card__image-placeholder">
            Reference image — coming soon
          </div>
        </div>
      )}
    </aside>
  );
}
