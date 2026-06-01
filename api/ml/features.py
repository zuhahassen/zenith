"""Feature engineering for the data-driven seeing predictor.

The feature set follows the Ni et al. (2022) LAMOST paper on data-driven
atmospheric seeing prediction, adapted to the variables Open-Meteo gives
us for free at any global location.

Inputs are a chronologically-ordered list of weather samples (one dict
per timestep). The function returns a single feature vector for the
most recent sample, with trailing-window statistics computed against the
prior samples in the history.

A predictor that needs 16 thirty-minute slots across the night will slide
this function across its forecast: see api/pipeline/seeing.py (Step 6).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np


# ---------------------------------------------------------------------------
# Feature schema
# ---------------------------------------------------------------------------
# The order of this tuple defines the column order of the returned vector
# and is the contract the XGBoost model is trained against. Do not reorder
# without retraining.
FEATURE_NAMES: tuple[str, ...] = (
    # Instantaneous state
    "temp",
    "dewpoint_depression",
    "pressure",
    "wind_speed",
    "wind_dir_sin",
    "wind_dir_cos",
    "cloud_fraction",
    # Rolling temperature stats
    "temp_mean_30m",
    "temp_std_30m",
    "temp_mean_1h",
    "temp_std_1h",
    "temp_mean_3h",
    "temp_std_3h",
    # Rolling humidity stats
    "humidity_mean_30m",
    "humidity_std_30m",
    "humidity_mean_1h",
    "humidity_std_1h",
    "humidity_mean_3h",
    "humidity_std_3h",
    # Wind dynamics
    "wind_speed_delta_30m",
    # Diurnal / seasonal cycles (cyclic encoding so the model sees
    # 23:00 and 00:00 as neighbours)
    "hour_of_night_sin",
    "hour_of_night_cos",
    "day_of_year_sin",
    "day_of_year_cos",
)

N_FEATURES = len(FEATURE_NAMES)

# Rolling window lengths in minutes.
WINDOW_MINUTES = {"30m": 30, "1h": 60, "3h": 180}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_feature_vector(weather_history: list[dict]) -> np.ndarray:
    """Build a single feature vector for the most-recent sample in the history.

    Args:
        weather_history: chronologically-ordered list of dicts. Each dict
            may contain (Open-Meteo field names where possible):

              - ``timestamp``: ISO 8601 str or ``datetime`` (UTC assumed if naive)
              - ``temperature_2m``: float, °C
              - ``dewpoint_2m``: float, °C (optional; derived from RH+T if absent)
              - ``relative_humidity_2m``: float, % (0-100)
              - ``pressure_msl``: float, hPa
              - ``wind_u_10m`` / ``wind_v_10m``: float, m/s (preferred)
              - ``wind_speed_10m``: float, m/s   (fallback)
              - ``wind_direction_10m``: float, ° (meteorological, fallback)
              - ``cloud_cover``: float, % (0-100)

    Returns:
        np.ndarray of shape (``N_FEATURES``,). Missing inputs become ``nan``;
        XGBoost handles ``nan`` natively at inference.
    """
    if not weather_history:
        return np.full(N_FEATURES, np.nan, dtype=float)

    # Defensive copy + sort by timestamp so callers don't have to.
    samples = sorted(weather_history, key=lambda s: _parse_ts(s.get("timestamp")))
    current = samples[-1]
    t_now = _parse_ts(current.get("timestamp"))

    # --- instantaneous ----------------------------------------------------
    temp = _f(current.get("temperature_2m"))
    dewpoint = _resolve_dewpoint(current)
    dewpoint_depression = temp - dewpoint if (not _isnan(temp) and not _isnan(dewpoint)) else np.nan

    pressure = _f(current.get("pressure_msl") or current.get("surface_pressure"))
    wind_speed, wind_sin, wind_cos = _resolve_wind(current)
    cloud_fraction = _normalize_cloud(current.get("cloud_cover"))

    # --- rolling stats ----------------------------------------------------
    temps = _series(samples, "temperature_2m")
    humidities = _series(samples, "relative_humidity_2m")
    timestamps = np.array([_parse_ts(s.get("timestamp")) for s in samples])

    temp_30m_mean, temp_30m_std = _rolling_stats(timestamps, temps, t_now, 30)
    temp_1h_mean,  temp_1h_std  = _rolling_stats(timestamps, temps, t_now, 60)
    temp_3h_mean,  temp_3h_std  = _rolling_stats(timestamps, temps, t_now, 180)

    hum_30m_mean, hum_30m_std = _rolling_stats(timestamps, humidities, t_now, 30)
    hum_1h_mean,  hum_1h_std  = _rolling_stats(timestamps, humidities, t_now, 60)
    hum_3h_mean,  hum_3h_std  = _rolling_stats(timestamps, humidities, t_now, 180)

    # --- wind dynamics ----------------------------------------------------
    wind_speeds = _series(samples, "_resolved_wind_speed", fallback=None)
    if np.all(np.isnan(wind_speeds)):
        # Resolve on the fly if the caller didn't pre-compute.
        wind_speeds = np.array([_resolve_wind(s)[0] for s in samples], dtype=float)
    wind_delta_30m = _delta_over_window(timestamps, wind_speeds, t_now, 30)

    # --- cyclic encodings -------------------------------------------------
    hour_sin, hour_cos = _cyclic_encode(_hour_of_night(t_now), period=24.0)
    doy_sin, doy_cos   = _cyclic_encode(_day_of_year(t_now), period=365.25)

    vec = np.array([
        temp,
        dewpoint_depression,
        pressure,
        wind_speed,
        wind_sin,
        wind_cos,
        cloud_fraction,
        temp_30m_mean, temp_30m_std,
        temp_1h_mean,  temp_1h_std,
        temp_3h_mean,  temp_3h_std,
        hum_30m_mean,  hum_30m_std,
        hum_1h_mean,   hum_1h_std,
        hum_3h_mean,   hum_3h_std,
        wind_delta_30m,
        hour_sin, hour_cos,
        doy_sin,  doy_cos,
    ], dtype=float)

    assert vec.shape == (N_FEATURES,), f"feature vector shape mismatch: {vec.shape}"
    return vec


def feature_dict(weather_history: list[dict]) -> dict[str, float]:
    """Same as :func:`build_feature_vector` but returns a name→value dict.
    Useful for logging, debugging, and the D1 ``weather_logs`` table."""
    vec = build_feature_vector(weather_history)
    return {name: float(v) for name, v in zip(FEATURE_NAMES, vec)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _f(value: Any) -> float:
    """Coerce to float; non-numeric / None → NaN."""
    if value is None:
        return np.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return np.nan


def _isnan(x: float) -> bool:
    return isinstance(x, float) and math.isnan(x)


def _series(samples: list[dict], key: str, fallback: Any = np.nan) -> np.ndarray:
    return np.array([_f(s.get(key, fallback)) for s in samples], dtype=float)


def _parse_ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        # Open-Meteo returns 'YYYY-MM-DDTHH:MM' (no timezone). Treat as UTC.
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(tz=timezone.utc)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return datetime.now(tz=timezone.utc)


def _resolve_dewpoint(sample: dict) -> float:
    dp = sample.get("dewpoint_2m") or sample.get("dew_point_2m")
    if dp is not None:
        return _f(dp)
    # Derive via Magnus formula from temperature + relative humidity.
    t = _f(sample.get("temperature_2m"))
    rh = _f(sample.get("relative_humidity_2m"))
    if _isnan(t) or _isnan(rh) or rh <= 0:
        return np.nan
    a, b = 17.625, 243.04
    gamma = math.log(rh / 100.0) + (a * t) / (b + t)
    return (b * gamma) / (a - gamma)


def _resolve_wind(sample: dict) -> tuple[float, float, float]:
    """Return (speed_m_s, dir_sin, dir_cos). Prefers u/v components."""
    u = sample.get("wind_u_10m")
    v = sample.get("wind_v_10m")
    if u is not None and v is not None:
        u, v = _f(u), _f(v)
        speed = math.hypot(u, v) if not (_isnan(u) or _isnan(v)) else np.nan
        if _isnan(speed) or speed == 0:
            return speed, np.nan, np.nan
        # Meteorological convention: direction the wind is coming FROM.
        theta = math.atan2(-u, -v)
        return speed, math.sin(theta), math.cos(theta)

    speed = _f(sample.get("wind_speed_10m"))
    direction = _f(sample.get("wind_direction_10m"))
    if _isnan(speed):
        return np.nan, np.nan, np.nan
    if _isnan(direction):
        return speed, np.nan, np.nan
    theta = math.radians(direction)
    return speed, math.sin(theta), math.cos(theta)


def _normalize_cloud(value: Any) -> float:
    """Open-Meteo reports cloud_cover as a 0-100 percentage; return 0-1."""
    f = _f(value)
    if _isnan(f):
        return np.nan
    if f > 1.0:
        f = f / 100.0
    return float(min(max(f, 0.0), 1.0))


def _rolling_stats(
    timestamps: np.ndarray,
    values: np.ndarray,
    now: datetime,
    window_minutes: int,
) -> tuple[float, float]:
    """Mean and std over the trailing ``window_minutes`` ending at ``now``."""
    if len(values) == 0:
        return np.nan, np.nan
    cutoff_seconds = window_minutes * 60
    deltas = np.array([(now - t).total_seconds() for t in timestamps])
    mask = (deltas >= 0) & (deltas <= cutoff_seconds)
    selected = values[mask]
    selected = selected[~np.isnan(selected)]
    if selected.size == 0:
        return np.nan, np.nan
    if selected.size == 1:
        return float(selected[0]), 0.0
    return float(np.mean(selected)), float(np.std(selected, ddof=0))


def _delta_over_window(
    timestamps: np.ndarray,
    values: np.ndarray,
    now: datetime,
    window_minutes: int,
) -> float:
    """current - value at (now - window_minutes). NaN-safe."""
    if len(values) == 0 or np.isnan(values[-1]):
        return np.nan
    target_time = now.timestamp() - window_minutes * 60
    seconds = np.array([t.timestamp() for t in timestamps])
    # Closest sample at or before the target time.
    earlier = np.where(seconds <= target_time)[0]
    if earlier.size == 0:
        return np.nan
    past = values[earlier[-1]]
    if np.isnan(past):
        return np.nan
    return float(values[-1] - past)


def _cyclic_encode(value: float, period: float) -> tuple[float, float]:
    if _isnan(value):
        return np.nan, np.nan
    theta = 2.0 * math.pi * (value % period) / period
    return math.sin(theta), math.cos(theta)


def _hour_of_night(t: datetime) -> float:
    """Hours since the previous local-noon, modulo 24. Sunset-anchored is
    nicer but requires a sun-altitude calc per sample; UTC hour cycled by
    24 captures the diurnal signal well enough for a tree-based model.

    Returns a float in [0, 24)."""
    return (t.hour + t.minute / 60.0 + t.second / 3600.0) % 24.0


def _day_of_year(t: datetime) -> float:
    return float(t.timetuple().tm_yday)
