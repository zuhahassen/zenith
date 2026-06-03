"""Bortle-class estimator from coordinates.

Thin wrapper over :mod:`api.pipeline.bortle_grid`, which models artificial sky
brightness from proximity to ~190 population centres worldwide (a pragmatic
stand-in for the Falchi et al. 2016 light-pollution atlas raster). The grid
replaces the former coarse 13-city / Bortle-6-default ring lookup, so remote
sites now resolve to genuinely dark classes (1-3) instead of suburban 6.

``estimate_bortle`` keeps its original signature so no caller needs to change.
"""

from __future__ import annotations

from .bortle_grid import bortle_at


def estimate_bortle(lat: float, lon: float) -> int:
    """Best-effort Bortle class (1=darkest .. 9=inner-city) for a location."""
    return bortle_at(lat, lon)
