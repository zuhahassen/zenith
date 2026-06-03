"""Tests for the physics-based scoring additions: Bortle surface-brightness
penalty, light-pollution estimate, wavelength filter windows, and FoV match."""

from datetime import datetime, timezone

from api.pipeline.light_pollution import estimate_bortle
from api.pipeline.scorer import (
    filter_window_recommendation,
    fov_match_score,
    mean_surface_brightness_arcsec2,
    surface_brightness_penalty,
)
from api.pipeline.visibility import Target


def _target(**kw):
    base = dict(name="X", ra_deg=10.0, dec_deg=20.0, magnitude=8.0,
                size_arcmin=(28.0, 26.0), kind="Galaxy")
    base.update(kw)
    return Target(**base)


# ---------- surface brightness penalty ----------

def test_m101_surface_brightness_is_physical():
    sb = mean_surface_brightness_arcsec2(7.9, (28.8, 26.9))
    # Real M101 mean SB is ~23.8 mag/arcsec^2.
    assert 23.0 < sb < 24.5


def test_low_sb_galaxy_penalised_in_city_not_dark_site():
    m101 = _target(name="M101", magnitude=7.9, size_arcmin=(28.8, 26.9), kind="Galaxy")
    assert surface_brightness_penalty(m101, 7) == 0.4   # suburban/city
    assert surface_brightness_penalty(m101, 5) == 0.6   # rural threshold (>23)
    assert surface_brightness_penalty(m101, 2) == 1.0   # dark site — no penalty


def test_high_sb_kinds_never_penalised():
    gc = _target(name="M13", magnitude=5.8, size_arcmin=(20.0, 20.0), kind="GlCl")
    pn = _target(name="M57", magnitude=8.8, size_arcmin=(1.4, 1.0), kind="Planetary Nebula")
    for bortle in (2, 5, 9):
        assert surface_brightness_penalty(gc, bortle) == 1.0
        assert surface_brightness_penalty(pn, bortle) == 1.0


def test_bright_compact_galaxy_survives_suburb():
    # A small, bright galaxy has high surface brightness -> no penalty.
    compact = _target(name="M104", magnitude=8.0, size_arcmin=(8.7, 3.5), kind="Galaxy")
    assert surface_brightness_penalty(compact, 7) == 1.0


# ---------- light pollution estimate ----------

def test_city_cores_are_bright():
    assert estimate_bortle(40.71, -74.0) == 9    # NYC
    assert estimate_bortle(51.5074, -0.1278) == 9  # London


def test_remote_defaults_or_dark():
    # Middle of Montana — far from any metro. The population-scaled grid now
    # resolves remote sites to genuinely dark classes rather than the old
    # coarse suburban Bortle-6 default.
    assert estimate_bortle(46.0, -109.0) <= 4


# ---------- FoV matching ----------

def test_fov_andromeda_needs_mosaic():
    # 750mm + APS-C -> ~1.8 x 1.2 deg. Andromeda major axis ~2.5 deg.
    fov_w, fov_h = (23.5 / 750) * 57.3, (15.6 / 750) * 57.3
    score, note = fov_match_score(2.5, fov_w, fov_h)
    assert score <= 0.5
    assert "osaic" in note or "shorter" in note


def test_fov_good_fit_and_too_small():
    fov_w, fov_h = (23.5 / 750) * 57.3, (15.6 / 750) * 57.3
    good, gnote = fov_match_score(0.8, fov_w, fov_h)
    assert good == 1.0 and gnote == "Fits well"
    tiny, tnote = fov_match_score(0.02, fov_w, fov_h)
    assert tiny == 0.6 and "small" in tnote


# ---------- filter windows ----------

def _slots():
    return [
        {"time": datetime(2026, 6, 2, h, 0, tzinfo=timezone.utc), "alt": a}
        for h, a in [(22, 30), (23, 55), (0, 60), (1, 40), (2, 20)]
    ]


def test_filter_windows_only_in_astro_mode():
    assert filter_window_recommendation(_slots(), "observer") == {}
    out = filter_window_recommendation(_slots(), "astrophotographer")
    assert set(["L", "B", "G", "R", "Ha", "OIII", "SII"]).issubset(out)


def test_blue_window_is_narrower_than_red():
    out = filter_window_recommendation(_slots(), "astrophotographer")
    # Red is the full window; blue is restricted to near peak.
    assert (out["R"]["start"], out["R"]["end"]) == ("22:00", "02:00")
    # Blue should not span the whole window.
    assert (out["B"]["start"], out["B"]["end"]) != ("22:00", "02:00")
