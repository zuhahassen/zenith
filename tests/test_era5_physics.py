"""Tests for the ERA5 optical-turbulence physics in api/ml/era5.py.

These exercise the pure-numpy Cn^2 / seeing chain only — no CDS download,
no xarray, no network.
"""

import numpy as np

from api.ml.era5 import (
    SEEING_CLIP,
    cn2_profile,
    derive_seeing,
    potential_temperature,
    seeing_from_cn2,
)


# A coarse but realistic mid-latitude column (hPa, K, m^2/s^2, m/s).
LEVELS = np.array([1000, 850, 700, 500, 300, 200, 100], dtype=float)
TEMP = np.array([288, 278, 268, 252, 228, 218, 210], dtype=float)
# geopotential = g * height; heights ~ 100m, 1500m, 3000m, 5500m, 9000m, 12000m, 16000m
GEO = np.array([100, 1500, 3000, 5500, 9000, 12000, 16000], dtype=float) * 9.80665
U = np.array([2, 8, 14, 25, 40, 30, 15], dtype=float)
V = np.array([0, 1, 3, 6, 10, 8, 4], dtype=float)


def test_potential_temperature_increases_with_height():
    theta = potential_temperature(TEMP, LEVELS)
    # Potential temperature should increase monotonically upward in a
    # stably stratified atmosphere (levels are top-to-bottom by pressure).
    # Sort by pressure descending == height ascending.
    assert theta[0] < theta[-1]
    # At the 1000 hPa reference level theta == T.
    assert np.isclose(potential_temperature(np.array([288.0]), np.array([1000.0]))[0], 288.0)


def test_cn2_profile_nonnegative_and_correct_length():
    h_mid, cn2 = cn2_profile(LEVELS, TEMP, GEO, U, V)
    assert len(cn2) == len(LEVELS) - 1
    assert len(h_mid) == len(LEVELS) - 1
    assert np.all(cn2 >= 0)
    assert np.all(np.isfinite(cn2))


def test_seeing_within_physical_bounds():
    eps = derive_seeing(LEVELS, TEMP, GEO, U, V)
    assert SEEING_CLIP[0] <= eps <= SEEING_CLIP[1]


def test_neutral_column_gives_floor_seeing():
    # A neutrally stratified atmosphere has constant potential temperature
    # (T follows the dry adiabat), so d(ln theta)/dz = 0 -> M = 0 -> no
    # optical turbulence -> floor seeing. Build T from constant theta=300 K.
    theta0 = 300.0
    neutral_t = theta0 * (LEVELS / 1000.0) ** 0.2857
    no_wind = np.zeros_like(LEVELS)
    eps = derive_seeing(LEVELS, neutral_t, GEO, no_wind, no_wind)
    assert eps == SEEING_CLIP[0]


def test_stronger_turbulence_increases_seeing():
    h_mid, cn2 = cn2_profile(LEVELS, TEMP, GEO, U, V)
    weak = seeing_from_cn2(h_mid, cn2)
    strong = seeing_from_cn2(h_mid, cn2 * 100.0)
    # More turbulence (larger Cn^2 integral) must not improve seeing.
    assert strong >= weak


def test_seeing_scales_with_cn2_integral_direction():
    # Enlarging the integral shrinks r0 and thus enlarges eps (until clip).
    h = np.array([1000.0, 5000.0, 9000.0])
    cn2_small = np.array([1e-17, 5e-18, 2e-18])
    cn2_big = cn2_small * 50
    eps_small = seeing_from_cn2(h, cn2_small)
    eps_big = seeing_from_cn2(h, cn2_big)
    assert eps_big >= eps_small
