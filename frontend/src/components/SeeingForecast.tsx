import { useMemo } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import type { SeeingSlot } from "../types/zenith";

interface Props {
  slots: SeeingSlot[];
}

function colorFor(value: number): string {
  if (value < 1.5) return "#e8a045"; // good
  if (value < 2.5) return "#c4bfb8"; // average
  return "#888680"; // poor
}

export function SeeingForecast({ slots }: Props) {
  const data = useMemo(
    () => slots.map((s) => ({ ts: new Date(s.slot).getTime(), seeing: s.predicted_seeing_arcsec })),
    [slots],
  );

  if (data.length === 0) {
    return (
      <div className="seeing-card">
        <div className="seeing-card__label">Seeing forecast</div>
        <div className="seeing-card__range muted">no data</div>
      </div>
    );
  }

  const values = data.map((d) => d.seeing);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  return (
    <div className="seeing-card" aria-label="Seeing forecast sparkline">
      <div className="seeing-card__label">Seeing forecast</div>
      <div className="seeing-card__range">
        {lo.toFixed(1)}–{hi.toFixed(1)}″
        <span className="muted"> · mean {mean.toFixed(2)}″</span>
      </div>
      <div style={{ height: 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
            <YAxis hide domain={[Math.min(lo, 0.5), Math.max(hi, 3)]} reversed />
            <Line
              type="monotone"
              dataKey="seeing"
              stroke={colorFor(mean)}
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
