"""Sanity tests for the planner.

These check qualitative properties (does M13 dominate in summer? does the
Arctic observer lose Sagittarius?) rather than exact numbers, so they
survive small library/ephemeris version bumps.
"""

from datetime import datetime, timezone

import pytest

from targets import CATALOG, Gear, Observer, Preferences, Session, plan_session
from targets.observer import location_for, session_start, time_grid
from targets.scoring import surface_brightness
from targets.sky import compute_sky
from targets.models import Target


BERKELEY = Observer(lat=37.8716, lon=-122.2727, elevation_m=52.0, name="Berkeley, CA")


def test_twilight_is_actually_dark():
    s = Session(date=datetime(2024, 6, 20, tzinfo=timezone.utc))
    loc = location_for(BERKELEY)
    times = time_grid(session_start(BERKELEY, s, loc), s)
    sky = compute_sky(times, loc)
    assert sky.sun_alt[0] < -17.5
    assert sky.is_dark.mean() > 0.5


def test_darkness_curve_in_range():
    s = Session(date=datetime(2024, 12, 21, tzinfo=timezone.utc))
    loc = location_for(BERKELEY)
    times = time_grid(session_start(BERKELEY, s, loc), s)
    sky = compute_sky(times, loc)
    assert 0.0 <= sky.darkness.min() and sky.darkness.max() <= 1.0
    assert 0.0 <= sky.moon_illum <= 1.0


def test_m13_top5_in_june():
    s = Session(date=datetime(2024, 6, 20, tzinfo=timezone.utc))
    results = plan_session(BERKELEY, s, CATALOG, Gear(aperture_mm=150),
                           now=datetime(2024, 6, 20, 12, tzinfo=timezone.utc))
    names = [r.target.name for r in results]
    assert "M13" in names and names.index("M13") < 5, names


def test_m42_top5_when_it_transits():
    # M42 transits ~00:30 PST on Dec 21; anchor session at 22:00 PST.
    s = Session(start=datetime(2024, 12, 22, 6, tzinfo=timezone.utc))
    results = plan_session(BERKELEY, s, CATALOG, Gear(aperture_mm=150),
                           now=datetime(2024, 12, 21, 12, tzinfo=timezone.utc))
    names = [r.target.name for r in results]
    assert "M42" in names and names.index("M42") < 5, names


def test_arctic_drops_southern_targets():
    arctic = Observer(lat=70.0, lon=0.0)
    s = Session(date=datetime(2024, 12, 21, tzinfo=timezone.utc))
    names = [r.target.name for r in plan_session(arctic, s, CATALOG, Gear(aperture_mm=200))]
    # M8 / M22 are at dec ≈ -24°, never up from 70°N.
    assert "M8" not in names and "M22" not in names


def test_results_are_sorted():
    s = Session(date=datetime(2024, 6, 20, tzinfo=timezone.utc))
    results = plan_session(BERKELEY, s, CATALOG, Gear(aperture_mm=150))
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)


def test_scored_fields_populated():
    s = Session(date=datetime(2024, 12, 21, tzinfo=timezone.utc))
    results = plan_session(BERKELEY, s, CATALOG, Gear(aperture_mm=150))
    assert results
    top = results[0]
    w_start, w_end, w_min = top.window
    assert w_start and w_end and w_min >= 30.0
    assert top.transit_time and 0 <= top.max_alt_deg <= 90
    assert 1.0 <= top.min_airmass <= 38.0
    assert 0 <= top.moon_sep_deg <= 180
    assert top.why
    for k, v in top.components.items():
        assert 0.0 <= v <= 1.0, (k, v)


def test_surface_brightness_extended_vs_point():
    point = Target(name="x", ra_deg=0, dec_deg=0, magnitude=8.0)
    extended = Target(name="y", ra_deg=0, dec_deg=0, magnitude=8.0,
                      size_arcmin=(10.0, 5.0))
    assert surface_brightness(point) == pytest.approx(8.0)
    # Same total mag spread over area => higher (dimmer) SB.
    assert surface_brightness(extended) > 8.0
