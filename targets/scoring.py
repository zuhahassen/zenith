"""Filters + 5-component scorer + surface brightness math.

Filters run first as boolean gates; whatever survives gets scored.
Scores live in [0, 1] and combine with fixed weights.
"""

import math
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .geometry import Geometry
from .models import Gear, Preferences, Session, Target
from .sky import Sky


WEIGHTS = {"s1": 0.30, "s2": 0.25, "s3": 0.20, "s4": 0.15, "s5": 0.10}


# ---------- surface brightness ----------

def surface_brightness(t: Target) -> Optional[float]:
    """SB in mag/arcmin² for extended objects; magnitude for point sources."""
    if t.magnitude is None:
        return None
    if not t.size_arcmin:
        return float(t.magnitude)
    a, b = t.size_arcmin
    if a <= 0 or b <= 0:
        return float(t.magnitude)
    return float(t.magnitude + 2.5 * math.log10(math.pi * a * b / 4.0))


def sb_limit(gear: Gear) -> float:
    d = gear.aperture_mm
    if d < 70:   return 13.5
    if d < 150:  return 14.5
    if d < 250:  return 15.5
    return 16.5


def mag_limit(gear: Gear) -> float:
    return 6.5 if gear.aperture_mm <= 0 else 2.0 + 5.0 * math.log10(gear.aperture_mm)


# ---------- filters ----------

def passes_filters(t: Target, g: Geometry, gear: Gear, moon_illum: float,
                   min_window_min: float = 30.0) -> tuple[bool, str]:
    if g.max_alt < 1.0:
        return False, "below horizon"
    if g.window_minutes < min_window_min:
        return False, f"window too short ({g.window_minutes:.0f} min)"

    moon_thresh = 15.0 + 30.0 * max(0.0, min(1.0, moon_illum))  # 15° new -> 45° full
    if g.moon_sep_deg < moon_thresh:
        return False, f"moon {g.moon_sep_deg:.0f}° away (needs ≥{moon_thresh:.0f}°)"

    sb = surface_brightness(t)
    if sb is not None:
        if t.size_arcmin and t.size_arcmin[0] > 0:
            if sb > sb_limit(gear) + 0.5:
                return False, f"too dim for aperture (SB {sb:.1f})"
        elif t.magnitude is not None and t.magnitude > mag_limit(gear):
            return False, f"mag {t.magnitude:.1f} beyond aperture limit"
    return True, ""


# ---------- scoring ----------

def score(t: Target, g: Geometry, sky: Sky, session: Session, gear: Gear,
          prefs: Preferences, now: Optional[datetime] = None
          ) -> tuple[float, dict[str, float]]:
    s1 = _visibility(g, session)
    s2 = _altitude(g, sky)
    s3 = _moon(g, sky)
    s4 = _gear(t, gear)
    s5 = _novelty(t, prefs, now)
    total = sum(WEIGHTS[k] * v for k, v in zip("s1 s2 s3 s4 s5".split(), (s1, s2, s3, s4, s5)))
    return total, {"s1": s1, "s2": s2, "s3": s3, "s4": s4, "s5": s5}


def _visibility(g: Geometry, session: Session) -> float:
    total = session.duration_hours * 60.0
    return min(g.window_minutes / total, 1.0) if total > 0 else 0.0


def _altitude(g: Geometry, sky: Sky) -> float:
    mask = g.in_window
    if not np.any(mask):
        return 0.0
    sin_alt = np.sin(np.deg2rad(np.clip(g.alt[mask], 0, 90)))
    w = sky.darkness[mask]
    return float(np.sum(sin_alt * w) / np.sum(w)) if w.sum() > 0 else float(sin_alt.mean())


def _moon(g: Geometry, sky: Sky) -> float:
    sep = min(max(g.moon_sep_deg / 180.0, 0.0), 1.0)
    moon_alt = float(np.max(sky.moon_alt[g.in_window])) if np.any(g.in_window) \
        else float(np.max(sky.moon_alt))
    sin_moon = max(0.0, math.sin(math.radians(max(0.0, moon_alt))))
    dark = max(0.0, min(1.0, 1.0 - sky.moon_illum * sin_moon))
    return 0.6 * sep + 0.4 * dark


def _gear(t: Target, gear: Gear) -> float:
    sb = surface_brightness(t)
    if sb is None:
        return 0.5
    headroom = sb_limit(gear) - sb
    return min(max(headroom / 3.0, 0.0), 1.0)


def _novelty(t: Target, prefs: Preferences, now: Optional[datetime]) -> float:
    now = now or datetime.now(tz=timezone.utc)
    last = prefs.last_viewed.get(t.name) if prefs.last_viewed else None
    if last is None:
        s = 1.0
    else:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        days = (now - last).total_seconds() / 86400.0
        s = max(0.0, min(days / 365.0, 1.0))
    if prefs.preferred_kinds and any(
        k.lower() in t.kind.lower() for k in prefs.preferred_kinds
    ):
        s = min(1.0, s + 0.15)
    return s
