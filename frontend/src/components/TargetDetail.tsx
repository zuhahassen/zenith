import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import {
  airmassLabel,
  durationLabel,
  formatDec,
  formatRA,
  hhmm,
  popularName,
  seeingHex,
  tzLabel,
  typeInfo,
} from "../lib/format";
import { getTargetImage, type TargetImage } from "../lib/targetImage";
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
  // Collapse the detail panel back to its empty placeholder state.
  onClose?: () => void;
}

export function TargetDetail({
  target,
  aiPlan,
  predictedSeeing,
  mode,
  rating,
  onRate,
  onViewCalendar,
  onClose,
}: Props) {
  const info = typeInfo(target.kind);
  const aiItem = aiPlan?.ordered_targets.find((t) => t.name === target.name);
  const why = aiItem?.why || target.why;
  const observerNote = aiItem?.observer_note;
  const isAstro = mode === "astrophotographer";
  const filterWindows = target.filter_windows ?? null;

  // Resolve the best available reference image client-side via the priority
  // waterfall (LCO → AstroPix → APOD → DSS2 survey fallback). A target with
  // valid coordinates always yields an image; only genuinely missing
  // coordinates fall through to the type placeholder.
  const hasCoords =
    Number.isFinite(target.ra_deg) && Number.isFinite(target.dec_deg);
  const [image, setImage] = useState<TargetImage | null>(null);
  const [imgState, setImgState] = useState<"loading" | "loaded" | "error">("loading");
  useEffect(() => {
    if (!hasCoords) {
      console.warn("[Zenith images] missing coordinates for", target.name);
      setImage(null);
      setImgState("error");
      return;
    }
    let active = true;
    setImage(null);
    setImgState("loading");
    getTargetImage(target.ra_deg, target.dec_deg, target.name).then((img) => {
      if (active) setImage(img);
    });
    return () => {
      active = false;
    };
  }, [target.name, target.ra_deg, target.dec_deg, hasCoords]);

  return (
    <div className="tdetail">
      <div className="tdetail__head">
        <div className="tdetail__title">
          <div className="tdetail__name">
            {target.name}
            <span className="tdetail__badge" style={{ color: info.color }}>{info.code}</span>
          </div>
          <div className="tdetail__sub">
            {(target.common_name || popularName(target.name)) ? `${target.common_name || popularName(target.name)} · ` : ""}
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
          {onClose && (
            <button className="icon-btn tdetail__close" aria-label="Close details" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="tdetail__imgwrap">
        <div className="tdetail__img">
          {imgState !== "error" && imgState !== "loaded" && (
            <div className="img-placeholder" aria-label="Loading reference image" />
          )}
          {imgState === "error" ? (
            <TypePlaceholder code={info.code} label={info.label} color={info.color} />
          ) : (
            image && (
              <img
                key={`ref-img-${target.name}-${target.ra_deg}`}
                src={image.url}
                alt={`${target.name} reference`}
                style={{ display: imgState === "loaded" ? "block" : "none" }}
                onLoad={() => setImgState("loaded")}
                onError={() => setImgState("error")}
              />
            )
          )}
        </div>
        {imgState === "loaded" && image && (
          <div className="img-credit">
            <span className={`img-credit__badge img-credit__badge--${image.source.toLowerCase()}`}>
              {image.source}
            </span>
            <span className="img-credit__text">{image.credit}</span>
          </div>
        )}
      </div>

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
            {hhmm(target.window_start)} → {hhmm(target.window_end)} {tzLabel()}
          </span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Duration</span>
          <span className="kvline__v">{durationLabel(target.window_minutes)}</span>
        </div>
        <div className="kvline">
          <span className="kvline__k">Peak</span>
          <span className="kvline__v">
            {target.max_alt_deg.toFixed(1)}°{target.transit_time ? ` at ${hhmm(target.transit_time)} ${tzLabel()}` : ""}
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

      {isAstro && (target.fov_note || filterWindows) ? (
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
      ) : null}
    </div>
  );
}

// Type-aware placeholder shown when a target has no coordinates and therefore
// no fetchable imagery. A small symbolic SVG hints at the object class.
function TypePlaceholder({
  code,
  label,
  color,
}: {
  code: string;
  label: string;
  color: string;
}) {
  return (
    <div className="tdetail__typeph">
      <svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke={color} aria-hidden>
        <TypeGlyph code={code} />
      </svg>
      <div className="tdetail__typeph-text">No imagery available for {label.toLowerCase()}</div>
    </div>
  );
}

function TypeGlyph({ code }: { code: string }) {
  if (code === "Gx") {
    // Spiral galaxy.
    return (
      <g strokeWidth={1.4}>
        <path d="M28 28 C 18 20, 12 30, 20 40 C 30 48, 44 40, 40 26 C 37 16, 24 14, 18 22" />
        <circle cx="28" cy="28" r="2.2" fill="currentColor" stroke="none" />
      </g>
    );
  }
  if (code === "GlCl" || code === "OpCl") {
    // Cluster: scatter of dots.
    const pts = [
      [28, 14],
      [18, 22],
      [38, 22],
      [14, 33],
      [28, 30],
      [42, 33],
      [21, 42],
      [35, 42],
      [28, 46],
    ];
    return (
      <g fill="currentColor" stroke="none">
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 2.2 : 1.5} />
        ))}
      </g>
    );
  }
  if (code === "PN") {
    // Planetary nebula: ring.
    return (
      <g strokeWidth={1.4}>
        <circle cx="28" cy="28" r="13" />
        <circle cx="28" cy="28" r="6" opacity={0.5} />
      </g>
    );
  }
  if (code === "EN" || code === "RN" || code === "SNR") {
    // Nebula: soft cloud.
    return (
      <path
        strokeWidth={1.4}
        d="M18 34 C 12 34, 12 26, 19 26 C 19 19, 30 18, 32 24 C 40 22, 44 30, 38 34 C 40 40, 30 42, 26 38 C 22 41, 16 40, 18 34 Z"
      />
    );
  }
  // Default: simple star.
  return (
    <path
      strokeWidth={1.4}
      d="M28 14 L31 25 L42 28 L31 31 L28 42 L25 31 L14 28 L25 25 Z"
      strokeLinejoin="round"
    />
  );
}
