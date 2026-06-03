import { useMemo } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { seeingHex, seeingQuality } from "../lib/format";
import type { SeeingSlot } from "../types/zenith";

interface Props {
  slots: SeeingSlot[];
}

export function SeeingStrip({ slots }: Props) {
  const data = useMemo(
    () => slots.map((s) => ({ ts: new Date(s.slot).getTime(), seeing: s.predicted_seeing_arcsec })),
    [slots],
  );

  if (data.length === 0) return null;

  const values = data.map((d) => d.seeing);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const q = seeingQuality(mean);

  return (
    <div className="seeing-strip">
      <div className="seeing-strip__label">
        <span className="label">Seeing forecast</span>
        <span className="seeing-strip__quality" style={{ color: q.color }}>
          {q.label}
        </span>
        <span className="seeing-strip__range">
          {lo.toFixed(1)}–{hi.toFixed(1)}″ · mean {mean.toFixed(1)}″
        </span>
      </div>
      <div className="seeing-strip__spark">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 4, bottom: 6, left: 4 }}>
            <YAxis hide domain={[Math.min(lo, 0.5), Math.max(hi, 3)]} reversed />
            <Line
              type="monotone"
              dataKey="seeing"
              stroke={seeingHex(mean)}
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
