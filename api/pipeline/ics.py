"""iCalendar (.ics) serialization for the multi-night observability calendar.

Produces an RFC 5545 VCALENDAR with one VEVENT per observable night, spanning
the target's observing window (UTC). Used by the ``GET /api/calendar.ics`` feed
so observers can *subscribe* to a target's season from Google/Apple/Outlook.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional


def _escape(text: str) -> str:
    """RFC 5545 TEXT escaping: backslash, semicolon, comma, newlines."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _to_ics_utc(iso: str) -> Optional[str]:
    """ISO timestamp -> 'YYYYMMDDTHHMMSSZ' in UTC, or None if unparseable."""
    try:
        dt = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _fold(line: str) -> str:
    """Fold lines >75 octets per RFC 5545 (continuation = CRLF + space)."""
    if len(line) <= 73:
        return line
    chunks = [line[:73]]
    rest = line[73:]
    while len(rest) > 72:
        chunks.append(" " + rest[:72])
        rest = rest[72:]
    if rest:
        chunks.append(" " + rest)
    return "\r\n".join(chunks)


def _clock(iso: str) -> Optional[str]:
    try:
        dt = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%H:%M")


def build_ics(target: dict, nights: list[dict], site_label: str) -> str:
    """Serialize observable nights to an .ics document (always non-empty)."""
    name = target.get("name") or "Target"
    common = target.get("common_name")
    title = f"{name} ({common})" if common else name
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Zenith//Observation Planner//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape(f'Zenith - {title}')}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
        "X-PUBLISHED-TTL:PT12H",
    ]

    for n in nights:
        if not n.get("observable"):
            continue
        start = n.get("window_start")
        end = n.get("window_end")
        dtstart = _to_ics_utc(start) if start else None
        dtend = _to_ics_utc(end) if end else None
        if not dtstart or not dtend:
            continue

        desc: list[str] = []
        if n.get("peak_alt_deg") is not None:
            peak = f"Peak altitude {round(n['peak_alt_deg'])}\u00b0"
            if n.get("peak_time"):
                clk = _clock(n["peak_time"])
                if clk:
                    peak += f" at {clk} UTC"
            desc.append(peak)
        if n.get("predicted_seeing") is not None:
            desc.append(f"Seeing ~{n['predicted_seeing']:.1f}\u2033")
        if n.get("moon_illumination") is not None:
            desc.append(f"Moon {round(n['moon_illumination'] * 100)}% illuminated")
        if n.get("moon_separation_deg") is not None:
            desc.append(f"Moon separation {round(n['moon_separation_deg'])}\u00b0")
        if n.get("quality_score") is not None:
            desc.append(f"Quality score {n['quality_score']:.2f}")
        desc.append("Planned with Zenith.")

        uid = _escape(f"{name}-{n.get('date')}") + "@zenith"
        summary = _escape(f"Observe {title}")
        description = _escape("\n".join(desc))
        location = _escape(site_label)

        lines += [
            "BEGIN:VEVENT",
            f"UID:{uid}",
            f"DTSTAMP:{stamp}",
            f"DTSTART:{dtstart}",
            f"DTEND:{dtend}",
            f"SUMMARY:{summary}",
            f"DESCRIPTION:{description}",
            f"LOCATION:{location}",
            "END:VEVENT",
        ]

    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"
