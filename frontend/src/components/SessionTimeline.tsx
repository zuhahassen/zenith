import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format } from "date-fns";
import { Telescope } from "lucide-react";
import type { ScoredTarget, SeeingSlot } from "../types/zenith";

// Palette mirrors the CSS custom properties in index.css. SVG presentation
// attributes don't resolve var(), so we keep literal hex here in sync.
const C = {
  accent: "#4a9eff",
  galaxy: "#4a9eff",
  nebula: "#36c9c6",
  globular: "#e8edf5",
  open: "#6b8fa8",
  other: "#2a3a4a",
  seeingGood: "#36c9c6",
  seeingAvg: "#4a9eff",
  seeingPoor: "#4a5568",
  border: "#1a2535",
  borderBright: "#2a3f5a",
  textSecondary: "#7a8899",
  textTertiary: "#4a5568",
  textMono: "#a8c0d6",
  textPrimary: "#e8edf5",
  surface: "#111820",
};

const KIND_COLORS: Record<string, string> = {
  Galaxy: C.galaxy,
  Nebula: C.nebula,
  GlCl: C.globular,
  OpenCl: C.open,
};

function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? C.other;
}

function seeingColor(value: number): string {
  if (value < 1.5) return C.seeingGood;
  if (value <= 2.5) return C.seeingAvg;
  return C.seeingPoor;
}

interface Props {
  targets: ScoredTarget[];
  seeingForecast: SeeingSlot[];
  onSelectTarget: (t: ScoredTarget) => void;
  moonIllumination?: number | null;
  bortleClass?: number;
  selectedName?: string | null;
}

interface Row {
  name: string;
  kind: string;
  range?: [number, number];
  ref?: ScoredTarget;
}

export function SessionTimeline({
  targets,
  seeingForecast,
  onSelectTarget,
  moonIllumination,
  bortleClass,
  selectedName,
}: Props) {
  const visible = useMemo(
    () =>
      targets
        .filter((t) => t.window_start && t.window_end)
        .slice()
        .sort(
          (a, b) =>
            new Date(a.window_start as string).getTime() -
            new Date(b.window_start as string).getTime(),
        )
        .slice(0, 18),
    [targets],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const seeingRange = useMemo(() => {
    const vals = seeingForecast.map((s) => s.predicted_seeing_arcsec).filter((v) => v > 0);
    if (!vals.length) return null;
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [seeingForecast]);

  const meanSeeing = useMemo(() => {
    const vals = seeingForecast.map((s) => s.predicted_seeing_arcsec).filter((v) => v > 0);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [seeingForecast]);

  const rows: Row[] = useMemo(
    () =>
      visible.map((t) => ({
        name: t.name,
        kind: t.kind,
        range: [
          new Date(t.window_start as string).getTime(),
          new Date(t.window_end as string).getTime(),
        ],
        ref: t,
      })),
    [visible],
  );

  const seeingData = useMemo(
    () =>
      seeingForecast.map((s) => ({
        ts: new Date(s.slot).getTime(),
        seeing: s.predicted_seeing_arcsec,
      })),
    [seeingForecast],
  );

  const { domain, ticks } = useMemo(() => computeDomain(rows, seeingData), [rows, seeingData]);

  if (!visible.length) {
    return (
      <div className="timeline">
        <div className="timeline__empty">
          <Telescope size={32} strokeWidth={1.25} />
          <div>No targets visible tonight for this location and aperture.</div>
        </div>
      </div>
    );
  }

  const nowInDomain = now >= domain[0] && now <= domain[1];
  const lineColor = meanSeeing != null ? seeingColor(meanSeeing) : C.accent;

  return (
    <div className="timeline">
      <div className="timeline__heading">
        <h2>Session timeline</h2>
        <div className="mono" style={{ fontSize: 11, color: C.textTertiary }}>
          {format(domain[0], "HH:mm")} → {format(domain[1], "HH:mm")} UTC
        </div>
      </div>

      {/* Session summary bar — divider-separated stats. */}
      <div className="session-summary">
        <span className="session-summary__stat">{visible.length} targets</span>
        {seeingRange && meanSeeing != null && (
          <span className="session-summary__stat">
            <span
              className="session-summary__dot"
              style={{ background: seeingColor(meanSeeing) }}
            />
            seeing {seeingRange.min.toFixed(1)}–{seeingRange.max.toFixed(1)}″
          </span>
        )}
        {moonIllumination != null && (
          <span className="session-summary__stat">
            moon {(moonIllumination * 100).toFixed(0)}%
          </span>
        )}
        {bortleClass != null && (
          <span className="session-summary__stat">Bortle {bortleClass}</span>
        )}
      </div>

      <div className="timeline__chart" style={{ height: 32 + visible.length * 26 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            layout="vertical"
            margin={{ top: 24, right: 32, bottom: 8, left: 80 }}
          >
            <CartesianGrid stroke={C.border} horizontal={false} />
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
              tick={{ fill: C.textTertiary, fontSize: 11, fontFamily: "ui-monospace" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke={C.border}
              tick={{ fill: C.textSecondary, fontSize: 11, fontFamily: "ui-monospace" }}
              width={72}
            />
            <Tooltip cursor={{ fill: "rgba(74,158,255,0.06)" }} content={<TimelineTooltip />} />
            <Bar
              dataKey="range"
              barSize={14}
              isAnimationActive={false}
              onClick={(d: unknown) => {
                const ref = (d as { payload?: Row }).payload?.ref;
                if (ref) onSelectTarget(ref);
              }}
              shape={(props: unknown) => (
                <KindBar {...(props as KindBarProps)} selectedName={selectedName} />
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Seeing overlay — dashed, quality-coloured sparkline sharing the X domain. */}
      <div className="timeline__chart" style={{ height: 64, marginTop: 8, borderTop: "none" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={seeingData} margin={{ top: 12, right: 32, bottom: 8, left: 80 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={domain}
              ticks={ticks}
              tickFormatter={(v) => format(v as number, "HH:mm")}
              stroke={C.border}
              tick={{ fill: C.textTertiary, fontSize: 10, fontFamily: "ui-monospace" }}
            />
            <YAxis hide domain={[0.5, 4]} reversed />
            <Line
              type="monotone"
              dataKey="seeing"
              stroke={lineColor}
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div
          className="mono"
          style={{ fontSize: 11, color: C.textTertiary, padding: "0 32px 8px 80px" }}
        >
          Seeing (arcsec) — lower is better
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "NOW" indicator label: small upward triangle + mono caption.
// ---------------------------------------------------------------------------

function NowLabel(props: unknown) {
  const { viewBox } = props as { viewBox?: { x: number; y: number } };
  if (!viewBox) return null;
  const { x, y } = viewBox;
  return (
    <g>
      <path d={`M ${x} ${y - 2} l -4 6 l 8 0 z`} fill={C.accent} />
      <text
        x={x}
        y={y - 5}
        textAnchor="middle"
        fill={C.accent}
        fontSize={9}
        fontFamily="ui-monospace"
        letterSpacing="0.1em"
      >
        NOW
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Custom bar shape: paints the bar in the kind's colour; selected gets an
// accent left border and brighter fill.
// ---------------------------------------------------------------------------

interface KindBarProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload?: Row;
  selectedName?: string | null;
}

function KindBar({ x, y, width, height, payload, selectedName }: KindBarProps) {
  if (width <= 0 || !payload) return null;
  const selected = selectedName != null && payload.name === selectedName;
  const fill = colorForKind(payload.kind);
  return (
    <g style={{ cursor: "pointer" }}>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        opacity={selected ? 1 : 0.82}
        rx={1}
      />
      {selected && <rect x={x} y={y} width={2} height={height} fill={C.accent} />}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipPayload {
  payload: Row;
}

function TimelineTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const t = row.ref;
  if (!t) return null;
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.borderBright}`,
        borderRadius: 3,
        padding: "10px 14px",
        fontSize: 12,
        color: C.textPrimary,
        fontFamily: "ui-monospace",
        lineHeight: 1.6,
        minWidth: 200,
      }}
    >
      <div style={{ color: C.accent, letterSpacing: "0.04em" }}>{t.name}</div>
      <div style={{ color: C.textSecondary, fontSize: 11, textTransform: "uppercase" }}>
        {t.kind}
        {t.common_name ? ` — ${t.common_name}` : ""}
      </div>
      <div style={{ marginTop: 6, color: C.textMono }}>
        peak {t.max_alt_deg.toFixed(0)}° · airmass {t.min_airmass.toFixed(2)}
      </div>
      <div style={{ color: C.textSecondary }}>moon {t.moon_sep_deg.toFixed(0)}° away</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domain / tick helpers
// ---------------------------------------------------------------------------

function computeDomain(rows: Row[], seeing: { ts: number }[]) {
  const points: number[] = [];
  for (const r of rows) {
    if (r.range) {
      points.push(r.range[0], r.range[1]);
    }
  }
  for (const s of seeing) points.push(s.ts);

  if (points.length === 0) {
    const now = Date.now();
    return { domain: [now, now + 4 * 3600_000] as [number, number], ticks: [] as number[] };
  }

  const min = Math.min(...points);
  const max = Math.max(...points);

  const start = Math.floor(min / 3600_000) * 3600_000;
  const end = Math.ceil(max / 3600_000) * 3600_000;

  const ticks: number[] = [];
  for (let t = start; t <= end; t += 3600_000) ticks.push(t);

  return { domain: [start, end] as [number, number], ticks };
}
