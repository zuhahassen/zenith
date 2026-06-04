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
}

export function TargetDetail({ target, aiPlan, predictedSeeing, mode, rating, onRate }: Props) {
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
          <div className="tdetail__name">{target.name}</div>
          <div className="tdetail__sub">
            {info.label}
            {target.common_name ? ` · ${target.common_name}` : ""}
          </div>
        </div>
        <div className="tdetail__fb">
          <button
            className={`icon-btn up ${rating === 1 ? "on" : ""}`}
            aria-label="Rate up"
            onClick={() => onRate(target.name, rating === 1 ? 0 : 1)}
          >
            <ThumbsUp size={15} fill={rating === 1 ? "currentColor" : "none"} />
          </button>
          <button
            className={`icon-btn down ${rating === -1 ? "on" : ""}`}
            aria-label="Rate down"
            onClick={() => onRate(target.name, rating === -1 ? 0 : -1)}
          >
            <ThumbsDown size={15} fill={rating === -1 ? "currentColor" : "none"} />
          </button>
        </div>
      </div>

      {refImage ? (
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
          {imgState === "loaded" && <span className="tdetail__img-src">{refImage.source}</span>}
        </div>
      ) : (
        <div className="tdetail__img-ph">
          <Telescope size={22} strokeWidth={1.25} />
          No reference image
        </div>
      )}

      <div className="kv-grid">
        <div className="kv">
          <span className="kv__k">RA (α)</span>
          <span className="kv__v">{formatRA(target.ra_deg)}</span>
        </div>
        <div className="kv">
          <span className="kv__k">Dec (δ)</span>
          <span className="kv__v">{formatDec(target.dec_deg)}</span>
        </div>
        <div className="kv">
          <span className="kv__k">Mag</span>
          <span className="kv__v">{target.magnitude != null ? target.magnitude.toFixed(1) : "—"}</span>
        </div>
        <div className="kv">
          <span className="kv__k">Type</span>
          <span className="kv__v" style={{ color: info.color }}>{info.code}</span>
        </div>
      </div>

      <div className="tsection">
        <div className="label tsection__label">Visibility</div>
        <div className="kvline">
          <span className="kvline__k">Window</span>
          <span className="kvline__v">
            {hhmm(target.window_start)} → {hhmm(target.window_end)} ({durationLabel(target.window_minutes)})
          </span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Peak alt</span>
          <span className="kvline__v">
            {target.max_alt_deg.toFixed(1)}°{target.transit_time ? ` at ${hhmm(target.transit_time)}` : ""}
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
        <div className="kvline">
          <span className="kvline__k">Score</span>
          <span className="kvline__v">
            <span className="minibar">
              <span className="minibar__fill" style={{ width: `${Math.min(target.score, 1) * 100}%` }} />
            </span>{" "}
            {target.score.toFixed(3)}
          </span>
        </div>
      </div>

      {why && (
        <div className="tsection">
          <div className="label tsection__label">Claude's note</div>
          <div className="tsection__body">{why}</div>
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
          <div className="label tsection__label">Astrophotographer</div>
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
