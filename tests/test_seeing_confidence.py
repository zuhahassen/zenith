"""Tests for quantile-based seeing point estimate and dynamic confidence.

Exercises the pure resolver ``_seeing_and_confidence`` directly so no trained
model is required, plus the climatological fallback when no model is loaded.
"""

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
    wide = np.array([[0.5, 1.5, 3.0]])    # spread 2.5 -> 1/2.5 = 0.4
    narrow = np.array([[1.4, 1.5, 1.6]])  # spread 0.2 -> 1/0.2 = 5 -> clipped
    _, c_wide = _seeing_and_confidence(wide)
    _, c_narrow = _seeing_and_confidence(narrow)
    assert c_wide[0] < c_narrow[0]
    assert np.isclose(c_wide[0], 0.4, atol=1e-6)
    assert np.isclose(c_narrow[0], CONF_MAX)


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
