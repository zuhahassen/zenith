"""Zenith. 

`plan_session` is the only entry point you usually need: given an observer,
session window, and a catalog, it returns scored targets sorted best-first.
"""

from datetime import datetime, timezone
from typing import Iterable, Optional

from .catalog import CATALOG
from .geometry import geometry_for
from .models import Gear, Observer, Preferences, Scored, Session, Target
from .observer import location_for, session_start, time_grid
from .scoring import passes_filters, sb_limit, score, surface_brightness
from .sky import compute_sky


__all__ = [
    "Observer", "Session", "Target", "Gear", "Preferences", "Scored",
    "CATALOG", "plan_session",
]


def plan_session(
    observer: Observer,
    session: Session,
    catalog: Iterable[Target] = CATALOG,
    gear: Optional[Gear] = None,
    prefs: Optional[Preferences] = None,
    now: Optional[datetime] = None,
) -> list[Scored]:
    gear = gear or Gear()
    prefs = prefs or Preferences()
    now = now or datetime.now(tz=timezone.utc)

    loc = location_for(observer)
    times = time_grid(session_start(observer, session, loc), session)
    sky = compute_sky(times, loc)

    out: list[Scored] = []
    for t in catalog:
        g = geometry_for(t, sky, session.min_alt_deg)
        ok, _ = passes_filters(t, g, gear, sky.moon_illum)
        if not ok:
            continue

        total, comps = score(t, g, sky, session, gear, prefs, now=now)
        sb = surface_brightness(t)
        limit = sb_limit(gear)
        out.append(Scored(
            target=t,
            score=total,
            components=comps,
            window=(g.window_start, g.window_end, g.window_minutes),
            transit_time=g.transit_time,
            max_alt_deg=g.max_alt,
            min_airmass=g.min_airmass,
            moon_sep_deg=g.moon_sep_deg,
            moon_illumination=sky.moon_illum,
            surface_brightness=sb,
            sb_limit=limit,
            why=_summarize(g, sb, limit),
        ))

    out.sort(key=lambda r: r.score, reverse=True)
    return out


def _summarize(g, sb, limit) -> str:
    h, m = divmod(int(g.window_minutes), 60)
    window = f"{h}h {m}min" if h else f"{m}min"
    parts = [f"peaks at {g.max_alt:.0f}°, visible {window}"]
    if g.transit_time:
        parts.append(f"best near {g.transit_time:%H:%M UTC}")
    parts.append(f"moon {g.moon_sep_deg:.0f}° away")
    if sb is not None:
        headroom = limit - sb
        if headroom >= 2.5:
            parts.append("well within aperture")
        elif headroom >= 1.0:
            parts.append("a reasonable fit")
        else:
            parts.append("near aperture limit")
    return "; ".join(parts) + "."
