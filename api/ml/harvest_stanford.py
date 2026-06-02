"""Harvest 3 years of ERA5 reanalysis for Stanford, CA and build a training cache.

This is a thin data-engineering driver over ``api.ml.era5``. It:

  1. ensures the output directory ``api/ml/data/`` exists,
  2. downloads ERA5 single-level + pressure-level fields for the Stanford
     coordinates over 2023-01-01 .. 2025-12-31, and
  3. derives the optical-turbulence seeing labels and feature matrix, writing
     the result to ``api/ml/data/stanford_3yr.npz``.

Requires a configured ``~/.cdsapirc`` (Copernicus Climate Data Store key). The
ECMWF queue can take a long time for multi-year requests, so this is intended
to be run as a background process with stdout/stderr tee'd to a log file, e.g.:

    nohup .venv/bin/python -m api.ml.harvest_stanford \
        > api/ml/data/harvest.log 2>&1 &

Heavy dependencies (cdsapi, xarray, netCDF4) are imported lazily inside
``api.ml.era5`` and are never touched by the API server or inference path.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

from . import era5

# --- Stanford University, CA ------------------------------------------------
STANFORD_LAT = 37.4275
STANFORD_LON = -122.1697

START_DATE = "2023-01-01"
END_DATE = "2025-12-31"

# Output layout. The NetCDF base path is used by era5.download_era5 to write
# ``<base>.pl.nc`` and ``<base>.sl.nc``; build_dataset reads the same base.
DATA_DIR = Path(__file__).resolve().parent / "data"
NC_BASE = DATA_DIR / "stanford_era5.nc"
NPZ_OUT = DATA_DIR / "stanford_3yr.npz"


def _log(msg: str) -> None:
    """Timestamped, unbuffered logging so a tee'd log file stays readable."""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def harvest() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _log(f"Output directory ready: {DATA_DIR}")

    _log(
        f"Requesting ERA5 for Stanford (lat={STANFORD_LAT}, lon={STANFORD_LON}) "
        f"from {START_DATE} to {END_DATE}. This can sit in the ECMWF queue for a while."
    )
    t0 = time.time()
    era5.download_era5(
        lat=STANFORD_LAT,
        lon=STANFORD_LON,
        start=START_DATE,
        end=END_DATE,
        out_path=str(NC_BASE),
    )
    _log(f"Download complete in {time.time() - t0:.0f}s -> {NC_BASE}.[pl|sl].nc")

    _log("Deriving seeing labels (Cn^2 -> Fried -> FWHM) and building feature matrix...")
    t1 = time.time()
    X, y = era5.build_dataset(str(NC_BASE), str(NPZ_OUT))
    _log(
        f"Built dataset in {time.time() - t1:.0f}s: X={X.shape}, y={y.shape} -> {NPZ_OUT}"
    )
    _log(
        f"Seeing label summary: min={y.min():.3f}  median={float(np.median(y)):.3f}  "
        f"max={y.max():.3f} arcsec"
    )
    _log("Done. Validate with: python -m api.ml.check_distribution")
    return NPZ_OUT


def main() -> int:
    try:
        harvest()
        return 0
    except Exception as exc:  # surface the failure clearly in the log file
        _log(f"HARVEST FAILED: {type(exc).__name__}: {exc}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
