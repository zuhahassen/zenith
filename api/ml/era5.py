"""ERA5 reanalysis training path for the atmospheric-seeing predictor.

This module replaces the synthetic generator in ``train_xgb.py`` with labels
derived from real ECMWF ERA5 reanalysis. ERA5 does not contain a "seeing"
field, so the label is computed from the optical-turbulence profile that the
reanalysis pressure levels imply, using the standard atmospheric-optics chain:

    potential temperature      theta = T (P0 / P)^kappa
    refractive-index gradient  M     = -80e-6 (P / T) d(ln theta)/dz
    outer scale (Dewan 1993)   L0^(4/3) = 0.1^(4/3) * 10^(1.64 + 42 S)
    structure constant         Cn2(h)   = 2.8 * M^2 * L0^(4/3)        (Tatarski)
    turbulence integral        J        = integral Cn2(h) dh
    Fried parameter            r0       = (0.423 k^2 sec(z) J)^(-3/5)
    seeing (FWHM)              eps      = 0.98 lambda / r0

where ``S = |dV/dz|`` is the wind-shear magnitude, ``kappa = R/cp = 0.286``,
``k = 2 pi / lambda`` and ``lambda = 500 nm``. The single-level fields
(2 m temperature, dewpoint, MSL pressure, 10 m wind, total cloud cover) are
converted into the same weather-history dicts that ``features.build_feature_vector``
consumes, so the feature contract is identical to the live inference path.

Heavy dependencies (``cdsapi``, ``xarray``, ``netCDF4``) are imported lazily so
that the API server and the seeing-inference path never need them. Only the
offline dataset-preparation step does.

Caveat: the Cn2 coefficient (2.8) and the Dewan outer-scale model are
literature defaults. Absolute seeing values should be calibrated against site
DIMM measurements before being treated as ground truth; the predictor learns
the mapping from surface weather to whatever label this produces.

CLI (offline data prep):
    python -m api.ml.era5 download  --lat 31.96 --lon -111.6 \
        --start 2023-01-01 --end 2023-03-31 --out data/era5_kpno.nc
    python -m api.ml.era5 build     --nc data/era5_kpno.nc --out data/era5_kpno.npz
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from .features import N_FEATURES, build_feature_vector

# Physical constants ---------------------------------------------------------
G0 = 9.80665              # standard gravity, m/s^2
KAPPA = 0.2857            # R_d / c_p for dry air
P0_HPA = 1000.0           # reference pressure, hPa
LAMBDA_M = 500e-9         # reference wavelength, m
CN2_COEFF = 2.8           # Tatarski structure-constant coefficient
HISTORY_HOURS = 12        # surface history length per training sample
SEEING_CLIP = (0.4, 5.0)  # arcsec, matches train_xgb fallback range

# ERA5 pressure levels to request (hPa). Coarse but enough to integrate Cn2.
PRESSURE_LEVELS = [
    1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50,
]

# ERA5 single-level variable name -> our weather-history key.
_SINGLE_LEVEL_MAP = {
    "2m_temperature": "temperature_2m",
    "2m_dewpoint_temperature": "dewpoint_2m",
    "mean_sea_level_pressure": "pressure_msl",
    "10m_u_component_of_wind": "wind_u_10m",
    "10m_v_component_of_wind": "wind_v_10m",
    "total_cloud_cover": "cloud_cover",
}


# ---------------------------------------------------------------------------
# Optical-turbulence physics (pure numpy; unit-tested without any network)
# ---------------------------------------------------------------------------


def potential_temperature(temp_k: np.ndarray, pressure_hpa: np.ndarray) -> np.ndarray:
    """Potential temperature theta = T (P0/P)^kappa, with T in kelvin."""
    return temp_k * (P0_HPA / pressure_hpa) ** KAPPA


def cn2_profile(
    pressure_hpa: np.ndarray,
    temp_k: np.ndarray,
    geopotential: np.ndarray,
    u_wind: np.ndarray,
    v_wind: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Cn^2 per layer from an atmospheric column.

    All inputs are 1-D arrays over pressure levels, ordered arbitrarily; they
    are sorted by geometric height internally. ``geopotential`` is the ERA5
    geopotential in m^2/s^2 (height = geopotential / g0).

    Returns:
        (heights_mid, cn2) where ``heights_mid`` are layer-midpoint heights (m)
        and ``cn2`` is the structure constant of refractive index per layer
        (m^(-2/3)). Length is ``len(levels) - 1``.
    """
    height = np.asarray(geopotential, dtype=float) / G0
    order = np.argsort(height)
    h = height[order]
    p = np.asarray(pressure_hpa, dtype=float)[order]
    t = np.asarray(temp_k, dtype=float)[order]
    u = np.asarray(u_wind, dtype=float)[order]
    v = np.asarray(v_wind, dtype=float)[order]

    theta = potential_temperature(t, p)

    dz = np.diff(h)
    dz = np.where(dz == 0, np.nan, dz)

    # Vertical gradients across each layer.
    dln_theta_dz = np.diff(np.log(theta)) / dz
    du_dz = np.diff(u) / dz
    dv_dz = np.diff(v) / dz
    shear = np.sqrt(du_dz**2 + dv_dz**2)  # |dV/dz|, s^-1

    # Layer-mean P, T for the refractive-index gradient term.
    p_mid = 0.5 * (p[:-1] + p[1:])
    t_mid = 0.5 * (t[:-1] + t[1:])

    # Generalized potential refractive-index gradient (optical, dry).
    m_grad = -80e-6 * (p_mid / t_mid) * dln_theta_dz

    # Dewan (1993) tropospheric outer-scale model. Clamp the exponent so a
    # single very sheared layer can't blow up the integral.
    exponent = np.clip(1.64 + 42.0 * shear, None, 6.0)
    l0_43 = (0.1 ** (4.0 / 3.0)) * np.power(10.0, exponent)

    cn2 = CN2_COEFF * (m_grad**2) * l0_43
    cn2 = np.nan_to_num(cn2, nan=0.0, posinf=0.0, neginf=0.0)
    cn2 = np.clip(cn2, 0.0, None)

    h_mid = 0.5 * (h[:-1] + h[1:])
    return h_mid, cn2


def seeing_from_cn2(
    heights_mid: np.ndarray,
    cn2: np.ndarray,
    zenith_deg: float = 0.0,
) -> float:
    """Convert a Cn^2 profile to seeing FWHM in arcseconds.

    J = integral Cn2 dh, r0 = (0.423 k^2 sec(z) J)^(-3/5),
    eps = 0.98 lambda / r0 (radians) -> arcsec.
    """
    h = np.asarray(heights_mid, dtype=float)
    c = np.asarray(cn2, dtype=float)
    if h.size < 2 or not np.any(c > 0):
        return SEEING_CLIP[0]

    # Trapezoidal integral of Cn2 over height -> turbulence integral J (m^1/3).
    # np.trapz was renamed to np.trapezoid in NumPy 2.0.
    _trapz = getattr(np, "trapezoid", None) or np.trapz
    j = float(_trapz(c, h))
    if j <= 0:
        return SEEING_CLIP[0]

    k = 2.0 * np.pi / LAMBDA_M
    sec_z = 1.0 / np.cos(np.radians(zenith_deg))
    r0 = (0.423 * k**2 * sec_z * j) ** (-3.0 / 5.0)  # Fried parameter, m
    eps_rad = 0.98 * LAMBDA_M / r0
    eps_arcsec = eps_rad * 206265.0
    return float(np.clip(eps_arcsec, *SEEING_CLIP))


def derive_seeing(
    pressure_hpa: np.ndarray,
    temp_k: np.ndarray,
    geopotential: np.ndarray,
    u_wind: np.ndarray,
    v_wind: np.ndarray,
    zenith_deg: float = 0.0,
) -> float:
    """End-to-end: atmospheric column -> seeing FWHM (arcsec)."""
    h_mid, cn2 = cn2_profile(pressure_hpa, temp_k, geopotential, u_wind, v_wind)
    return seeing_from_cn2(h_mid, cn2, zenith_deg=zenith_deg)


# ---------------------------------------------------------------------------
# CDS download (lazy cdsapi)
# ---------------------------------------------------------------------------


def download_era5(
    lat: float,
    lon: float,
    start: str,
    end: str,
    out_path: str,
    *,
    half_box_deg: float = 0.5,
) -> Path:
    """Download ERA5 single-level + pressure-level fields for a small box.

    Requires a configured ``~/.cdsapirc`` (CDS API key). Writes one NetCDF
    file containing both products. See https://cds.climate.copernicus.eu.
    """
    import cdsapi  # lazy: only needed for live download

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    d0 = datetime.fromisoformat(start)
    d1 = datetime.fromisoformat(end)
    years = sorted({str(y) for y in range(d0.year, d1.year + 1)})
    months = sorted({f"{m:02d}" for m in _month_range(d0, d1)})
    days = [f"{d:02d}" for d in range(1, 32)]
    # Nighttime-biased hours (UTC). Adjust per-site longitude as needed.
    hours = [f"{h:02d}:00" for h in range(0, 24)]
    area = [lat + half_box_deg, lon - half_box_deg,
            lat - half_box_deg, lon + half_box_deg]  # N, W, S, E

    client = cdsapi.Client()
    client.retrieve(
        "reanalysis-era5-pressure-levels",
        {
            "product_type": "reanalysis",
            "format": "netcdf",
            "variable": ["temperature", "geopotential",
                         "u_component_of_wind", "v_component_of_wind"],
            "pressure_level": [str(p) for p in PRESSURE_LEVELS],
            "year": years, "month": months, "day": days,
            "time": hours, "area": area,
        },
        str(out.with_suffix(".pl.nc")),
    )
    client.retrieve(
        "reanalysis-era5-single-levels",
        {
            "product_type": "reanalysis",
            "format": "netcdf",
            "variable": list(_SINGLE_LEVEL_MAP.keys()),
            "year": years, "month": months, "day": days,
            "time": hours, "area": area,
        },
        str(out.with_suffix(".sl.nc")),
    )
    return out


def _month_range(d0: datetime, d1: datetime) -> list[int]:
    if d0.year == d1.year:
        return list(range(d0.month, d1.month + 1))
    return list(range(1, 13))


# ---------------------------------------------------------------------------
# Dataset construction (lazy xarray)
# ---------------------------------------------------------------------------


def build_dataset(nc_basepath: str, out_path: str) -> tuple[np.ndarray, np.ndarray]:
    """Turn downloaded ERA5 NetCDF into a cached (X, y) training set.

    For each timestamp we:
      1. derive the seeing label from the pressure-level column, and
      2. build a HISTORY_HOURS surface weather history ending at that time and
         run it through ``build_feature_vector``.

    The result is saved as a compressed ``.npz`` with arrays ``X`` and ``y``.
    """
    import xarray as xr  # lazy: only needed for offline prep

    base = Path(nc_basepath)
    pl = xr.open_dataset(base.with_suffix(".pl.nc"))
    sl = xr.open_dataset(base.with_suffix(".sl.nc"))

    # Collapse the small spatial box to its center via mean over lat/lon.
    spatial = [d for d in ("latitude", "longitude") if d in pl.dims]
    pl = pl.mean(dim=spatial) if spatial else pl
    spatial_sl = [d for d in ("latitude", "longitude") if d in sl.dims]
    sl = sl.mean(dim=spatial_sl) if spatial_sl else sl

    times = np.asarray(pl["time"].values)
    levels = np.asarray(pl["level"].values, dtype=float)  # hPa

    # Pre-extract single-level series as plain dicts keyed by timestamp.
    sl_times = np.asarray(sl["time"].values)
    sl_series = {our: np.asarray(sl[era].values).astype(float).ravel()
                 for era, our in _SINGLE_LEVEL_MAP.items() if era in sl}

    X_rows: list[np.ndarray] = []
    y_rows: list[float] = []

    for ti, t in enumerate(times):
        temp = np.asarray(pl["t"].isel(time=ti).values, dtype=float)
        geo = np.asarray(pl["z"].isel(time=ti).values, dtype=float)
        u = np.asarray(pl["u"].isel(time=ti).values, dtype=float)
        v = np.asarray(pl["v"].isel(time=ti).values, dtype=float)
        seeing = derive_seeing(levels, temp, geo, u, v)

        history = _surface_history(sl_times, sl_series, t)
        if not history:
            continue
        X_rows.append(build_feature_vector(history))
        y_rows.append(seeing)

    X = np.asarray(X_rows, dtype=float)
    y = np.asarray(y_rows, dtype=float)
    assert X.shape[1] == N_FEATURES, f"feature width mismatch: {X.shape}"

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, X=X, y=y)
    print(f"Built ERA5 dataset: {X.shape[0]} samples -> {out}")
    return X, y


def _surface_history(sl_times: np.ndarray, sl_series: dict, t_end) -> list[dict]:
    """Build the trailing HISTORY_HOURS surface history ending at ``t_end``."""
    t_end_dt = _to_dt(t_end)
    start_dt = t_end_dt - timedelta(hours=HISTORY_HOURS - 1)
    rows: list[dict] = []
    for i, raw in enumerate(sl_times):
        ts = _to_dt(raw)
        if start_dt <= ts <= t_end_dt:
            row = {"timestamp": ts.isoformat()}
            for key, arr in sl_series.items():
                if i < arr.size:
                    val = arr[i]
                    if key in ("temperature_2m", "dewpoint_2m") and val > 100:
                        val = val - 273.15        # K -> degC
                    if key == "pressure_msl" and val > 2000:
                        val = val / 100.0         # Pa -> hPa
                    if key == "cloud_cover" and val <= 1.0:
                        val = val * 100.0         # fraction -> percent
                    row[key] = float(val)
            rows.append(row)
    return rows


def _to_dt(value) -> datetime:
    dt = value.astype("datetime64[s]").astype(datetime) if isinstance(value, np.datetime64) else value
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return datetime.now(tz=timezone.utc)


def load_dataset(npz_path: str) -> tuple[np.ndarray, np.ndarray]:
    """Load a cached ERA5 (X, y) dataset built by :func:`build_dataset`."""
    data = np.load(npz_path)
    return data["X"], data["y"]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="ERA5 seeing-dataset preparation.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download", help="Download ERA5 NetCDF from CDS.")
    d.add_argument("--lat", type=float, required=True)
    d.add_argument("--lon", type=float, required=True)
    d.add_argument("--start", type=str, required=True, help="YYYY-MM-DD")
    d.add_argument("--end", type=str, required=True, help="YYYY-MM-DD")
    d.add_argument("--out", type=str, required=True, help="base path, e.g. data/era5.nc")

    b = sub.add_parser("build", help="Build a cached (X,y) npz from NetCDF.")
    b.add_argument("--nc", type=str, required=True, help="base path used in download")
    b.add_argument("--out", type=str, required=True, help="output .npz path")

    args = parser.parse_args()
    if args.cmd == "download":
        download_era5(args.lat, args.lon, args.start, args.end, args.out)
    elif args.cmd == "build":
        build_dataset(args.nc, args.out)


if __name__ == "__main__":
    main()
