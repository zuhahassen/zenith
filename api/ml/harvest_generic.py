"""Generic ERA5 harvester: build a seeing training cache for any location.

A generalized version of ``harvest_stanford.py`` that works for an arbitrary
site. It reuses the existing ``api.ml.era5`` download + dataset-building logic
verbatim (no duplicated physics) and only varies the coordinates, the year
range, and the output filename.

Usage:
    python -m api.ml.harvest_generic --lat 51.48 --lon -0.00 --name london \
        --years 2022 2023 2024

Produces:
    api/ml/data/{name}_era5.npz   with X=(N, N_FEATURES), y=(N,), plus the
                                  scalar site lat/lon (consumed by
                                  api.ml.train_multisite).

The site's coordinates are written into the ``site_lat`` / ``site_lon`` feature
columns so the cache is self-describing and immediately usable by the
multi-site trainer. Requires a configured ``~/.cdsapirc`` (Copernicus CDS key).
Heavy deps (cdsapi, xarray, netCDF4) are imported lazily inside ``api.ml.era5``.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from . import era5
from .features import FEATURE_NAMES

# Pressure-level profiles are only needed at night (the seeing-label times).
# 06:00 & 12:00 UTC are deep-night for the Americas/Pacific and pre-dawn/evening
# elsewhere; sampling just these keeps each CDS pressure request under the cost
# cap. Surface fields are pulled hourly regardless, so the rolling-history
# features are unaffected.
PRESSURE_HOURS_UTC = ["06:00", "12:00"]
MONTHS_PER_CHUNK = 3

DATA_DIR = Path(__file__).resolve().parent / "data"


def _log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def harvest(lat: float, lon: float, name: str, years: list[int]) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    start = f"{min(years)}-01-01"
    end = f"{max(years)}-12-31"
    nc_base = DATA_DIR / f"{name}_era5.nc"
    npz_out = DATA_DIR / f"{name}_era5.npz"

    _log(f"Harvesting ERA5 for '{name}' (lat={lat}, lon={lon}) {start}..{end}")
    _log("ECMWF can queue multi-year requests for a while; resumes if interrupted.")

    t0 = time.time()
    era5.download_era5(
        lat=lat,
        lon=lon,
        start=start,
        end=end,
        out_path=str(nc_base),
        pressure_hours=PRESSURE_HOURS_UTC,
        months_per_chunk=MONTHS_PER_CHUNK,
    )
    _log(f"Download complete in {time.time() - t0:.0f}s")

    _log("Deriving seeing labels (Cn^2 -> Fried -> FWHM) and building features...")
    t1 = time.time()
    X, y = era5.build_dataset(str(nc_base), str(npz_out))

    # Stamp the site coordinates into the geolocation feature columns so the
    # cache is self-describing for the multi-site trainer, and persist them as
    # scalars too.
    lat_col = FEATURE_NAMES.index("site_lat")
    lon_col = FEATURE_NAMES.index("site_lon")
    X[:, lat_col] = lat
    X[:, lon_col] = lon
    np.savez_compressed(npz_out, X=X, y=y, lat=float(lat), lon=float(lon))

    _log(f"Built dataset in {time.time() - t1:.0f}s")
    _log(
        f"SUMMARY '{name}': samples={X.shape[0]}  feature_shape={X.shape}  "
        f"median_seeing={float(np.median(y)):.3f} arcsec  -> {npz_out}"
    )
    return npz_out


def main() -> int:
    p = argparse.ArgumentParser(description="Generic ERA5 seeing-dataset harvester.")
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--name", type=str, required=True, help="site slug, e.g. 'london'")
    p.add_argument("--years", type=int, nargs="+", required=True, help="e.g. 2022 2023 2024")
    args = p.parse_args()
    try:
        harvest(args.lat, args.lon, args.name, args.years)
        return 0
    except Exception as exc:
        _log(f"HARVEST FAILED: {type(exc).__name__}: {exc}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
