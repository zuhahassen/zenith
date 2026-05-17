"""Per-target alt/az curves, airmass, visibility window, transit, moon sep."""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.time import Time
import astropy.units as u

from .models import Target
from .sky import Sky


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

    # Pick the brightest moment inside the window if possible.
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
