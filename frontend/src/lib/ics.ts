// iCalendar (.ics) export for the multi-night observability calendar.
// Produces one VEVENT per observable night spanning the target's observing
// window, importable into Google Calendar, Apple Calendar, Outlook, etc.

import type { CalendarResponse } from "../types/zenith";

// RFC 5545 text escaping: backslash, semicolon, comma, and newlines.
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// ISO timestamp -> UTC iCalendar form "YYYYMMDDTHHMMSSZ".
function toICSDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
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
): string | null {
  const { target, nights } = data;
  const observable = nights.filter(
    (n) => n.observable && n.window_start && n.window_end,
  );
  if (observable.length === 0) return null;

  const title = target.common_name
    ? `${target.name} (${target.common_name})`
    : target.name;
  const stamp = toICSDate(new Date().toISOString());

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
      `DTSTART:${toICSDate(n.window_start as string)}`,
      `DTEND:${toICSDate(n.window_end as string)}`,
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
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
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
