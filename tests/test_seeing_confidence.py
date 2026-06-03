"""Tests for quantile-based seeing point estimate and dynamic confidence.

Exercises the pure resolver ``_seeing_and_confidence`` directly so no trained
model is required, plus the climatological fallback when no model is loaded.
"""

import asyncio
import math
from datetime import datetime, timedelta, timezone

import numpy as np

from api.pipeline.seeing import (
    CONF_MAX,
    CONF_MIN,
    FALLBACK_CONFIDENCE,
    FALLBACK_FWHM_ARCSEC,
    SeeingPredictor,
    _seeing_and_confidence,
)


def test_quantile_median_is_point_estimate():
    # columns = [P10, P50, P90]
    preds = np.array([[1.0, 1.5, 2.0], [0.8, 1.2, 1.4]])
    seeing, conf = _seeing_and_confidence(preds)
    assert np.allclose(seeing, [1.5, 1.2])


def test_confidence_inverse_of_interval_width():
    # Wide interval -> low confidence; narrow interval -> high confidence.
    wide = np.array([[0.5, 1.5, 3.0]])    # spread 2.5 (>> SPREAD_WIDE) -> CONF_MIN
    narrow = np.array([[1.4, 1.5, 1.6]])  # spread 0.2 (< SPREAD_TIGHT) -> CONF_MAX
    _, c_wide = _seeing_and_confidence(wide)
    _, c_narrow = _seeing_and_confidence(narrow)
    assert c_wide[0] < c_narrow[0]
    assert np.isclose(c_wide[0], CONF_MIN, atol=1e-6)
    assert np.isclose(c_narrow[0], CONF_MAX)


def test_confidence_varies_in_midrange():
    # Realistic model spreads (0.23-0.50 arcsec) must map to DISTINCT,
    # interior confidences -- the old 1/spread map saturated at CONF_MAX here.
    preds = np.array([
        [1.385, 1.5, 1.615],  # spread 0.23 -> ~CONF_MAX
        [1.32, 1.5, 1.68],    # spread 0.36 -> interior
        [1.25, 1.5, 1.75],    # spread 0.50 -> ~CONF_MIN
    ])
    _, conf = _seeing_and_confidence(preds)
    assert conf[0] > conf[1] > conf[2]
    assert CONF_MIN < conf[1] < CONF_MAX  # genuinely interior, not clipped


def test_confidence_clipped_to_bounds():
    preds = np.array([[1.0, 1.5, 1.0001], [0.1, 1.5, 9.0]])
    _, conf = _seeing_and_confidence(preds)
    assert np.all(conf >= CONF_MIN)
    assert np.all(conf <= CONF_MAX)


def test_degenerate_interval_does_not_divide_by_zero():
    preds = np.array([[1.5, 1.5, 1.5]])  # zero spread
    seeing, conf = _seeing_and_confidence(preds)
    assert np.isfinite(conf[0])
    assert conf[0] == CONF_MAX


def test_legacy_point_estimate_model_backward_compat():
    # 1-D output (old reg:squarederror model) -> flat confidence, no crash.
    preds = np.array([1.8, 2.1, 1.9])
    seeing, conf = _seeing_and_confidence(preds)
    assert np.allclose(seeing, preds)
    assert np.all((conf >= CONF_MIN) & (conf <= CONF_MAX))
    assert len(set(np.round(conf, 6))) == 1  # flat


def test_missing_model_falls_back_to_climatology():
    p = SeeingPredictor(model_path="/nonexistent/seeing_model.json")
    assert not p.has_model
    out = p.predict([])
    assert len(out) == 16
    assert out[0]["predicted_seeing_arcsec"] == FALLBACK_FWHM_ARCSEC
    assert out[0]["confidence"] == FALLBACK_CONFIDENCE


# ---------------------------------------------------------------------------
# Pressure-level feature wiring: the live Open-Meteo fetch must populate the
# upper-air profile so wind_shear_850_300 / tropopause_stability are real
# numbers at inference instead of NaN (the multi-site model's top features).
# ---------------------------------------------------------------------------


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Stand-in for httpx.AsyncClient returning a fixed payload."""

    payload: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        return _FakeResp(type(self).payload)


def _open_meteo_payload_with_pressure_levels(anchor: datetime) -> dict:
    """Hourly payload spanning the seeing window, including pressure levels.

    Mirrors Open-Meteo's schema: pressure-level wind is reported as speed +
    direction under the ``_<lvl>hPa`` suffix (no u/v), with temperature too.
    """
    # Cover a few hours before "now" through the end of the session window.
    start = datetime.now(tz=timezone.utc) - timedelta(hours=5)
    times = [int((start + timedelta(hours=h)).timestamp()) for h in range(16)]
    n = len(times)

    def col(value):
        return [value] * n

    hourly = {
        "time": times,
        # Surface fields.
        "temperature_2m": col(14.0),
        "relativehumidity_2m": col(55.0),
        "dewpoint_2m": col(6.0),
        "pressure_msl": col(1014.0),
        "windspeed_10m": col(4.0),
        "winddirection_10m": col(190.0),
        "cloudcover": col(20.0),
    }

    # Distinct upper-air winds so the 850->300 shear is clearly non-zero.
    levels = {
        850: {"speed": 8.0, "dir": 200.0, "temp": 4.0},
        500: {"speed": 22.0, "dir": 250.0, "temp": -14.0},
        300: {"speed": 42.0, "dir": 275.0, "temp": -42.0},
        200: {"speed": 55.0, "dir": 280.0, "temp": -56.0},
    }
    for lvl, vals in levels.items():
        hourly[f"windspeed_{lvl}hPa"] = col(vals["speed"])
        hourly[f"winddirection_{lvl}hPa"] = col(vals["dir"])
        hourly[f"temperature_{lvl}hPa"] = col(vals["temp"])

    return {"hourly": hourly}


def test_pressure_levels_populate_shear_feature(monkeypatch):
    import httpx

    from api import main
    from api.ml.features import feature_dict

    anchor = datetime.now(tz=timezone.utc)
    _FakeAsyncClient.payload = _open_meteo_payload_with_pressure_levels(anchor)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    rows = asyncio.run(main._weather_history_for_seeing(37.43, -122.17, anchor=anchor))

    assert rows, "expected at least one hourly row inside the seeing window"

    # The fetch must have requested the pressure-level variables and parsed
    # them into per-level u/v + temperature keys on each row.
    latest = rows[-1]
    assert "wind_u_850" in latest and latest["wind_u_850"] is not None
    assert "wind_u_300" in latest and latest["wind_u_300"] is not None
    assert latest["temp_500"] is not None and latest["temp_850"] is not None

    feats = feature_dict(rows)
    assert not math.isnan(feats["wind_shear_850_300"])
    assert feats["wind_shear_850_300"] > 0.0
    assert not math.isnan(feats["wind_shear_500_200"])
    assert not math.isnan(feats["tropopause_stability"])
