"""Atmospheric seeing predictor (XGBoost) — inference layer.

Loads a serialized XGBoost model from ``MODEL_PATH`` (env var) and produces
a forecast of FWHM seeing in arcseconds for 16 thirty-minute slots across
the night. When no model is loaded (cold start, dev, or missing artifact)
the predictor returns a climatological fallback so the rest of the planner
keeps working.

Training script lives in ``api/ml/train_xgb.py`` (Step 5 follow-up).
Feature engineering lives in ``api/ml/features.py``.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from ..ml.features import FEATURE_NAMES, N_FEATURES, build_feature_vector


logger = logging.getLogger(__name__)

# Default location of the trained model produced by ``api/ml/train_xgb.py``.
# Used when neither an explicit ``model_path`` nor the ``MODEL_PATH`` env var
# is provided, so the model works out of the box after training.
DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent / "ml" / "models" / "seeing_model.json"


# Climatological prior — used when no model is loaded. 2.0 arcsec is a
# reasonable median for sea-level sites; the LAMOST paper reports median
# seeing around 2.5 arcsec at Xinglong. We bias slightly optimistic; the
# real model will correct downward at good sites.
FALLBACK_FWHM_ARCSEC = 2.0
FALLBACK_CONFIDENCE  = 0.3

# Confidence bounds and interval handling for the quantile model.
CONF_MIN = 0.4
CONF_MAX = 0.95
# Confidence is a linear function of the P10-P90 interval width, anchored to
# the empirical spread distribution of the trained model (Stanford 3yr ERA5:
# p10 ~ 0.23", p90 ~ 0.47"). A tight interval => high confidence; a wide one
# => low. A naive 1/spread map saturated at CONF_MAX because real spreads are
# all well below 1", so the confidence never varied.
SPREAD_TIGHT_ARCSEC = 0.23   # ~p10 of model spread -> CONF_MAX
SPREAD_WIDE_ARCSEC  = 0.50   # ~p90 of model spread -> CONF_MIN
LEGACY_CONFIDENCE = 0.7      # flat confidence for 1-D point models

NUM_SLOTS = 16
SLOT_MINUTES = 30


class SeeingPredictor:
    """Forecast atmospheric seeing across the upcoming night.

    Args:
        model_path: Path to a serialized XGBoost model (``.json`` / ``.ubj``).
            When ``None`` (the default), reads the ``SEEING_MODEL_PATH`` env
            var (the name used by the systemd unit and README), falling back
            to the legacy ``MODEL_PATH``. When both are unset or the file is
            missing, the predictor returns climatological fallback values and
            logs a warning at predict-time.
    """

    def __init__(self, model_path: Optional[str] = None):
        resolved = (
            model_path
            or os.environ.get("SEEING_MODEL_PATH")
            or os.environ.get("MODEL_PATH")
        )
        if not resolved and DEFAULT_MODEL_PATH.exists():
            resolved = str(DEFAULT_MODEL_PATH)
        self.model_path = resolved
        self._model = None
        self._load_error: Optional[str] = None
        self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def has_model(self) -> bool:
        return self._model is not None

    def predict(
        self,
        weather_history: list[dict],
        session_start: Optional[datetime] = None,
    ) -> list[dict]:
        """Predict seeing for ``NUM_SLOTS`` thirty-minute slots.

        Args:
            weather_history: chronologically-ordered weather samples
                covering at least the prior 3h (for the rolling-window
                features) and ideally the upcoming night (for per-slot
                predictions). See ``api/ml/features.py``.
            session_start: anchor time for slot 0. If ``None``, uses the
                timestamp of the most recent weather sample (or "now" UTC
                when the history is empty).

        Returns:
            List of ``NUM_SLOTS`` dicts with keys:
              - ``slot``: ISO timestamp for the start of the slot (UTC)
              - ``predicted_seeing_arcsec``: float
              - ``confidence``: float in [0, 1]
        """
        anchor = _resolve_anchor(weather_history, session_start)

        if not self.has_model:
            self._warn_fallback_once()
            return _fallback_forecast(anchor)

        return self._predict_with_model(weather_history, anchor)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _load(self) -> None:
        if not self.model_path:
            return
        if not os.path.exists(self.model_path):
            self._load_error = f"model file not found: {self.model_path}"
            logger.warning(self._load_error)
            return
        try:
            import xgboost as xgb  # local import: avoid the dep when unused
        except ImportError as exc:
            self._load_error = f"xgboost not installed: {exc}"
            logger.warning(self._load_error)
            return
        try:
            booster = xgb.Booster()
            booster.load_model(self.model_path)
            self._model = booster
            logger.info("Loaded seeing model from %s", self.model_path)
        except Exception as exc:  # corrupted file, version skew, etc.
            self._load_error = f"failed to load seeing model: {exc}"
            logger.exception(self._load_error)

    _fallback_warned = False

    def _warn_fallback_once(self) -> None:
        if not type(self)._fallback_warned:
            logger.warning(
                "SeeingPredictor: no model loaded (%s); using climatological "
                "fallback (%.1f arcsec, confidence %.1f)",
                self._load_error or "SEEING_MODEL_PATH unset",
                FALLBACK_FWHM_ARCSEC, FALLBACK_CONFIDENCE,
            )
            type(self)._fallback_warned = True

    def _predict_with_model(
        self,
        weather_history: list[dict],
        anchor: datetime,
    ) -> list[dict]:
        import xgboost as xgb  # imported here too for the inference call

        # For each slot, the input feature vector is built from the history
        # window ending at (anchor + k * SLOT_MINUTES). We expect the caller
        # to have stitched the hourly forecast onto the historical window;
        # if the history doesn't extend that far we still run on whatever
        # tail we have (XGBoost handles NaN natively).
        features = np.zeros((NUM_SLOTS, N_FEATURES), dtype=float)
        slot_times: list[datetime] = []
        for i in range(NUM_SLOTS):
            slot_time = anchor + timedelta(minutes=i * SLOT_MINUTES)
            slot_times.append(slot_time)
            window = _history_up_to(weather_history, slot_time)
            features[i] = build_feature_vector(window)

        # Feature names must match those baked into the model at train time.
        dmatrix = xgb.DMatrix(features, feature_names=list(FEATURE_NAMES))
        preds = self._model.predict(dmatrix)

        seeing, confidence = _seeing_and_confidence(preds)

        return [
            {
                "slot": slot_times[i].isoformat(),
                "predicted_seeing_arcsec": float(seeing[i]),
                "confidence": float(confidence[i]),
            }
            for i in range(NUM_SLOTS)
        ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_anchor(
    weather_history: list[dict],
    session_start: Optional[datetime],
) -> datetime:
    if session_start is not None:
        return session_start if session_start.tzinfo else session_start.replace(tzinfo=timezone.utc)
    if weather_history:
        ts = weather_history[-1].get("timestamp")
        if isinstance(ts, datetime):
            return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        if isinstance(ts, str):
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
    return datetime.now(tz=timezone.utc)


def _history_up_to(weather_history: list[dict], cutoff: datetime) -> list[dict]:
    """Trim the history to samples at or before ``cutoff``."""
    if not weather_history:
        return []
    out: list[dict] = []
    for s in weather_history:
        ts = s.get("timestamp")
        if isinstance(ts, str):
            try:
                ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                continue
            ts_dt = ts_dt if ts_dt.tzinfo else ts_dt.replace(tzinfo=timezone.utc)
        elif isinstance(ts, datetime):
            ts_dt = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        else:
            continue
        if ts_dt <= cutoff:
            out.append(s)
    return out


def _fallback_forecast(anchor: datetime) -> list[dict]:
    return [
        {
            "slot": (anchor + timedelta(minutes=i * SLOT_MINUTES)).isoformat(),
            "predicted_seeing_arcsec": FALLBACK_FWHM_ARCSEC,
            "confidence": FALLBACK_CONFIDENCE,
        }
        for i in range(NUM_SLOTS)
    ]


def _seeing_and_confidence(preds: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Resolve point-estimate seeing and per-slot confidence from raw model output.

    Two model shapes are supported for backward compatibility:

      * Quantile model (preferred): ``preds`` is (N, 3) for the P10/P50/P90
        columns. The point estimate is the median; confidence is a linear
        function of the 80% interval width, anchored to the model's empirical
        spread range so it actually varies across slots:

            t = (spread - SPREAD_TIGHT) / (SPREAD_WIDE - SPREAD_TIGHT)
            confidence = clip(CONF_MAX - t * (CONF_MAX - CONF_MIN),
                              CONF_MIN, CONF_MAX)

      * Legacy point-estimate model: ``preds`` is 1-D. We return it directly
        with a flat mid-band confidence, since no interval is available.
    """
    preds = np.asarray(preds, dtype=float)
    if preds.ndim == 2 and preds.shape[1] >= 3:
        p10 = preds[:, 0]
        p50 = preds[:, 1]
        p90 = preds[:, 2]
        # Clip quantile crossing, then map interval width -> confidence
        # linearly between the empirical tight/wide reference spreads.
        spread = np.maximum(p90 - p10, 0.0)
        denom = SPREAD_WIDE_ARCSEC - SPREAD_TIGHT_ARCSEC
        t = (spread - SPREAD_TIGHT_ARCSEC) / denom
        confidence = np.clip(CONF_MAX - t * (CONF_MAX - CONF_MIN), CONF_MIN, CONF_MAX)
        return p50, confidence

    seeing = preds.ravel()
    confidence = np.clip(np.full_like(seeing, LEGACY_CONFIDENCE), CONF_MIN, CONF_MAX)
    return seeing, confidence
