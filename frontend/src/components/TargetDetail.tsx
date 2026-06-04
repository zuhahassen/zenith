import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp, Telescope } from "lucide-react";
import {
  airmassLabel,
  durationLabel,
  formatDec,
  formatRA,
  hhmm,
  seeingHex,
  typeInfo,
} from "../lib/format";
import type { AIPlan, Mode, ScoredTarget } from "../types/zenith";

const FILTER_ORDER = ["L", "R", "G", "B", "Ha", "OIII", "SII"];

interface Props {
  target: ScoredTarget;
  aiPlan?: AIPlan;
  predictedSeeing?: number;
  mode: Mode;
  rating: number;
  onRate: (name: string, rating: number) => void;
  // Deep-link into the multi-night calendar for this target.
  onViewCalendar?: (targetName: string) => void;
}

export function TargetDetail({
  target,
  aiPlan,
  predictedSeeing,
  mode,
  rating,
  onRate,
  onViewCalendar,
}: Props) {
  const info = typeInfo(target.kind);
  const aiItem = aiPlan?.ordered_targets.find((t) => t.name === target.name);
  const why = aiItem?.why || target.why;
  const observerNote = aiItem?.observer_note;
  const refImage = aiItem?.reference_image ?? null;
  const isAstro = mode === "astrophotographer";
  const filterWindows = target.filter_windows ?? null;

  // Reset to the loading state whenever the selected target changes so the
  // shimmer shows for the new image instead of briefly flashing the old one.
  const [imgState, setImgState] = useState<"loading" | "loaded" | "error">("loading");
  useEffect(() => {
    setImgState(refImage ? "loading" : "error");
  }, [target.name, refImage]);

  return (
    <div className="tdetail">
      <div className="tdetail__head">
        <div className="tdetail__title">
          <div className="tdetail__name">
            {target.name}
            <span className="tdetail__badge" style={{ color: info.color }}>{info.code}</span>
          </div>
          <div className="tdetail__sub">
            {target.common_name ? `${target.common_name} · ` : ""}
            {info.label}
          </div>
        </div>
        <div className="tdetail__fb">
          <button
            className={`icon-btn ${rating === 1 ? "on" : ""}`}
            aria-label="Rate up"
            onClick={() => onRate(target.name, rating === 1 ? 0 : 1)}
          >
            <ThumbsUp size={14} fill={rating === 1 ? "currentColor" : "none"} />
          </button>
          <button
            className={`icon-btn ${rating === -1 ? "on" : ""}`}
            aria-label="Rate down"
            onClick={() => onRate(target.name, rating === -1 ? 0 : -1)}
          >
            <ThumbsDown size={14} fill={rating === -1 ? "currentColor" : "none"} />
          </button>
        </div>
      </div>

      {refImage ? (
        <div className="tdetail__imgwrap">
          <div className="tdetail__img">
            {imgState === "loading" && (
              <div className="img-placeholder" aria-label="Loading reference image" />
            )}
            {imgState === "error" ? (
              <div className="tdetail__img-ph">
                <Telescope size={22} strokeWidth={1.25} />
                No reference image available
              </div>
            ) : (
              <img
                key={`ref-img-${target.name}-${target.ra_deg}`}
                src={refImage.url}
                alt={`${target.name} reference`}
                style={{ display: imgState === "loaded" ? "block" : "none" }}
                onLoad={() => setImgState("loaded")}
                onError={() => setImgState("error")}
              />
            )}
          </div>
          {imgState === "loaded" && (
            <div className="label tdetail__imgsrc">{refImage.source.toUpperCase()}</div>
          )}
        </div>
      ) : (
        <div className="tdetail__img-ph">
          <Telescope size={22} strokeWidth={1.25} />
          No reference image
        </div>
      )}

      <div className="tsection">
        <div className="label tsection__label">Coordinates</div>
        <div className="coord-grid">
          <div className="coord">
            <span className="coord__sym">α</span>
            <span className="coord__val">{formatRA(target.ra_deg)}</span>
          </div>
          <div className="coord">
            <span className="coord__sym">δ</span>
            <span className="coord__val">{formatDec(target.dec_deg)}</span>
          </div>
          <div className="coord">
            <span className="coord__sym">mag</span>
            <span className="coord__val">{target.magnitude != null ? target.magnitude.toFixed(1) : "—"}</span>
          </div>
          <div className="coord">
            <span className="coord__sym">type</span>
            <span className="coord__val" style={{ color: info.color }}>{info.code}</span>
          </div>
        </div>
      </div>

      <div className="tsection">
        <div className="label tsection__label">Visibility</div>
        <div className="kvline">
          <span className="kvline__k">Window</span>
          <span className="kvline__v">
            {hhmm(target.window_start)} → {hhmm(target.window_end)} UTC
          </span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Duration</span>
          <span className="kvline__v">{durationLabel(target.window_minutes)}</span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Peak</span>
          <span className="kvline__v">
            {target.max_alt_deg.toFixed(1)}°{target.transit_time ? ` at ${hhmm(target.transit_time)} UTC` : ""}
          </span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Airmass</span>
          <span className="kvline__v">
            {target.min_airmass.toFixed(2)} ({airmassLabel(target.min_airmass)})
          </span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Moon sep</span>
          <span className="kvline__v">{target.moon_sep_deg.toFixed(0)}°</span>
        </div>
        {predictedSeeing !== undefined && (
          <div className="kvline">
            <span className="kvline__k">Seeing</span>
            <span className="kvline__v" style={{ color: seeingHex(predictedSeeing) }}>
              {predictedSeeing.toFixed(2)}″
            </span>
          </div>
        )}
        <div className="tscore">
          <div className="tscore__bar">
            <div className="tscore__fill" style={{ width: `${Math.min(target.score, 1) * 100}%` }} />
          </div>
          <span className="tscore__val mono">{target.score.toFixed(3)}</span>
        </div>
        {onViewCalendar && (
          <button className="tdetail__callink" onClick={() => onViewCalendar(target.name)}>
            View {target.name} across upcoming months →
          </button>
        )}
      </div>

      {why && (
        <div className="tsection">
          <div className="label tsection__label">Observation note</div>
          <div className="tnote">{why}</div>
        </div>
      )}

      {observerNote && (
        <div className="tsection">
          <div className="label tsection__label">For amateurs</div>
          <div className="amateur">{observerNote}</div>
        </div>
      )}

      {isAstro && (target.fov_note || filterWindows) && (
        <div className="tsection">
          <div className="label tsection__label">Imaging</div>
          {target.fov_note && <div className="tsection__body dim" style={{ marginBottom: 8 }}>{target.fov_note}</div>}
          {filterWindows && (
            <table className="dtable" style={{ fontSize: 11 }}>
              <tbody>
                {FILTER_ORDER.filter((f) => filterWindows[f]).map((f) => {
                  const w = filterWindows[f];
                  return (
                    <tr key={f}>
                      <td className="mono" style={{ color: "var(--accent-text)" }}>{f}</td>
                      <td className="num">{w.start}–{w.end}</td>
                      <td style={{ whiteSpace: "normal", color: "var(--text-dim)" }}>{w.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
