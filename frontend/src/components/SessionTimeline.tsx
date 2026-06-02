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
import type { ScoredTarget, SeeingSlot } from "../types/zenith";

const KIND_COLORS: Record<string, string> = {
  Galaxy: "#e8a045",
  Nebula: "#c4bfb8",
  GlCl: "#f0ede8",
  OpenCl: "#888680",
};

function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? "#3a3a3a";
}

interface Props {
  targets: ScoredTarget[];
  seeingForecast: SeeingSlot[];
  onSelectTarget: (t: ScoredTarget) => void;
  moonIllumination?: number | null;
  bortleClass?: number;
}

// Internal recharts row shape. One row per target, plus an extra "axis row"
// at the top for the seeing line so recharts knows the time domain.
interface Row {
  name: string;
  kind: string;
  range?: [number, number]; // [startMs, endMs] — recharts renders this as a horizontal bar
  // Seeing line uses a separate dataset to avoid stretching the category axis.
  ref?: ScoredTarget;
}

export function SessionTimeline({
  targets,
  seeingForecast,
  onSelectTarget,
  moonIllumination,
  bortleClass,
}: Props) {
  // Chronological order: read the timeline left-to-right by start time, not
  // by score.
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

  // "Now" indicator, refreshed each minute.
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

  // Compute shared time domain so both charts align edge-to-edge.
  const { domain, ticks } = useMemo(() => computeDomain(rows, seeingData), [rows, seeingData]);

  if (!visible.length) {
    return (
      <div className="muted" style={{ padding: 32 }}>
        Nothing visible during the requested window.
      </div>
    );
  }

  const nowInDomain = now >= domain[0] && now <= domain[1];

  return (
    <div className="timeline">
      <div className="timeline__heading">
        <h2>Session timeline</h2>
        <div className="muted mono" style={{ fontSize: 11 }}>
          {format(domain[0], "HH:mm")} → {format(domain[1], "HH:mm")} UTC
        </div>
      </div>

      {/* Summary bar — one monospace row of session-level stats. */}
      <div
        className="mono"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          fontSize: 11,
          color: "#888680",
          padding: "0 32px 12px 80px",
        }}
      >
        <span>{visible.length} targets</span>
        {seeingRange && (
          <span>
            seeing {seeingRange.min.toFixed(1)}–{seeingRange.max.toFixed(1)}″
          </span>
        )}
        {moonIllumination != null && (
          <span>moon {(moonIllumination * 100).toFixed(0)}%</span>
        )}
        {bortleClass != null && <span>Bortle {bortleClass}</span>}
      </div>

      <div className="timeline__chart" style={{ height: 32 + visible.length * 26 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            layout="vertical"
            margin={{ top: 24, right: 32, bottom: 8, left: 80 }}
          >
            <CartesianGrid stroke="#1a1a1a" horizontal={false} />
            {nowInDomain && (
              <ReferenceLine
                x={now}
                stroke="#e8a045"
                strokeWidth={1.25}
                ifOverflow="extendDomain"
                label={{
                  value: "now",
                  position: "top",
                  fill: "#e8a045",
                  fontSize: 10,
                  fontFamily: "ui-monospace",
                }}
              />
            )}
            <XAxis
              type="number"
              domain={domain}
              ticks={ticks}
              tickFormatter={(v) => format(v as number, "HH:mm")}
              stroke="#2a2a2a"
              tick={{ fill: "#888680", fontSize: 11, fontFamily: "ui-monospace" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke="#2a2a2a"
              tick={{ fill: "#888680", fontSize: 11, fontFamily: "ui-monospace" }}
              width={72}
            />
            <Tooltip
              cursor={{ fill: "rgba(232,160,69,0.05)" }}
              content={<TimelineTooltip />}
            />
            <Bar
              dataKey="range"
              barSize={14}
              isAnimationActive={false}
              onClick={(d: unknown) => {
                const ref = (d as { payload?: Row }).payload?.ref;
                if (ref) onSelectTarget(ref);
              }}
              shape={(props: unknown) => <KindBar {...(props as KindBarProps)} />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Seeing overlay as a separate sparkline-style chart sharing the X domain. */}
      <div
        className="timeline__chart"
        style={{ height: 64, marginTop: 8, borderTop: "none" }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={seeingData} margin={{ top: 12, right: 32, bottom: 8, left: 80 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={domain}
              ticks={ticks}
              tickFormatter={(v) => format(v as number, "HH:mm")}
              stroke="#2a2a2a"
              tick={{ fill: "#888680", fontSize: 10, fontFamily: "ui-monospace" }}
            />
            <YAxis
              hide
              domain={[0.5, 4]}
              reversed
            />
            <Line
              type="monotone"
              dataKey="seeing"
              stroke="#e8a045"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="muted mono" style={{ fontSize: 11, padding: "0 32px 8px 80px" }}>
          Seeing (arcsec) — lower is better
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom bar shape: paints the bar in the kind's color.
// ---------------------------------------------------------------------------

interface KindBarProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload?: Row;
}

function KindBar({ x, y, width, height, payload }: KindBarProps) {
  if (width <= 0 || !payload) return null;
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={colorForKind(payload.kind)}
      style={{ cursor: "pointer" }}
    />
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
        background: "#111",
        border: "1px solid #2a2a2a",
        padding: "10px 14px",
        fontSize: 12,
        color: "#f0ede8",
        fontFamily: "ui-monospace",
        lineHeight: 1.6,
        minWidth: 200,
      }}
    >
      <div style={{ color: "#e8a045", letterSpacing: "0.04em" }}>{t.name}</div>
      <div style={{ color: "#888680", fontSize: 11, textTransform: "uppercase" }}>
        {t.kind}
        {t.common_name ? ` — ${t.common_name}` : ""}
      </div>
      <div style={{ marginTop: 6 }}>
        peak {t.max_alt_deg.toFixed(0)}° · airmass {t.min_airmass.toFixed(2)}
      </div>
      <div style={{ color: "#888680" }}>moon {t.moon_sep_deg.toFixed(0)}° away</div>
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

  // Round to whole hours.
  const start = Math.floor(min / 3600_000) * 3600_000;
  const end = Math.ceil(max / 3600_000) * 3600_000;

  const ticks: number[] = [];
  for (let t = start; t <= end; t += 3600_000) ticks.push(t);

  return { domain: [start, end] as [number, number], ticks };
}
