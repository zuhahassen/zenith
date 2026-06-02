"""Train the XGBoost atmospheric-seeing predictor.

Bootstrap phase: we don't have ERA5 reanalysis wired up yet, so this script
trains on *synthetic* weather histories whose seeing targets are generated
from physically-motivated relationships drawn from the Ni et al. (2022)
LAMOST data-driven seeing paper:

    - higher wind speed                  -> worse seeing (larger FWHM)
    - larger short-term temp variability -> worse seeing
    - smaller dewpoint depression        -> worse seeing
    - higher cloud fraction              -> worse seeing

The marginal seeing distribution is anchored to a log-normal with mean
1.8 arcsec / std 0.6 arcsec (clipped to [0.5, 5.0]), then perturbed by the
weather drivers above plus Gaussian noise so the model has a real signal to
learn. Everything is seeded (42) for reproducibility.

Run (synthetic, default):
    python -m api.ml.train_xgb
    python -m api.ml.train_xgb --output /tmp/seeing_model.json
    python -m api.ml.train_xgb --n-samples 20000

Run (ERA5 reanalysis): first build a cache with api/ml/era5.py, then:
    python -m api.ml.era5 download --lat 31.96 --lon -111.6 \
        --start 2023-01-01 --end 2023-03-31 --out data/era5.nc
    python -m api.ml.era5 build --nc data/era5.nc --out data/era5.npz
    python -m api.ml.train_xgb --source era5 --era5-cache data/era5.npz

The ERA5 path derives the seeing label from the optical-turbulence profile of
the reanalysis pressure levels (Cn^2 integral -> Fried parameter -> FWHM); see
api/ml/era5.py for the physics.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from .features import FEATURE_NAMES, N_FEATURES, build_feature_vector


SEED = 42
N_SAMPLES = 10_000
HISTORY_HOURS = 12  # hourly readings per sample

# Target seeing log-normal anchor (arcsec).
SEEING_MEAN = 1.8
SEEING_STD = 0.6
SEEING_CLIP = (0.5, 5.0)

# Seeing is generated on a latent log scale so that the marginal stays
# log-normal (mean 1.8 / std 0.6) while remaining genuinely driven by the
# weather. Each driver enters as a standardized latent with the sign the
# LAMOST paper reports; DRIVER_WEIGHT controls how much of the total
# variance the four drivers explain (the rest is irreducible noise),
# setting the R^2 ceiling.
DRIVER_WEIGHT = 0.45    # per standardized driver (4 drivers)
# noise weight chosen so total latent variance == 1 (drivers + noise).
NOISE_WEIGHT = float(np.sqrt(max(1.0 - 4.0 * DRIVER_WEIGHT**2, 0.0)))

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "models" / "seeing_model.json"


# ---------------------------------------------------------------------------
# Synthetic data generation
# ---------------------------------------------------------------------------


def _lognormal_params(mean: float, std: float) -> tuple[float, float]:
    """Underlying normal (mu, sigma) for a log-normal with given mean/std."""
    var = std**2
    phi = 1.0 + var / mean**2
    sigma = float(np.sqrt(np.log(phi)))
    mu = float(np.log(mean) - 0.5 * sigma**2)
    return mu, sigma


def generate_synthetic_dataset(
    n_samples: int = N_SAMPLES,
    seed: int = SEED,
) -> tuple[np.ndarray, np.ndarray]:
    """Generate (X, y) for training.

    Each sample is a ``HISTORY_HOURS``-long hourly weather history passed
    through :func:`build_feature_vector`. The target ``y`` is the seeing
    (arcsec) at the most-recent timestamp.

    Returns:
        X: (n_samples, N_FEATURES) feature matrix.
        y: (n_samples,) seeing targets in arcsec.
    """
    rng = np.random.default_rng(seed)
    mu, sigma = _lognormal_params(SEEING_MEAN, SEEING_STD)

    X = np.empty((n_samples, N_FEATURES), dtype=float)
    y = np.empty(n_samples, dtype=float)

    base_time = datetime(2024, 1, 1, tzinfo=timezone.utc)

    for i in range(n_samples):
        # --- standardized latent drivers (N(0,1)) ------------------------
        z_wind = float(rng.normal())       # higher -> more wind -> worse
        z_tempvar = float(rng.normal())    # higher -> more temp swing -> worse
        z_cloud = float(rng.normal())      # higher -> more cloud -> worse
        z_dewdep = float(rng.normal())     # higher -> drier -> BETTER (neg sign)
        z_noise = float(rng.normal())      # irreducible

        # Map latents to physical weather values so the feature builder
        # recovers the same signal the target is generated from.
        mean_wind = float(np.clip(5.0 + 3.0 * z_wind, 0.0, None))            # m/s
        temp_variability = float(np.clip(1.2 + 0.6 * z_tempvar, 0.05, None))  # °C std
        dewpoint_depression = float(np.clip(6.0 + 3.0 * z_dewdep, 0.0, None))  # °C
        cloud_fraction = float(np.clip(0.35 + 0.18 * z_cloud, 0.0, 1.0))

        mean_temp = float(rng.normal(10.0, 8.0))
        mean_rh = float(np.clip(rng.normal(60.0, 20.0), 5.0, 100.0))
        mean_pressure = float(rng.normal(1013.0, 8.0))
        prevailing_dir = float(rng.uniform(0.0, 360.0))

        # Random night-time anchor (spread across the year & hours).
        day_offset = int(rng.integers(0, 365))
        hour_anchor = int(rng.integers(18, 30)) % 24  # evening/night bias
        end_time = base_time + timedelta(days=day_offset, hours=hour_anchor)

        history = _build_history(
            rng,
            end_time=end_time,
            mean_temp=mean_temp,
            temp_variability=temp_variability,
            mean_rh=mean_rh,
            dewpoint_depression=dewpoint_depression,
            mean_pressure=mean_pressure,
            mean_wind=mean_wind,
            prevailing_dir=prevailing_dir,
            cloud_fraction=cloud_fraction,
        )

        # --- target seeing -----------------------------------------------
        # Latent log-scale combination keeps the marginal log-normal while
        # making the drivers explain ~(4*DRIVER_WEIGHT^2) of the variance.
        lp = DRIVER_WEIGHT * (z_wind + z_tempvar + z_cloud - z_dewdep)
        lp += NOISE_WEIGHT * z_noise
        seeing = float(np.exp(mu + sigma * lp))
        seeing = float(np.clip(seeing, *SEEING_CLIP))

        X[i] = build_feature_vector(history)
        y[i] = seeing

    return X, y


def _build_history(
    rng: np.random.Generator,
    *,
    end_time: datetime,
    mean_temp: float,
    temp_variability: float,
    mean_rh: float,
    dewpoint_depression: float,
    mean_pressure: float,
    mean_wind: float,
    prevailing_dir: float,
    cloud_fraction: float,
) -> list[dict]:
    """Build one ``HISTORY_HOURS``-long hourly weather history."""
    rows: list[dict] = []
    for h in range(HISTORY_HOURS):
        ts = end_time - timedelta(hours=(HISTORY_HOURS - 1 - h))

        temp = mean_temp + float(rng.normal(0.0, temp_variability))
        rh = float(np.clip(mean_rh + rng.normal(0.0, 5.0), 5.0, 100.0))
        dewpoint = temp - max(dewpoint_depression + float(rng.normal(0.0, 1.0)), 0.0)
        pressure = mean_pressure + float(rng.normal(0.0, 1.5))
        wind = max(mean_wind + float(rng.normal(0.0, 1.0)), 0.0)
        direction = (prevailing_dir + float(rng.normal(0.0, 15.0))) % 360.0
        rad = np.radians(direction)
        u = -wind * float(np.sin(rad))
        v = -wind * float(np.cos(rad))
        cloud = float(np.clip(cloud_fraction * 100.0 + rng.normal(0.0, 8.0), 0.0, 100.0))

        rows.append({
            "timestamp": ts.isoformat(),
            "temperature_2m": temp,
            "relative_humidity_2m": rh,
            "dewpoint_2m": dewpoint,
            "pressure_msl": pressure,
            "wind_speed_10m": wind,
            "wind_direction_10m": direction,
            "wind_u_10m": u,
            "wind_v_10m": v,
            "cloud_cover": cloud,
        })
    return rows


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    err = y_pred - y_true
    mae = float(np.mean(np.abs(err)))
    rmse = float(np.sqrt(np.mean(err**2)))
    ss_res = float(np.sum(err**2))
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return {"mae": mae, "rmse": rmse, "r2": r2}


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def _load_dataset(
    source: str,
    n_samples: int,
    seed: int,
    era5_cache: Optional[str],
) -> tuple[np.ndarray, np.ndarray]:
    """Return (X, y) from either the synthetic generator or an ERA5 cache."""
    if source == "era5":
        if not era5_cache:
            raise SystemExit("--source era5 requires --era5-cache PATH (see api/ml/era5.py)")
        from .era5 import load_dataset
        print(f"Loading ERA5 dataset from {era5_cache} ...")
        X, y = load_dataset(era5_cache)
        print(f"Loaded {len(X)} ERA5 samples.")
        return X, y
    print(f"Generating {n_samples} synthetic samples (seed={seed})...")
    return generate_synthetic_dataset(n_samples=n_samples, seed=seed)


def train(
    output_path: Path = DEFAULT_MODEL_PATH,
    n_samples: int = N_SAMPLES,
    seed: int = SEED,
    source: str = "synthetic",
    era5_cache: Optional[str] = None,
) -> dict[str, float]:
    import xgboost as xgb

    X, y = _load_dataset(source, n_samples, seed, era5_cache)

    # Chronological 80/20 split (no shuffle): the synthetic samples are
    # generated independently, but we honor the contract for when this is
    # swapped for a real time-ordered ERA5 dataset.
    split = int(0.8 * len(X))
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    print(f"Train: {len(X_train)}  Val: {len(X_val)}  Features: {N_FEATURES}")

    # Native Booster API (no scikit-learn dependency). Feature names are
    # attached so xgb.plot_importance() in the EDA notebook is readable.
    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=list(FEATURE_NAMES))
    dval = xgb.DMatrix(X_val, label=y_val, feature_names=list(FEATURE_NAMES))

    params = {
        "max_depth": 5,
        "eta": 0.05,             # learning_rate
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "objective": "reg:squarederror",
        "seed": seed,
    }
    booster = xgb.train(
        params,
        dtrain,
        num_boost_round=300,     # n_estimators
        evals=[(dtrain, "train"), (dval, "val")],
        verbose_eval=False,
    )

    preds = booster.predict(dval)
    metrics = _metrics(y_val, preds)

    print("\nValidation metrics")
    print(f"  MAE  : {metrics['mae']:.4f} arcsec")
    print(f"  RMSE : {metrics['rmse']:.4f} arcsec")
    print(f"  R^2  : {metrics['r2']:.4f}")

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Save the Booster so api/pipeline/seeing.py can load it with
    # xgb.Booster().load_model(...).
    booster.save_model(str(output_path))
    print(f"\nSaved model -> {output_path}")

    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the XGBoost seeing model.")
    parser.add_argument(
        "--output",
        type=str,
        default=str(DEFAULT_MODEL_PATH),
        help="Path to save the trained model JSON.",
    )
    parser.add_argument(
        "--n-samples",
        type=int,
        default=N_SAMPLES,
        help="Number of synthetic training samples.",
    )
    parser.add_argument("--seed", type=int, default=SEED, help="RNG seed.")
    parser.add_argument(
        "--source",
        choices=("synthetic", "era5"),
        default="synthetic",
        help="Training data source. 'era5' reads a cache built by api/ml/era5.py.",
    )
    parser.add_argument(
        "--era5-cache",
        type=str,
        default=None,
        help="Path to the .npz produced by `python -m api.ml.era5 build` (required for --source era5).",
    )
    args = parser.parse_args()

    train(
        output_path=Path(args.output),
        n_samples=args.n_samples,
        seed=args.seed,
        source=args.source,
        era5_cache=args.era5_cache,
    )


if __name__ == "__main__":
    main()
