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

# ERA5 pressure levels to request (hPa). Trimmed to a representative profile
# that still resolves the boundary layer, free troposphere, and the
# jet/tropopause region where optical turbulence peaks, while keeping each CDS
# request under the per-request cost cap.
PRESSURE_LEVELS = [
    1000, 850, 700, 500, 300, 250, 200, 150, 100,
]

# ERA5 single-level (request) variable name -> our weather-history key.
_SINGLE_LEVEL_MAP = {
    "2m_temperature": "temperature_2m",
    "2m_dewpoint_temperature": "dewpoint_2m",
    "mean_sea_level_pressure": "pressure_msl",
    "10m_u_component_of_wind": "wind_u_10m",
    "10m_v_component_of_wind": "wind_v_10m",
    "total_cloud_cover": "cloud_cover",
}

# The single-levels-timeseries product returns short ERA5 codes in its NetCDF;
# map those to our weather-history keys. Unit conversions (K->C, Pa->hPa,
# fraction->percent) are applied in ``_surface_history``.
_TS_SHORT_MAP = {
    "t2m": "temperature_2m",
    "d2m": "dewpoint_2m",
    "msl": "pressure_msl",
    "u10": "wind_u_10m",
    "v10": "wind_v_10m",
    "tcc": "cloud_cover",
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
    skip_existing: bool = True,
    pressure_hours: Optional[list[str]] = None,
    months_per_chunk: int = 3,
) -> Path:
    """Download ERA5 surface + pressure-level fields for a single point.

    The pressure-levels dataset enforces a per-request cost cap, so the
    multi-year profile pull is chunked into <=``months_per_chunk``-month blocks
    sampled only at a few nighttime ``pressure_hours`` (the seeing label is only
    needed then). Surface fields are pulled hourly from the fast ARCO
    single-levels *timeseries* dataset, which serves a whole multi-year point
    series in one request.

    Files written alongside ``out_path`` (stem = ``out.stem``):
        <stem>.surface.<YYYY>.nc     hourly surface timeseries (per year)
        <stem>.<YYYY>q<MM>.pl.nc     pressure-level profiles (per chunk)

    Existing files are skipped so an interrupted harvest resumes. Requires a
    configured ``~/.cdsapirc``.
    """
    import cdsapi  # lazy: only needed for live download

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    d0 = datetime.fromisoformat(start)
    d1 = datetime.fromisoformat(end)
    if pressure_hours is None:
        pressure_hours = ["06:00", "12:00"]

    client = cdsapi.Client()
    _download_surface_timeseries(client, lat, lon, d0, d1, out, skip_existing=skip_existing)
    _download_pressure_levels(client, lat, lon, d0, d1, out, pressure_hours,
                              half_box_deg=half_box_deg, months_per_chunk=months_per_chunk,
                              skip_existing=skip_existing)
    return out


def _download_surface_timeseries(client, lat, lon, d0, d1, out, *, skip_existing=True):
    """Fetch hourly surface fields per year from the ARCO timeseries dataset.

    The timeseries endpoint returns a zip wrapping a single NetCDF; we extract
    the inner file to ``<stem>.surface.<YYYY>.nc``.
    """
    import zipfile

    for year in range(d0.year, d1.year + 1):
        y_start = max(d0, datetime(year, 1, 1)).date().isoformat()
        y_end = min(d1, datetime(year, 12, 31)).date().isoformat()
        nc_file = out.with_name(f"{out.stem}.surface.{year}.nc")
        print(f"[surface {year}] {y_start}..{y_end} (exists={nc_file.exists()})", flush=True)
        if skip_existing and nc_file.exists():
            continue
        zip_tmp = out.with_name(f"{out.stem}.surface.{year}.zip")
        client.retrieve(
            "reanalysis-era5-single-levels-timeseries",
            {
                "variable": list(_SINGLE_LEVEL_MAP.keys()),
                "location": {"latitude": lat, "longitude": lon},
                "date": [f"{y_start}/{y_end}"],
                "data_format": "netcdf",
            },
            str(zip_tmp),
        )
        with zipfile.ZipFile(zip_tmp) as z:
            inner = z.namelist()[0]
            with z.open(inner) as src, open(nc_file, "wb") as dst:
                dst.write(src.read())
        zip_tmp.unlink()


def _download_pressure_levels(client, lat, lon, d0, d1, out, hours, *,
                              half_box_deg=0.5, months_per_chunk=3, skip_existing=True):
    """Fetch pressure-level profiles in <=months_per_chunk-month synoptic chunks."""
    area = [lat + half_box_deg, lon - half_box_deg,
            lat - half_box_deg, lon + half_box_deg]  # N, W, S, E
    chunks = list(_month_chunks(d0, d1, months_per_chunk))
    for idx, (year, months) in enumerate(chunks, start=1):
        tag = f"{year}q{months[0]:02d}"
        pl_file = out.with_name(f"{out.stem}.{tag}.pl.nc")
        print(f"[pl {idx}/{len(chunks)}] {year} months {months[0]}-{months[-1]} "
              f"hours={hours} (exists={pl_file.exists()})", flush=True)
        if skip_existing and pl_file.exists():
            continue
        client.retrieve(
            "reanalysis-era5-pressure-levels",
            {
                "product_type": "reanalysis",
                "data_format": "netcdf",
                "download_format": "unarchived",
                "variable": ["temperature", "geopotential",
                             "u_component_of_wind", "v_component_of_wind"],
                "pressure_level": [str(p) for p in PRESSURE_LEVELS],
                "year": [str(year)],
                "month": [f"{m:02d}" for m in months],
                "day": [f"{d:02d}" for d in range(1, 32)],
                "time": hours, "area": area,
            },
            str(pl_file),
        )


def _month_chunks(d0: datetime, d1: datetime, size: int):
    """Yield (year, [months]) blocks of up to ``size`` months within each year."""
    for year in range(d0.year, d1.year + 1):
        lo = d0.month if year == d0.year else 1
        hi = d1.month if year == d1.year else 12
        m = lo
        while m <= hi:
            yield year, list(range(m, min(m + size, hi + 1)))
            m += size


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
    base = Path(nc_basepath)

    sl_times, sl_series = _load_surface_series(base)
    if sl_times.size == 0:
        raise FileNotFoundError(f"No surface timeseries (*.surface.*.nc) found for base {base}")

    pl_files = sorted(base.parent.glob(f"{base.stem}.*.pl.nc"))
    if not pl_files:
        raise FileNotFoundError(f"No ERA5 pressure-level NetCDF found for base {base}")

    X_rows: list[np.ndarray] = []
    y_rows: list[float] = []
    for pl_file in pl_files:
        rows, labels = _process_pressure_file(pl_file, sl_times, sl_series)
        X_rows.extend(rows)
        y_rows.extend(labels)
        print(f"  {pl_file.name}: +{len(rows)} samples (total {len(X_rows)})", flush=True)

    X = np.asarray(X_rows, dtype=float)
    y = np.asarray(y_rows, dtype=float)
    assert X.ndim == 2 and X.shape[1] == N_FEATURES, f"feature width mismatch: {X.shape}"

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, X=X, y=y)
    print(f"Built ERA5 dataset: {X.shape[0]} samples -> {out}")
    return X, y


def _resolve_dim(ds, candidates: tuple[str, ...]) -> str:
    """Return the first candidate that is a dim/coord of ``ds`` (CDS naming varies)."""
    for name in candidates:
        if name in ds.dims or name in ds.coords:
            return name
    raise KeyError(f"none of {candidates} found in dataset (have {list(ds.dims)})")


def _load_surface_series(base: Path) -> tuple[np.ndarray, dict]:
    """Concatenate the per-year surface timeseries into one time-sorted series.

    The timeseries NetCDF uses ERA5 short variable names (``t2m``, ``d2m`` ...),
    which we remap to our weather-history keys; unit conversions are handled
    downstream in ``_surface_history``.
    """
    import xarray as xr  # lazy: only needed for offline prep

    files = sorted(base.parent.glob(f"{base.stem}.surface.*.nc"))
    time_parts: list[np.ndarray] = []
    col_parts: dict[str, list[np.ndarray]] = {our: [] for our in _TS_SHORT_MAP.values()}
    for f in files:
        ds = xr.open_dataset(f)
        tname = _resolve_dim(ds, ("valid_time", "time"))
        time_parts.append(np.asarray(ds[tname].values))
        for short, our in _TS_SHORT_MAP.items():
            if short in ds:
                col_parts[our].append(np.asarray(ds[short].values, dtype=float).ravel())
        ds.close()

    if not time_parts:
        return np.array([]), {}

    sl_times = np.concatenate(time_parts)
    order = np.argsort(sl_times)
    sl_times = sl_times[order]
    sl_series = {our: np.concatenate(parts)[order]
                 for our, parts in col_parts.items() if parts}
    return sl_times, sl_series


def _process_pressure_file(pl_file: Path, sl_times: np.ndarray,
                           sl_series: dict) -> tuple[list[np.ndarray], list[float]]:
    """Derive (feature rows, seeing labels) for every profile in one pl file."""
    import xarray as xr  # lazy: only needed for offline prep

    pl = xr.open_dataset(pl_file)
    spatial = [d for d in ("latitude", "longitude") if d in pl.dims]
    if spatial:
        pl = pl.mean(dim=spatial)

    pl_time = _resolve_dim(pl, ("valid_time", "time"))
    level_dim = _resolve_dim(pl, ("pressure_level", "level"))
    times = np.asarray(pl[pl_time].values)
    levels = np.asarray(pl[level_dim].values, dtype=float)  # hPa

    # Map each requested standard level (hPa) to its index in the profile so
    # the pressure-level features can be read off by name.
    level_idx = {int(round(lv)): i for i, lv in enumerate(levels)}

    def _at(level: int, arr: np.ndarray) -> float:
        i = level_idx.get(level)
        return float(arr[i]) if i is not None and i < arr.size else float("nan")

    rows: list[np.ndarray] = []
    labels: list[float] = []
    for ti, t in enumerate(times):
        temp = np.asarray(pl["t"].isel({pl_time: ti}).values, dtype=float)
        geo = np.asarray(pl["z"].isel({pl_time: ti}).values, dtype=float)
        u = np.asarray(pl["u"].isel({pl_time: ti}).values, dtype=float)
        v = np.asarray(pl["v"].isel({pl_time: ti}).values, dtype=float)
        seeing = derive_seeing(levels, temp, geo, u, v)

        history = _surface_history(sl_times, sl_series, t)
        if not history:
            continue
        # Attach upper-air structure to the profile-time sample so
        # features.build_feature_vector can compute the pressure-level shear
        # and stability features. Temperatures stay in kelvin; the stability
        # feature is a difference, so the K/degC offset cancels.
        last = history[-1]
        for lv in (850, 300, 500, 200):
            last[f"wind_u_{lv}"] = _at(lv, u)
            last[f"wind_v_{lv}"] = _at(lv, v)
        last["temp_850"] = _at(850, temp)
        last["temp_500"] = _at(500, temp)

        rows.append(build_feature_vector(history))
        labels.append(seeing)

    pl.close()
    return rows, labels


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
