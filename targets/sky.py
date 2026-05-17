"""Session-wide sky state: sun, moon, darkness curve.

Cheap to compute once and share across every target.
"""

from dataclasses import dataclass

import numpy as np
from astropy.coordinates import AltAz, EarthLocation, SkyCoord, get_body, get_sun
from astropy.time import Time
import astropy.units as u


@dataclass
class Sky:
    times: Time
    altaz: AltAz
    sun_alt: np.ndarray
    moon: SkyCoord          # ICRS-ish, for separation calcs
    moon_alt: np.ndarray
    moon_illum: float       # mean over the session, 0..1
    is_dark: np.ndarray     # bool, sun < -18°
    darkness: np.ndarray    # 0..1 per step, accounting for moon


def compute_sky(times: Time, loc: EarthLocation) -> Sky:
    altaz = AltAz(obstime=times, location=loc)
    sun = get_sun(times)
    moon = get_body("moon", times, loc)

    sun_alt = sun.transform_to(altaz).alt.deg
    moon_alt = moon.transform_to(altaz).alt.deg

    # Phase via sun-moon elongation: illum = (1 + cos(phase)) / 2
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
    """1 in true dark with no moon. Degrades with moon illumination * altitude."""
    out = np.zeros_like(moon_alt, dtype=float)
    above = moon_alt > 0
    out[~above] = 1.0
    out[above] = np.clip(1.0 - illum[above] * (moon_alt[above] / 90.0), 0.0, 1.0)
    out[~is_dark] = 0.0
    return out
