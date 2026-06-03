import { useMemo } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import type { SeeingSlot } from "../types/zenith";

interface Props {
  slots: SeeingSlot[];
}

const REF_LINES = [1.0, 1.5, 2.0, 2.5];

function quality(value: number): { color: string; label: string } {
  if (value < 1.5) return { color: "#36c9c6", label: "GOOD" };
  if (value <= 2.5) return { color: "#4a9eff", label: "AVERAGE" };
  return { color: "#4a5568", label: "POOR" };
}

export function SeeingForecast({ slots }: Props) {
  const data = useMemo(
    () => slots.map((s) => ({ ts: new Date(s.slot).getTime(), seeing: s.predicted_seeing_arcsec })),
    [slots],
  );

  if (data.length === 0) {
    return (
      <div className="seeing-card">
        <div className="seeing-card__head">
          <div className="seeing-card__label">Seeing forecast</div>
        </div>
        <div className="seeing-card__range muted">no data</div>
      </div>
    );
  }

  const values = data.map((d) => d.seeing);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const q = quality(mean);

  const domLo = Math.min(lo, 0.5);
  const domHi = Math.max(hi, 3);
  // Reversed axis → smaller value at top (0%), larger at bottom (100%).
  const refs = REF_LINES.filter((v) => v > domLo && v < domHi).map((v) => ({
    v,
    top: ((v - domLo) / (domHi - domLo)) * 100,
  }));

  return (
    <div className="seeing-card" aria-label="Seeing forecast sparkline">
      <div className="seeing-card__head">
        <div className="seeing-card__label">Seeing forecast</div>
        <div className="seeing-card__quality" style={{ color: q.color }}>
          {q.label}
        </div>
      </div>
      <div className="seeing-card__range">
        {lo.toFixed(1)}–{hi.toFixed(1)}″
        <span style={{ color: "var(--text-tertiary)" }}> · mean {mean.toFixed(1)}″</span>
      </div>
      <div className="seeing-card__chart">
        <div className="seeing-card__refs">
          {refs.map((r) => (
            <div key={r.v} className="seeing-ref" style={{ top: `${r.top}%` }}>
              <span>{r.v.toFixed(1)}″</span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
            <YAxis hide domain={[domLo, domHi]} reversed />
            <Line
              type="monotone"
              dataKey="seeing"
              stroke={q.color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
