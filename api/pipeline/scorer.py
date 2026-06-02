"""Filters + 5-component deterministic scorer + surface brightness math.

Filters run first as boolean gates; whatever survives gets scored.
Scores live in [0, 1] and combine with fixed weights.

Moved from the former `targets/scoring.py`.
"""

import math
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .visibility import Gear, Geometry, Preferences, Session, Sky, Target


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

    moon_thresh = 15.0 + 30.0 * max(0.0, min(1.0, moon_illum))
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


# ---------- Bortle / light-pollution surface-brightness penalty ----------

# Kinds whose light is concentrated enough to punch through light pollution:
# planetary nebulae, globular/compact clusters, double/multiple stars. These
# are never penalised regardless of their (often unreliable) angular size.
_HIGH_SB_KIND_TOKENS = (
    "glcl", "globular", "planetary", "pn", "double", "multiple",
    "star", "cluster",
)


def mean_surface_brightness_arcsec2(
    magnitude: Optional[float], size_arcmin: Optional[tuple[float, float]]
) -> Optional[float]:
    """Mean surface brightness in mag/arcsec^2.

    SB = m + 2.5*log10(area). The spec writes the area in arcmin^2, but the
    22-23 thresholds it pairs this with are the standard mag/arcsec^2 sky-glow
    figures (a clear suburban sky is ~21-22, a galaxy disk ~23-24). Computing
    the area in arcsec^2 puts SB on that same physical scale and reproduces
    real catalogue values (e.g. M101 ~23.8), so we use arcsec^2 here.
    """
    if magnitude is None:
        return None
    major = size_arcmin[0] if (size_arcmin and size_arcmin[0]) else 5.0
    if major <= 0:
        major = 5.0
    radius_arcsec = (major * 60.0) / 2.0
    area_arcsec2 = math.pi * radius_arcsec * radius_arcsec
    return float(magnitude + 2.5 * math.log10(area_arcsec2))


def surface_brightness_penalty(target: Target, bortle_class: int) -> float:
    """Score multiplier (0.3-1.0) penalising low-surface-brightness objects
    under light-polluted skies. A galaxy with a bright integrated magnitude
    but diffuse light disappears under suburban glow no matter the aperture.
    """
    kind = (target.kind or "").lower()
    if any(tok in kind for tok in _HIGH_SB_KIND_TOKENS):
        return 1.0

    sb = mean_surface_brightness_arcsec2(target.magnitude, target.size_arcmin)
    if sb is None:
        return 1.0

    if bortle_class >= 7:          # suburban / city — only bright SB survives
        return 0.4 if sb > 22.0 else 1.0
    if bortle_class >= 4:          # rural / semi-dark
        return 0.6 if sb > 23.0 else 1.0
    return 1.0                      # Bortle 1-3 dark site — no penalty


# ---------- wavelength-dependent filter windows (astrophotographer) ----------

def filter_window_recommendation(slots: list[dict], mode: str) -> dict:
    """Per-filter sub-windows across a target's visibility window.

    Blue light Rayleigh-scatters ~3-4x more than red, so broadband blue and
    luminance want peak altitude (minimum airmass), while red and narrowband
    are nearly extinction-immune and can use the whole window.

    Args:
        slots: time-ordered list of {"time": datetime, "alt": float} for the
            target's in-window samples.
        mode: only "astrophotographer" produces output.
    """
    if mode != "astrophotographer" or not slots:
        return {}

    def fmt(dt) -> str:
        return dt.strftime("%H:%M")

    def window_for(pred) -> Optional[tuple[str, str]]:
        q = [s for s in slots if pred(s)]
        if not q:
            return None
        return fmt(q[0]["time"]), fmt(q[-1]["time"])

    peak_alt = max(s["alt"] for s in slots)
    full = (fmt(slots[0]["time"]), fmt(slots[-1]["time"]))

    lum = window_for(lambda s: s["alt"] >= peak_alt - 10.0) or full
    blue = window_for(lambda s: s["alt"] >= peak_alt - 5.0) or full
    green = window_for(lambda s: s["alt"] >= 35.0) or full

    out = {
        "L": {"start": lum[0], "end": lum[1],
              "note": "Shoot at peak altitude — least extinction"},
        "B": {"start": blue[0], "end": blue[1],
              "note": "Shoot near transit — blue scatters ~3x more than red"},
        "G": {"start": green[0], "end": green[1],
              "note": "Usable above ~35° altitude"},
        "R": {"start": full[0], "end": full[1],
              "note": "Full window usable — red minimally scattered"},
        "Ha": {"start": full[0], "end": full[1],
               "note": "Narrowband — unaffected by sky glow or extinction"},
        "OIII": {"start": full[0], "end": full[1],
                 "note": "Narrowband — full window usable"},
        "SII": {"start": full[0], "end": full[1],
                "note": "Narrowband — full window usable"},
    }
    return out


# ---------- sensor field-of-view matching (astrophotographer) ----------

def fov_match_score(
    target_angular_size_deg: Optional[float],
    fov_width_deg: float,
    fov_height_deg: float,
) -> tuple[float, str]:
    """How well a target frames on the sensor. Returns (score, note).

    target_angular_size_deg is the object's major axis in degrees; it is
    compared against the smaller FoV dimension so the whole object must fit.
    """
    fov_min = min(fov_width_deg, fov_height_deg)
    if not target_angular_size_deg or target_angular_size_deg <= 0 or fov_min <= 0:
        return 0.8, "Fits well"

    ratio = target_angular_size_deg / fov_min
    if ratio < 0.05:
        return 0.6, "Too small — consider a longer focal length"
    if ratio <= 0.80:
        return 1.0, "Fits well"
    if ratio <= 1.10:
        return 0.8, "Tight framing"
    if ratio <= 2.00:
        panels = math.ceil(ratio)
        return 0.5, f"Mosaic required ({panels}×1 panels)"
    panels = math.ceil(ratio)
    return 0.2, f"Too large — mosaic of {panels}×1 panels or use a shorter focal length"
