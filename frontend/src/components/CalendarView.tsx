import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, Rss } from "lucide-react";
import { useCalendar } from "../hooks/useCalendar";
import { hhmm, tzLabel, typeInfo } from "../lib/format";
import { buildObservingICS, downloadICS, googleCalendarUrl, webcalFeedUrl } from "../lib/ics";
import type { ZenithSettings } from "../lib/settings";
import type { CalendarNight, CalendarResponse } from "../types/zenith";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Quality tiers map a night to its cell appearance. See PART 4 spec.
type Tier = "none" | "poor" | "avg" | "good" | "best";

export interface CalendarDeepLink {
  target: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

interface Props {
  settings: ZenithSettings;
  // When set (deep-link from a target), pre-fill + auto-submit once.
  deepLink?: CalendarDeepLink | null;
  // Plan a specific night for this target+date (navigates to Tonight in App).
  onPlanNight: (targetName: string, dateISO: string) => void;
}

export function CalendarView({ settings, deepLink, onPlanNight }: Props) {
  const [target, setTarget] = useState(deepLink?.target ?? "M 42");
  const [from, setFrom] = useState(deepLink?.start ?? todayISO());
  const [to, setTo] = useState(deepLink?.end ?? plusDaysISO(todayISO(), 90));
  const cal = useCalendar();
  const ranDeepLink = useRef(false);

  const hasLocation = settings.lat != null && settings.lon != null;

  function run(t = target, f = from, e = to) {
    if (!hasLocation || !t.trim()) return;
    cal.mutate({
      lat: settings.lat as number,
      lon: settings.lon as number,
      target_name: t.trim(),
      start_date: f,
      end_date: clampRange(f, e),
      aperture_mm: settings.aperture_mm,
    });
  }

  // Auto-submit once when arriving via a deep link.
  useEffect(() => {
    if (deepLink && !ranDeepLink.current && hasLocation) {
      ranDeepLink.current = true;
      setTarget(deepLink.target);
      setFrom(deepLink.start);
      setTo(deepLink.end);
      run(deepLink.target, deepLink.start, deepLink.end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink]);

  return (
    <div className="cal">
      <div className="cal__controls">
        <div className="cal__row">
          <span className="cal__label">Target</span>
          <input
            type="text"
            className="cal__target"
            value={target}
            placeholder="M 42, NGC 891…"
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        </div>
        <div className="cal__row">
          <span className="cal__label">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="cal__label">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="primary" disabled={!hasLocation || cal.isPending} onClick={() => run()}>
            {cal.isPending ? "Computing…" : "Show calendar"}
          </button>
        </div>
        {!hasLocation && (
          <div className="cal__hint">Set a location first — run a plan from the Tonight tab.</div>
        )}
        {cal.isError && <div className="err">{cal.error.message}</div>}
      </div>

      {cal.isPending && <SkeletonCalendar />}

      {cal.data && !cal.isPending && (
        <CalendarResult data={cal.data} settings={settings} onPlanNight={onPlanNight} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CalendarResult({
  data,
  settings,
  onPlanNight,
}: {
  data: CalendarResponse;
  settings: ZenithSettings;
  onPlanNight: (targetName: string, dateISO: string) => void;
}) {
  const { target, nights } = data;
  const info = typeInfo(target.type);
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarNight>();
    for (const n of nights) m.set(n.date, n);
    return m;
  }, [nights]);

  const months = useMemo(() => groupMonths(nights), [nights]);
  const bestMonths = useMemo(() => topMonths(nights), [nights]);
  const siteLabel = settings.locationLabel || "this site";
  const feedSite = settings.locationLabel || "Observing site";

  const [pinned, setPinned] = useState<string | null>(null);

  const title = target.common_name ? `${target.name} (${target.common_name})` : target.name;

  const observableCount = useMemo(
    () => nights.filter((n) => n.observable && n.window_start && n.window_end).length,
    [nights],
  );

  function exportICS() {
    const ics = buildObservingICS(data, feedSite, settings.timezone);
    if (!ics) return;
    const slug = target.name.replace(/\s+/g, "-").toLowerCase();
    downloadICS(`zenith-${slug}.ics`, ics);
  }

  function subscribe() {
    if (settings.lat == null || settings.lon == null || nights.length === 0) return;
    const url = webcalFeedUrl(API_BASE, {
      lat: settings.lat,
      lon: settings.lon,
      target: target.name,
      start: nights[0].date,
      end: nights[nights.length - 1].date,
      aperture_mm: settings.aperture_mm,
      site: feedSite,
    });
    window.location.href = url;
  }

  return (
    <>
      <div className="cal__target-card">
        <div className="cal__target-head">
          <div className="cal__target-name">
            {target.name}
            {target.common_name ? ` · ${target.common_name}` : ""}
            <span className="cal__target-type" style={{ color: info.color }}>
              {info.code}
            </span>
            {target.magnitude != null && <span className="cal__target-mag">Mag {target.magnitude.toFixed(1)}</span>}
          </div>
          <div className="cal__export-row">
            <button
              className="cal__export"
              onClick={subscribe}
              disabled={observableCount === 0 || settings.lat == null}
              title="Subscribe to a live-updating calendar feed (webcal). Opens in your calendar app."
            >
              <Rss size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Subscribe
            </button>
            <button
              className="cal__export"
              onClick={exportICS}
              disabled={observableCount === 0}
              title={
                observableCount === 0
                  ? "No observable nights to export"
                  : `Export ${observableCount} observable night${observableCount === 1 ? "" : "s"} to your calendar (.ics)`
              }
            >
              <CalendarPlus size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Export .ics
            </button>
          </div>
        </div>
        {bestMonths.length > 0 && (
          <div className="cal__best">
            Best months for {target.name} from {siteLabel}:{" "}
            <strong>{bestMonths.join(" · ")}</strong>
          </div>
        )}
      </div>

      <div className="cal__months" onClick={() => setPinned(null)}>
        {months.map((mo) => (
          <MonthGrid
            key={`${mo.year}-${mo.month}`}
            year={mo.year}
            month={mo.month}
            byDate={byDate}
            pinned={pinned}
            onPin={setPinned}
            targetName={target.name}
            title={title}
            siteLabel={feedSite}
            onPlanNight={onPlanNight}
          />
        ))}
      </div>
    </>
  );
}

function MonthGrid({
  year,
  month,
  byDate,
  pinned,
  onPin,
  targetName,
  title,
  siteLabel,
  onPlanNight,
}: {
  year: number;
  month: number; // 0-indexed
  byDate: Map<string, CalendarNight>;
  pinned: string | null;
  onPin: (d: string | null) => void;
  targetName: string;
  title: string;
  siteLabel: string;
  onPlanNight: (targetName: string, dateISO: string) => void;
}) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // Monday-first offset for the 1st of the month.
  const firstDow = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="cal-month">
      <div className="cal-month__hdr">
        {MONTHS[month]} {year}
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w) => (
          <div className="cal-grid__wd" key={w}>
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <div className="cal-cell cal-cell--empty" key={`e${i}`} />;
          const iso = isoOf(year, month, day);
          const night = byDate.get(iso);
          return (
            <DayCell
              key={iso}
              iso={iso}
              day={day}
              night={night}
              pinned={pinned === iso}
              onPin={onPin}
              targetName={targetName}
              title={title}
              siteLabel={siteLabel}
              onPlanNight={onPlanNight}
            />
          );
        })}
      </div>
    </div>
  );
}

function DayCell({
  iso,
  day,
  night,
  pinned,
  onPin,
  targetName,
  title,
  siteLabel,
  onPlanNight,
}: {
  iso: string;
  day: number;
  night?: CalendarNight;
  pinned: boolean;
  onPin: (d: string | null) => void;
  targetName: string;
  title: string;
  siteLabel: string;
  onPlanNight: (targetName: string, dateISO: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const t = night ? tierOf(night) : "outside";
  const show = pinned || hover;

  return (
    <div
      className={`cal-cell cal-cell--${t}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (night) onPin(pinned ? null : iso);
      }}
    >
      <span className="cal-cell__day">{day}</span>
      {t === "best" && <span className="cal-cell__star">✦</span>}
      {night && show && (
        <CellPopover
          iso={iso}
          night={night}
          pinned={pinned}
          targetName={targetName}
          title={title}
          siteLabel={siteLabel}
          onPlanNight={onPlanNight}
        />
      )}
    </div>
  );
}

function CellPopover({
  iso,
  night,
  pinned,
  targetName,
  title,
  siteLabel,
  onPlanNight,
}: {
  iso: string;
  night: CalendarNight;
  pinned: boolean;
  targetName: string;
  title: string;
  siteLabel: string;
  onPlanNight: (targetName: string, dateISO: string) => void;
}) {
  const label = dateLabel(iso);
  const isPast = iso < todayISO();
  const gcalUrl = night.observable ? googleCalendarUrl(night, title, siteLabel) : null;
  return (
    <div className="cal-pop" onClick={(e) => e.stopPropagation()}>
      <div className="cal-pop__hdr">
        {label} · {night.observable ? "Observable" : "Not observable"}
      </div>
      {night.observable && night.window_start && (
        <>
          <div className="cal-pop__line">
            Window: {hhmm(night.window_start)} – {hhmm(night.window_end)} {tzLabel()}
            {night.window_hours != null ? ` (${hoursLabel(night.window_hours)})` : ""}
          </div>
          <div className="cal-pop__line">
            Peak: {night.peak_alt_deg?.toFixed(0)}° at {hhmm(night.peak_time)} {tzLabel()}
          </div>
        </>
      )}
      <div className="cal-pop__line">
        Moon: {Math.round(night.moon_illumination * 100)}%
        {night.moon_separation_deg != null ? ` · Sep ${night.moon_separation_deg.toFixed(0)}°` : ""}
      </div>
      {night.predicted_seeing != null && (
        <div className="cal-pop__line">Seeing: {night.predicted_seeing.toFixed(1)}″ (forecast)</div>
      )}
      {night.quality_score != null && (
        <div className="cal-pop__line">Score: {night.quality_score.toFixed(2)}</div>
      )}
      {pinned && (
        <div className="cal-pop__action">
          {isPast ? (
            <span className="cal-pop__past">Past session</span>
          ) : (
            <>
              <button className="cal-pop__plan" onClick={() => onPlanNight(targetName, iso)}>
                Plan this night
              </button>
              {gcalUrl && (
                <a
                  className="cal-pop__gcal"
                  href={gcalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Add to Google Calendar
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SkeletonCalendar() {
  return (
    <div className="cal__months">
      <div className="cal-month">
        <div className="cal-month__hdr cal-skel-hdr" />
        <div className="cal-grid">
          {WEEKDAYS.map((w) => (
            <div className="cal-grid__wd" key={w}>
              {w}
            </div>
          ))}
          {Array.from({ length: 35 }, (_, i) => (
            <div className="cal-cell cal-cell--skel shimmer" key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierOf(n: CalendarNight): Tier {
  if (!n.observable) return "none";
  const poor = n.moon_illumination > 0.8 || (n.predicted_seeing != null && n.predicted_seeing > 2.5);
  if (poor) return "poor";
  const q = n.quality_score ?? 0;
  if (q > 0.8) return "best";
  if (q >= 0.6) return "good";
  return "avg";
}

interface MonthBlock {
  year: number;
  month: number;
}

function groupMonths(nights: CalendarNight[]): MonthBlock[] {
  const seen = new Set<string>();
  const out: MonthBlock[] = [];
  for (const n of nights) {
    const [y, m] = n.date.split("-").map(Number);
    const key = `${y}-${m}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ year: y, month: m - 1 });
    }
  }
  return out;
}

// The 3 months with the highest average quality among observable nights.
function topMonths(nights: CalendarNight[]): string[] {
  const acc = new Map<number, { sum: number; count: number }>();
  for (const n of nights) {
    if (!n.observable || n.quality_score == null) continue;
    const m = Number(n.date.split("-")[1]) - 1;
    const cur = acc.get(m) ?? { sum: 0, count: 0 };
    cur.sum += n.quality_score;
    cur.count += 1;
    acc.set(m, cur);
  }
  return [...acc.entries()]
    .map(([m, v]) => ({ m, avg: v.sum / v.count }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3)
    .map((x) => MONTHS[x.m]);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Clamp the range to the backend's 90-night maximum.
function clampRange(from: string, to: string): string {
  const max = plusDaysISO(from, 89);
  return to > max ? max : to;
}

function isoOf(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function hoursLabel(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
