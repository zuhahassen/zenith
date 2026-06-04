"""Multi-night target observability calendar.

For a single target and a date range (up to 90 nights), compute per-night
visibility: whether the target clears a minimum altitude during astronomical
darkness, the best observation window, peak altitude, moon geometry, an
optional seeing forecast (near-term only), and a 0-1 composite quality score.

The per-night math is pure Astropy and CPU-bound, so the orchestrator fans the
nights out across a bounded thread pool (asyncio.to_thread + a semaphore of 10)
to stay well under the response-time budget for a 90-night range.
"""

from __future__ import annotations

import asyncio
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Optional

import numpy as np
from astropy.coordinates import AltAz, EarthLocation, SkyCoord, get_body, get_sun
from astropy.time import Time
import astropy.units as u


# Concurrency + grid resolution. 15-minute sampling within the near term, 30
# minutes beyond NEAR_TERM_DAYS — the coarser grid keeps a 90-night request
# under the latency budget without materially changing window estimates.
_MAX_CONCURRENCY = 10
_NEAR_TERM_DAYS = 14
_FINE_STEP_MIN = 15
_COARSE_STEP_MIN = 30
# Step used to locate the astronomical-darkness window each night.
_DARK_SCAN_STEP_MIN = 5

# Seeing (arcsec FWHM) → 0-1 score anchors, matching the site-comparison scale.
_SEEING_BEST_ARCSEC = 1.0
_SEEING_WORST_ARCSEC = 3.5
# Neutral seeing score for nights with no forecast (beyond the Open-Meteo range).
_SEEING_NEUTRAL = 0.5

# Quality-score weights (sum to 1.0).
_W_ALT = 0.4
_W_MOON = 0.3
_W_WINDOW = 0.2
_W_SEEING = 0.1


async def build_calendar(
    lat: float,
    lon: float,
    ra_deg: float,
    dec_deg: float,
    start_date: date_cls,
    end_date: date_cls,
    min_alt_deg: float = 20.0,
    seeing_by_date: Optional[dict[str, float]] = None,
) -> list[dict]:
    """Compute one :class:`CalendarNight`-shaped dict per night in the range.

    Args:
        seeing_by_date: optional map of ``"YYYY-MM-DD" -> predicted_seeing``
            for near-term nights; nights absent from the map get a null
            ``predicted_seeing`` and a neutral seeing sub-score.
    """
    seeing_by_date = seeing_by_date or {}
    loc = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=0 * u.m)

    dates = _date_range(start_date, end_date)
    sem = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def one(d: date_cls) -> dict:
        step = _FINE_STEP_MIN if (d - start_date).days < _NEAR_TERM_DAYS else _COARSE_STEP_MIN
        async with sem:
            return await asyncio.to_thread(
                _compute_night,
                d, loc, lon, ra_deg, dec_deg, min_alt_deg, step,
                seeing_by_date.get(d.isoformat()),
            )

    return await asyncio.gather(*(one(d) for d in dates))


def _compute_night(
    d: date_cls,
    loc: EarthLocation,
    lon: float,
    ra_deg: float,
    dec_deg: float,
    min_alt_deg: float,
    grid_minutes: int,
    predicted_seeing: Optional[float],
) -> dict:
    """Pure per-night computation (no I/O). Safe to run in a worker thread."""
    target = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg, frame="icrs")

    # Anchor at local noon (approx via longitude) so the scan captures the
    # night that belongs to this calendar date rather than a UTC-split night.
    local_noon = datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=timezone.utc)
    anchor = local_noon - timedelta(hours=lon / 15.0)
    local_midnight = anchor + timedelta(hours=12)

    # Coarse 24h scan from local noon to find the astronomical-darkness window.
    n_scan = int(24 * 60 / _DARK_SCAN_STEP_MIN)
    scan = Time(anchor) + np.arange(n_scan) * _DARK_SCAN_STEP_MIN * u.minute
    sun_alt = get_sun(scan).transform_to(AltAz(obstime=scan, location=loc)).alt.deg
    dark = sun_alt < -18.0

    # Moon geometry at local midnight (illumination + separation from target).
    moon_mid = get_body("moon", Time(local_midnight), loc)
    sun_mid = get_sun(Time(local_midnight))
    elong = sun_mid.separation(moon_mid).to(u.rad).value
    moon_illum = float((1.0 + np.cos(np.pi - elong)) / 2.0)
    moon_sep = float(target.separation(SkyCoord(moon_mid.ra, moon_mid.dec, frame="icrs")).to(u.deg).value)

    base = {
        "date": d.isoformat(),
        "observable": False,
        "window_start": None,
        "window_end": None,
        "window_hours": None,
        "peak_alt_deg": None,
        "peak_time": None,
        "moon_illumination": round(moon_illum, 3),
        "moon_separation_deg": round(moon_sep, 1),
        "predicted_seeing": (round(predicted_seeing, 2) if predicted_seeing is not None else None),
        "quality_score": None,
        "dark_window_hours": 0.0,
    }

    if not bool(dark.any()):
        return base  # no astronomical darkness (e.g. high-latitude summer)

    dark_idx = np.where(dark)[0]
    dark_start = scan[dark_idx[0]]
    dark_end = scan[dark_idx[-1]]
    dark_window_hours = float(len(dark_idx) * _DARK_SCAN_STEP_MIN / 60.0)
    base["dark_window_hours"] = round(dark_window_hours, 2)

    # Sample the target across the dark window at the requested resolution.
    span_min = (dark_end - dark_start).to(u.minute).value
    n_pts = max(2, int(span_min / grid_minutes) + 1)
    tgrid = dark_start + np.linspace(0, span_min, n_pts) * u.minute
    alt = target.transform_to(AltAz(obstime=tgrid, location=loc)).alt.deg

    peak_i = int(np.argmax(alt))
    peak_alt = float(alt[peak_i])
    base["peak_alt_deg"] = round(peak_alt, 1)
    base["peak_time"] = _iso(tgrid[peak_i])

    in_window = alt >= min_alt_deg
    if bool(in_window.any()):
        widx = np.where(in_window)[0]
        w_start = tgrid[widx[0]]
        w_end = tgrid[widx[-1]]
        window_hours = float((w_end - w_start).to(u.hour).value)
        base.update(
            observable=True,
            window_start=_iso(w_start),
            window_end=_iso(w_end),
            window_hours=round(window_hours, 2),
            quality_score=_quality_score(
                peak_alt, min_alt_deg, window_hours, dark_window_hours,
                moon_illum, moon_sep, predicted_seeing,
            ),
        )

    return base


def _quality_score(
    peak_alt: float,
    min_alt: float,
    window_hours: float,
    dark_window_hours: float,
    moon_illum: float,
    moon_sep: float,
    predicted_seeing: Optional[float],
) -> float:
    """0-1 composite: altitude, moon, window duration, and seeing."""
    span = max(90.0 - min_alt, 1e-6)
    alt_score = _clamp01((peak_alt - min_alt) / span)
    # Darker (lower illumination) and farther from the target both help.
    moon_score = _clamp01(0.6 * (1.0 - moon_illum) + 0.4 * (moon_sep / 180.0))
    window_score = _clamp01(window_hours / dark_window_hours) if dark_window_hours > 0 else 0.0
    if predicted_seeing is None:
        seeing_score = _SEEING_NEUTRAL
    else:
        seeing_score = _clamp01(
            (_SEEING_WORST_ARCSEC - predicted_seeing)
            / (_SEEING_WORST_ARCSEC - _SEEING_BEST_ARCSEC)
        )
    score = (
        _W_ALT * alt_score
        + _W_MOON * moon_score
        + _W_WINDOW * window_score
        + _W_SEEING * seeing_score
    )
    return round(_clamp01(score), 3)


def _date_range(start: date_cls, end: date_cls) -> list[date_cls]:
    days = (end - start).days
    return [start + timedelta(days=i) for i in range(days + 1)]


def _iso(t: Time) -> str:
    dt = t.utc.datetime
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))
