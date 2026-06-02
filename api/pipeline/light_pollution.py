"""Coarse Bortle-class estimator from coordinates.

A static lookup approximating the World Atlas of Artificial Night Sky
Brightness. Each major population centre is modelled as concentric rings:
the dense core is Bortle 8-9, inner suburbs 6-7, outer surrounds 4-5.
A point inside several rings takes the brightest (highest Bortle) match;
anything outside every ring defaults to suburban Bortle 6.

This is intentionally crude — it gives a sensible default the user can
override in the UI, not a survey-grade measurement.
"""

from __future__ import annotations

import math

# (name, lat, lon, [(radius_km, bortle), ...])
# Rings are listed smallest-first; the first containing ring wins per city.
CITY_ZONES: list[tuple[str, float, float, list[tuple[float, int]]]] = [
    ("New York",   40.7128,  -74.0060, [(25, 9), (60, 7), (110, 5)]),
    ("Los Angeles", 34.0522, -118.2437, [(35, 9), (75, 7), (130, 5)]),
    ("Chicago",    41.8781,  -87.6298, [(25, 9), (55, 7), (100, 5)]),
    ("London",     51.5074,   -0.1278, [(25, 9), (55, 7), (100, 5)]),
    ("Tokyo",      35.6762,  139.6503, [(40, 9), (90, 7), (150, 5)]),
    ("Paris",      48.8566,    2.3522, [(20, 9), (50, 7), (95, 5)]),
    ("Beijing",    39.9042,  116.4074, [(35, 9), (80, 7), (140, 5)]),
    ("Mumbai",     19.0760,   72.8777, [(25, 9), (55, 7), (100, 5)]),
    ("Sao Paulo",  -23.5505, -46.6333, [(35, 9), (75, 7), (130, 5)]),
    # A few extras so common test points resolve sensibly.
    ("San Francisco", 37.7749, -122.4194, [(25, 8), (60, 6), (110, 5)]),
    ("Washington DC", 38.9072, -77.0369, [(25, 8), (55, 6), (100, 5)]),
    ("Delhi",      28.7041,   77.1025, [(30, 9), (70, 7), (120, 5)]),
    ("Shanghai",   31.2304,  121.4737, [(35, 9), (80, 7), (140, 5)]),
]

DEFAULT_BORTLE = 6


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def estimate_bortle(lat: float, lon: float) -> int:
    """Best-effort Bortle class (1=darkest .. 9=inner-city) for a location."""
    best: int | None = None
    for _name, clat, clon, rings in CITY_ZONES:
        dist = _haversine_km(lat, lon, clat, clon)
        for radius_km, bortle in sorted(rings):  # smallest radius (brightest) first
            if dist <= radius_km:
                best = bortle if best is None else max(best, bortle)
                break
    return best if best is not None else DEFAULT_BORTLE
