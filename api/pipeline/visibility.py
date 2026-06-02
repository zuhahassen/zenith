"""Visibility pipeline: dataclasses, sky state, observer geometry, per-target
altitude/airmass/window math, and the `plan_session` orchestrator.

Flattened from the former `targets/` package (models, sky, observer, geometry,
and the package __init__) into one module per the new repo layout.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional

import numpy as np
from astropy.coordinates import (
    AltAz,
    EarthLocation,
    SkyCoord,
    get_body,
    get_sun,
)
from astropy.time import Time
import astropy.units as u


# ---------------------------------------------------------------------------
# Dataclasses (formerly targets/models.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Observer:
    lat: float
    lon: float
    elevation_m: float = 0.0
    name: Optional[str] = None


@dataclass(frozen=True)
class Session:
    duration_hours: float = 4.0
    step_minutes: float = 10.0
    min_alt_deg: float = 25.0
    start: Optional[datetime] = None   # explicit UTC start
    date: Optional[datetime] = None    # falls back to twilight on this date


@dataclass(frozen=True)
class Target:
    name: str
    ra_deg: float
    dec_deg: float
    magnitude: Optional[float] = None
    size_arcmin: Optional[tuple[float, float]] = None  # (major, minor) semi-axes
    kind: str = "Unknown"
    common_name: Optional[str] = None


@dataclass(frozen=True)
class Gear:
    aperture_mm: float = 100.0


@dataclass(frozen=True)
class Preferences:
    preferred_kinds: tuple[str, ...] = ()
    last_viewed: dict[str, datetime] = field(default_factory=dict)


@dataclass
class Scored:
    target: Target
    score: float
    components: dict[str, float]
    window: tuple[Optional[datetime], Optional[datetime], float]
    transit_time: Optional[datetime]
    max_alt_deg: float
    min_airmass: float
    moon_sep_deg: float
    moon_illumination: float
    surface_brightness: Optional[float]
    sb_limit: float
    why: str
    bortle_class: Optional[int] = None
    sb_penalty: float = 1.0
    filter_windows: Optional[dict] = None
    fov_note: Optional[str] = None
    fov_score: Optional[float] = None


# ---------------------------------------------------------------------------
# Sky state (formerly targets/sky.py)
# ---------------------------------------------------------------------------


@dataclass
class Sky:
    times: Time
    altaz: AltAz
    sun_alt: np.ndarray
    moon: SkyCoord
    moon_alt: np.ndarray
    moon_illum: float
    is_dark: np.ndarray
    darkness: np.ndarray


def compute_sky(times: Time, loc: EarthLocation) -> Sky:
    altaz = AltAz(obstime=times, location=loc)
    sun = get_sun(times)
    moon = get_body("moon", times, loc)

    sun_alt = sun.transform_to(altaz).alt.deg
    moon_alt = moon.transform_to(altaz).alt.deg

    elong = sun.separation(moon).to(u.rad).value
    illum = (1.0 + np.cos(np.pi - elong)) / 2.0

    is_dark = sun_alt < -18.0
    darkness = _darkness(is_dark, moon_alt, illum)

    return Sky(
        times=times,
        altaz=altaz,
        sun_alt=sun_alt,
        moon=SkyCoord(moon.ra, moon.dec, frame="icrs"),
        moon_alt=moon_alt,
        moon_illum=float(illum.mean()),
        is_dark=is_dark,
        darkness=darkness,
    )


def _darkness(is_dark, moon_alt, illum):
    out = np.zeros_like(moon_alt, dtype=float)
    above = moon_alt > 0
    out[~above] = 1.0
    out[above] = np.clip(1.0 - illum[above] * (moon_alt[above] / 90.0), 0.0, 1.0)
    out[~is_dark] = 0.0
    return out


# ---------------------------------------------------------------------------
# Observer + time grid (formerly targets/observer.py)
# ---------------------------------------------------------------------------


def location_for(obs: Observer) -> EarthLocation:
    return EarthLocation(
        lat=obs.lat * u.deg, lon=obs.lon * u.deg, height=obs.elevation_m * u.m
    )


def session_start(obs: Observer, session: Session, loc: EarthLocation) -> Time:
    """Use session.start if given, else find astronomical twilight (sun < -18°)
    on the evening of session.date (default: today)."""
    if session.start is not None:
        return Time(_utc(session.start))

    anchor = (session.date or datetime.now(tz=timezone.utc))
    anchor = _utc(anchor).replace(hour=12, minute=0, second=0, microsecond=0)

    grid = Time(anchor) + np.arange(0, 18 * 60, 10) * u.minute
    sun_alt = get_sun(grid).transform_to(AltAz(obstime=grid, location=loc)).alt.deg
    dark = np.where(sun_alt < -18.0)[0]
    if dark.size == 0:
        return Time(anchor)
    return grid[dark[0]]


def time_grid(start: Time, session: Session) -> Time:
    n = int(round(session.duration_hours * 60 / session.step_minutes)) + 1
    return start + np.linspace(0, session.duration_hours, n) * u.hour


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Per-target geometry (formerly targets/geometry.py)
# ---------------------------------------------------------------------------


MAX_AIRMASS = 38.0  # ~15° altitude; secant blows up below this


@dataclass
class Geometry:
    alt: np.ndarray
    az: np.ndarray
    airmass: np.ndarray
    in_window: np.ndarray
    window_start: Optional[datetime]
    window_end: Optional[datetime]
    window_minutes: float
    transit_time: Optional[datetime]
    max_alt: float
    min_airmass: float
    moon_sep_deg: float


def geometry_for(target: Target, sky: Sky, min_alt_deg: float) -> Geometry:
    coord = SkyCoord(ra=target.ra_deg * u.deg, dec=target.dec_deg * u.deg, frame="icrs")
    altaz = coord.transform_to(sky.altaz)
    alt = altaz.alt.deg
    az = altaz.az.deg

    cos_z = np.cos(np.deg2rad(90.0 - alt))
    with np.errstate(divide="ignore", invalid="ignore"):
        airmass = np.where(cos_z > 0, 1.0 / cos_z, MAX_AIRMASS)
    airmass = np.clip(airmass, 1.0, MAX_AIRMASS)

    in_window = (alt >= min_alt_deg) & sky.is_dark
    w_start, w_end, w_minutes = _window(sky.times, in_window)

    if np.any(in_window):
        i = int(np.argmax(np.where(in_window, alt, -np.inf)))
    else:
        i = int(np.argmax(alt))

    return Geometry(
        alt=alt,
        az=az,
        airmass=airmass,
        in_window=in_window,
        window_start=w_start,
        window_end=w_end,
        window_minutes=w_minutes,
        transit_time=_to_dt(sky.times[i]),
        max_alt=float(alt[i]),
        min_airmass=float(airmass[i]),
        moon_sep_deg=float(coord.separation(sky.moon[i]).to(u.deg).value),
    )


def _window(times: Time, mask: np.ndarray):
    if not np.any(mask):
        return None, None, 0.0
    idx = np.where(mask)[0]
    step_min = (times[1] - times[0]).to(u.minute).value if len(times) > 1 else 0.0
    return _to_dt(times[idx[0]]), _to_dt(times[idx[-1]]), float(len(idx) * step_min)


def _to_dt(t: Time) -> datetime:
    dt = t.utc.datetime
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# ---------------------------------------------------------------------------
# Orchestrator (formerly targets/__init__.py: plan_session)
# ---------------------------------------------------------------------------


def plan_session(
    observer: Observer,
    session: Session,
    catalog: Iterable[Target],
    gear: Optional[Gear] = None,
    prefs: Optional[Preferences] = None,
    now: Optional[datetime] = None,
    bortle_class: int = 6,
    mode: str = "observer",
    fov_width_deg: Optional[float] = None,
    fov_height_deg: Optional[float] = None,
) -> list[Scored]:
    # Imports here to avoid a circular import between visibility and scorer.
    from .scorer import (
        filter_window_recommendation,
        fov_match_score,
        passes_filters,
        sb_limit,
        score,
        surface_brightness,
        surface_brightness_penalty,
    )

    gear = gear or Gear()
    prefs = prefs or Preferences()
    now = now or datetime.now(tz=timezone.utc)
    is_astro = mode == "astrophotographer"

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

        # Bortle-aware surface-brightness penalty (all modes).
        penalty = surface_brightness_penalty(t, bortle_class)
        total *= penalty

        # Astrophotographer-only: per-filter windows + sensor framing.
        filter_windows = None
        fov_note = None
        fov_score = None
        if is_astro:
            in_idx = np.where(g.in_window)[0]
            slots = [
                {"time": _to_dt(sky.times[i]), "alt": float(g.alt[i])}
                for i in in_idx
            ]
            filter_windows = filter_window_recommendation(slots, mode) or None
            if fov_width_deg and fov_height_deg:
                size_deg = (t.size_arcmin[0] / 60.0) if t.size_arcmin and t.size_arcmin[0] else None
                fov_score, fov_note = fov_match_score(
                    size_deg, fov_width_deg, fov_height_deg
                )
                total *= fov_score

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
            bortle_class=bortle_class,
            sb_penalty=penalty,
            filter_windows=filter_windows,
            fov_note=fov_note,
            fov_score=fov_score,
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
