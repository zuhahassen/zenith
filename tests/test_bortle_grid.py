"""Tests for the population-scaled Bortle grid (api.pipeline.bortle_grid)."""

import time

from api.pipeline.bortle_grid import bortle_at, city_count
from api.pipeline.light_pollution import estimate_bortle


def test_urban_cores_are_bright():
    assert bortle_at(40.71, -74.01) == 9    # New York
    assert bortle_at(51.51, -0.13) == 9      # London
    assert bortle_at(35.68, 139.65) == 9     # Tokyo


def test_remote_sites_are_dark():
    # Central Pacific Ocean — nothing within ~thousands of km.
    assert bortle_at(0.0, -140.0) <= 2
    # Sahara interior.
    assert bortle_at(23.0, 12.0) <= 3
    # Central Australian outback.
    assert bortle_at(-25.0, 131.0) <= 3


def test_suburban_halo_between_core_and_dark():
    # ~40 km out from central London should be elevated but below the core.
    b = bortle_at(51.9, -0.6)
    assert 4 <= b <= 8


def test_signature_unchanged_delegates_to_grid():
    # estimate_bortle keeps its int->int contract and matches the grid.
    assert estimate_bortle(40.71, -74.01) == bortle_at(40.71, -74.01)


def test_result_always_in_valid_range():
    for lat, lon in [(0, 0), (90, 0), (-90, 180), (37.77, -122.42), (19.43, -99.13)]:
        assert 1 <= bortle_at(lat, lon) <= 9


def test_grid_has_reasonable_coverage():
    assert city_count() >= 150


def test_lookup_is_fast():
    # Must stay well under 5 ms since it runs on every plan request.
    # Measure an average over many calls to smooth out timer noise.
    n = 200
    t0 = time.perf_counter()
    for _ in range(n):
        bortle_at(37.43, -122.17)
    avg_ms = (time.perf_counter() - t0) / n * 1000.0
    assert avg_ms < 5.0, f"bortle_at averaged {avg_ms:.3f} ms (budget 5 ms)"
