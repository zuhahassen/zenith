"""EarthLocation + session time grid."""

from datetime import datetime, timezone

import numpy as np
from astropy.coordinates import AltAz, EarthLocation, get_sun
from astropy.time import Time
import astropy.units as u

from .models import Observer, Session


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

    # Sample sun altitude every 10 minutes for 18 hours from local noon.
    grid = Time(anchor) + np.arange(0, 18 * 60, 10) * u.minute
    sun_alt = get_sun(grid).transform_to(AltAz(obstime=grid, location=loc)).alt.deg
    dark = np.where(sun_alt < -18.0)[0]
    if dark.size == 0:
        return Time(anchor)  # polar summer
    return grid[dark[0]]


def time_grid(start: Time, session: Session) -> Time:
    n = int(round(session.duration_hours * 60 / session.step_minutes)) + 1
    return start + np.linspace(0, session.duration_hours, n) * u.hour


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
