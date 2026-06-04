// iCalendar (.ics) export for the multi-night observability calendar.
// Produces one VEVENT per observable night spanning the target's observing
// window, importable into Google Calendar, Apple Calendar, Outlook, etc.

import type { CalendarNight, CalendarResponse } from "../types/zenith";

export type ICSZone = "utc" | "local";

// RFC 5545 text escaping: backslash, semicolon, comma, and newlines.
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

// ISO timestamp -> iCalendar datetime. In "utc" mode this is the absolute
// "YYYYMMDDTHHMMSSZ" form; in "local" mode it's a floating local wall-clock
// time (no Z), which calendar clients interpret in the viewer's own zone.
function toICSDate(iso: string, zone: ICSZone): string {
  const d = new Date(iso);
  if (zone === "local") {
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// Fold lines longer than 75 octets per RFC 5545 (continuation = CRLF + space).
function foldLine(line: string): string {
  if (line.length <= 73) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) {
    chunks.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest.length) chunks.push(" " + rest);
  return chunks.join("\r\n");
}

/**
 * Build an .ics document for every observable night in a calendar response.
 * Returns null when there are no observable nights with a defined window.
 */
export function buildObservingICS(
  data: CalendarResponse,
  siteLabel: string,
  zone: ICSZone = "utc",
): string | null {
  const { target, nights } = data;
  const observable = nights.filter(
    (n) => n.observable && n.window_start && n.window_end,
  );
  if (observable.length === 0) return null;

  const title = target.common_name
    ? `${target.name} (${target.common_name})`
    : target.name;
  const stamp = toICSDate(new Date().toISOString(), "utc");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zenith//Observation Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`Zenith — ${title}`)}`,
  ];

  for (const n of observable) {
    const descParts: string[] = [];
    if (n.peak_alt_deg != null) {
      descParts.push(
        `Peak altitude ${n.peak_alt_deg.toFixed(0)}°` +
          (n.peak_time ? ` at ${toClock(n.peak_time)} UTC` : ""),
      );
    }
    if (n.predicted_seeing != null) descParts.push(`Seeing ~${n.predicted_seeing.toFixed(1)}″`);
    descParts.push(`Moon ${Math.round(n.moon_illumination * 100)}% illuminated`);
    if (n.moon_separation_deg != null) descParts.push(`Moon separation ${n.moon_separation_deg.toFixed(0)}°`);
    if (n.quality_score != null) descParts.push(`Quality score ${n.quality_score.toFixed(2)}`);
    descParts.push("Planned with Zenith.");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(`${target.name}-${n.date}`)}@zenith`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toICSDate(n.window_start as string, zone)}`,
      `DTEND:${toICSDate(n.window_end as string, zone)}`,
      `SUMMARY:${escapeText(`Observe ${title}`)}`,
      `DESCRIPTION:${escapeText(descParts.join("\n"))}`,
      `LOCATION:${escapeText(siteLabel)}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n");
}

function toClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Build a one-click "Add to Google Calendar" template URL for a single night.
 * Google reads the absolute UTC times (…Z) and renders them in the user's zone.
 */
export function googleCalendarUrl(
  night: CalendarNight,
  title: string,
  siteLabel: string,
): string | null {
  if (!night.window_start || !night.window_end) return null;
  const dates = `${toICSDate(night.window_start, "utc")}/${toICSDate(night.window_end, "utc")}`;
  const details: string[] = [];
  if (night.peak_alt_deg != null) {
    details.push(
      `Peak altitude ${night.peak_alt_deg.toFixed(0)}°` +
        (night.peak_time ? ` at ${toClock(night.peak_time)} UTC` : ""),
    );
  }
  if (night.predicted_seeing != null) details.push(`Seeing ~${night.predicted_seeing.toFixed(1)}″`);
  details.push(`Moon ${Math.round(night.moon_illumination * 100)}% illuminated`);
  if (night.quality_score != null) details.push(`Quality score ${night.quality_score.toFixed(2)}`);
  details.push("Planned with Zenith.");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Observe ${title}`,
    dates,
    details: details.join("\n"),
    location: siteLabel,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Build a subscribable webcal:// URL pointing at the backend .ics feed. Calendar
 * apps poll this for a live-updating calendar. `apiBase` is the absolute API
 * origin (e.g. the Worker URL); falls back to the current page origin.
 */
export function webcalFeedUrl(
  apiBase: string,
  params: {
    lat: number;
    lon: number;
    target: string;
    start: string;
    end: string;
    aperture_mm: number;
    site: string;
  },
): string {
  const base = (apiBase || window.location.origin).replace(/^https?:\/\//, "");
  const qs = new URLSearchParams({
    lat: String(params.lat),
    lon: String(params.lon),
    target: params.target,
    start: params.start,
    end: params.end,
    aperture_mm: String(params.aperture_mm),
    site: params.site,
  });
  return `webcal://${base}/api/calendar.ics?${qs.toString()}`;
}

// Trigger a browser download of an .ics file.
export function downloadICS(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".ics") ? filename : `${filename}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
