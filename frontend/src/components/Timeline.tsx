import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format } from "date-fns";
import { Telescope } from "lucide-react";
import { typeInfo } from "../lib/format";
import type { ScoredTarget } from "../types/zenith";

// Literal hexes mirror the index.css design tokens (recharts can't read CSS vars).
const C = {
  accent: "#ffffff", // --accent (white)
  grid: "#152040", // --border-dim
  border: "#1e2f50", // --border
  textDim: "#8a9bc4", // --text-dim
  textData: "#c8d8f0", // --text-data
  textFaint: "#3d5080", // --text-faint
  text: "#f0f4ff", // --text
  panel: "#1e3460", // --bg-elevated (tooltip surface)
};
const MONO = "'Space Mono', ui-monospace, monospace";

const MAX_ROWS = 20;

interface Row {
  rank: string;
  range: [number, number];
  ref: ScoredTarget;
}

interface Props {
  targets: ScoredTarget[];
  selectedName: string | null;
  onSelect: (t: ScoredTarget) => void;
}

export function Timeline({ targets, selectedName, onSelect }: Props) {
  const rows: Row[] = useMemo(() => {
    const ranked = targets
      .filter((t) => t.window_start && t.window_end)
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ROWS);
    return ranked.map((t, i) => ({
      rank: String(i + 1),
      range: [
        new Date(t.window_start as string).getTime(),
        new Date(t.window_end as string).getTime(),
      ],
      ref: t,
    }));
  }, [targets]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { domain, ticks } = useMemo(() => computeDomain(rows), [rows]);

  if (!rows.length) {
    return (
      <div className="timeline2">
        <div className="timeline2__head">
          <span className="label">Session timeline</span>
        </div>
        <div className="timeline2__empty">
          <Telescope size={28} strokeWidth={1.25} />
          <div>No targets visible tonight for this location and aperture.</div>
        </div>
      </div>
    );
  }

  const nowInDomain = now >= domain[0] && now <= domain[1];

  return (
    <div className="timeline2">
      <div className="timeline2__head">
        <span className="label">Session timeline · by rank</span>
        <span className="mono" style={{ fontSize: 11, color: C.textDim }}>
          {format(domain[0], "HH:mm")}–{format(domain[1], "HH:mm")} UTC
        </span>
      </div>
      <div className="timeline2__chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 20, bottom: 4, left: 8 }}
          >
            <CartesianGrid stroke={C.grid} horizontal={false} />
            {nowInDomain && (
              <ReferenceLine
                x={now}
                stroke={C.accent}
                strokeWidth={1}
                ifOverflow="extendDomain"
                label={<NowLabel />}
              />
            )}
            <XAxis
              type="number"
              domain={domain}
              ticks={ticks}
              tickFormatter={(v) => format(v as number, "HH:mm")}
              stroke={C.border}
              tick={{ fill: C.textFaint, fontSize: 10, fontFamily: MONO }}
            />
            <YAxis
              type="category"
              dataKey="rank"
              stroke={C.border}
              tick={{ fill: C.textFaint, fontSize: 10, fontFamily: MONO }}
              width={22}
              interval={0}
            />
            <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} content={<TLTooltip />} />
            <Bar
              dataKey="range"
              barSize={4}
              isAnimationActive={false}
              onClick={(d: unknown) => {
                const ref = (d as { payload?: Row }).payload?.ref;
                if (ref) onSelect(ref);
              }}
              shape={(props: unknown) => (
                <TLBar {...(props as TLBarProps)} selectedName={selectedName} />
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function NowLabel(props: unknown) {
  const { viewBox } = props as { viewBox?: { x: number; y: number } };
  if (!viewBox) return null;
  const { x, y } = viewBox;
  return (
    <g>
      <text
        x={x}
        y={y - 3}
        textAnchor="middle"
        fill={C.accent}
        fontSize={9}
        fontFamily={MONO}
        letterSpacing="0.1em"
      >
        NOW
      </text>
    </g>
  );
}

interface TLBarProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload?: Row;
  selectedName?: string | null;
}

function TLBar({ x, y, width, height, payload, selectedName }: TLBarProps) {
  if (width <= 0 || !payload) return null;
  const selected = selectedName != null && payload.ref.name === selectedName;
  // Per-type color coding so the timeline matches the target list at a glance.
  const fill = typeInfo(payload.ref.kind).color;
  const cy = y + height / 2;
  return (
    <g style={{ cursor: "pointer" }}>
      <rect x={x} y={y} width={width} height={height} fill={fill} opacity={selected ? 1 : 0.7} rx={1} />
      {selected && (
        <polygon
          points={`${x},${cy - 4} ${x + 4},${cy} ${x},${cy + 4} ${x - 4},${cy}`}
          fill={C.accent}
        />
      )}
    </g>
  );
}

function TLTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload || !payload.length) return null;
  const t = payload[0].payload.ref;
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 2,
        padding: "8px 11px",
        fontSize: 11,
        fontFamily: MONO,
        color: C.text,
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: C.accent }}>{t.name}</div>
      <div style={{ color: C.textDim, textTransform: "uppercase" }}>{typeInfo(t.kind).label}</div>
      <div style={{ color: C.textData, marginTop: 4 }}>
        {format(new Date(t.window_start as string), "HH:mm")}–
        {format(new Date(t.window_end as string), "HH:mm")} · peak {t.max_alt_deg.toFixed(0)}°
      </div>
    </div>
  );
}

function computeDomain(rows: Row[]) {
  const pts: number[] = [];
  for (const r of rows) pts.push(r.range[0], r.range[1]);
  if (!pts.length) {
    const now = Date.now();
    return { domain: [now, now + 4 * 3600_000] as [number, number], ticks: [] as number[] };
  }
  const start = Math.floor(Math.min(...pts) / 3600_000) * 3600_000;
  const end = Math.ceil(Math.max(...pts) / 3600_000) * 3600_000;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += 3600_000) ticks.push(t);
  return { domain: [start, end] as [number, number], ticks };
}
