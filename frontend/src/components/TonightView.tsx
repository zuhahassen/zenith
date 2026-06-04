import { Suspense, lazy, useEffect } from "react";
import { SeeingStrip } from "./SeeingStrip";
import { TargetTable } from "./TargetTable";
import { durationLabel, hhmm, tzLabel } from "../lib/format";
import type { PlanResponse, ScoredTarget } from "../types/zenith";

const Timeline = lazy(() =>
  import("./Timeline").then((m) => ({ default: m.Timeline })),
);

interface Props {
  data: PlanResponse;
  selectedName: string | null;
  onSelect: (t: ScoredTarget) => void;
}

export function TonightView({ data, selectedName, onSelect }: Props) {
  // Warm the browser image cache for the top targets so their reference photos
  // are already decoded by the time the observer opens a detail card.
  useEffect(() => {
    const ordered = data.ai_plan?.ordered_targets ?? [];
    ordered.slice(0, 5).forEach((t) => {
      const url = t.reference_image?.url;
      if (url) {
        const img = new Image();
        img.src = url;
      }
    });
  }, [data.ai_plan]);

  const seeingVals = data.seeing_forecast
    .map((s) => s.predicted_seeing_arcsec)
    .filter((v) => v > 0);
  const sLo = seeingVals.length ? Math.min(...seeingVals) : null;
  const sHi = seeingVals.length ? Math.max(...seeingVals) : null;

  const slots = data.seeing_forecast;
  const dark =
    slots.length >= 2
      ? `${hhmm(slots[0].slot)} – ${hhmm(slots[slots.length - 1].slot)} ${tzLabel()}`
      : "—";
  const darkDur =
    slots.length >= 2
      ? durationLabel(
          (new Date(slots[slots.length - 1].slot).getTime() -
            new Date(slots[0].slot).getTime()) /
            60000,
        )
      : "";

  const aiNames = data.ai_plan?.ordered_targets.map((t) => t.name) ?? [];
  const summary = data.ai_plan?.session_summary;
  const isEmpty = data.targets.length === 0;

  return (
    <div className="tonight">
      <div className="session-strip">
        <span><span className="session-strip__k">Dark</span> {dark}{darkDur ? ` (${darkDur})` : ""}</span>
        <span className="session-strip__sep">·</span>
        {data.moon_illumination != null && (
          <>
            <span><span className="session-strip__k">Moon</span> {(data.moon_illumination * 100).toFixed(0)}%</span>
            <span className="session-strip__sep">·</span>
          </>
        )}
        {sLo != null && sHi != null && (
          <>
            <span><span className="session-strip__k">Seeing</span> {sLo.toFixed(1)}–{sHi.toFixed(1)}″</span>
            <span className="session-strip__sep">·</span>
          </>
        )}
        <span><span className="session-strip__k">Bortle</span> {data.bortle_class}</span>
        <span className="session-strip__sep">·</span>
        <span>{data.targets.length} targets</span>
      </div>

      {summary && (
        <div className="session-strip" style={{ fontFamily: "var(--font-ui)", color: "var(--text-dim)" }}>
          {summary}
        </div>
      )}

      <SeeingStrip slots={data.seeing_forecast} />

      {isEmpty ? (
        <div className="empty-note">
          <div className="label" style={{ marginBottom: 6 }}>No targets for this plan</div>
          {data.notice ?? "No targets matched. Try a different date, location, or aperture."}
        </div>
      ) : (
        <div className="tonight__body">
          <div className="tonight__list">
            <TargetTable
              targets={data.targets}
              selectedName={selectedName}
              onSelect={onSelect}
              aiOrderedNames={aiNames}
            />
          </div>
          <div className="tonight__timeline">
            <Suspense fallback={<div className="center-load">Loading timeline…</div>}>
              <Timeline targets={data.targets} selectedName={selectedName} onSelect={onSelect} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

