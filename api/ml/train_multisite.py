"""Train a single combined seeing model across multiple ERA5 site datasets.

Loads each ``{site}_era5.npz`` produced by ``api.ml.harvest_generic`` (or the
Stanford harvester), stamps the per-site geolocation into the ``site_lat`` /
``site_lon`` feature columns, splits each site chronologically (so no site's
future leaks into another site's past), trains one multi-quantile XGBoost
booster on the combined training fold, and reports per-site + overall metrics.

Usage:
    python -m api.ml.train_multisite --sites stanford maunakea lapalma \
        --output api/ml/models/multisite_model.json

The quantile-regression config (P10/P50/P90, regularization, early stopping)
is identical to ``api.ml.train_xgb`` so the two models are directly comparable.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional

import numpy as np

from .features import FEATURE_NAMES, N_FEATURES
from .train_xgb import QUANTILES, SEED, _interval_coverage, _metrics

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "models" / "multisite_model.json"

# Known site coordinates, used only as a fallback when a cache predates the
# self-describing npz (which stores lat/lon). Keys are the --sites slugs.
_KNOWN_COORDS = {
    "stanford": (37.4275, -122.1697),
    "maunakea": (19.82, -155.47),
    "lapalma": (28.76, -17.89),
}

_LAT_COL = FEATURE_NAMES.index("site_lat")
_LON_COL = FEATURE_NAMES.index("site_lon")


def _load_site(site: str) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Load one site's cache and ensure the geolocation columns are populated.

    Looks for ``{site}_era5.npz`` first, then ``{site}_3yr.npz`` (the Stanford
    harvester's name). Coordinates come from the npz if present, else the
    ``_KNOWN_COORDS`` fallback.
    """
    candidates = [DATA_DIR / f"{site}_era5.npz", DATA_DIR / f"{site}_3yr.npz"]
    path = next((p for p in candidates if p.exists()), None)
    if path is None:
        raise FileNotFoundError(
            f"No dataset for site '{site}' (looked for {[p.name for p in candidates]}). "
            f"Run: python -m api.ml.harvest_generic --name {site} ..."
        )
    data = np.load(path)
    X = np.asarray(data["X"], dtype=float)
    y = np.asarray(data["y"], dtype=float)
    if X.shape[1] != N_FEATURES:
        raise ValueError(
            f"{path.name} has {X.shape[1]} features, expected {N_FEATURES}. "
            f"Rebuild the cache after the feature-schema change."
        )

    if "lat" in data and "lon" in data:
        lat, lon = float(data["lat"]), float(data["lon"])
    elif site in _KNOWN_COORDS:
        lat, lon = _KNOWN_COORDS[site]
    else:
        raise ValueError(f"No coordinates for '{site}' in {path.name} or _KNOWN_COORDS.")

    # Stamp coordinates into the geolocation columns (idempotent; overwrites any
    # NaN left by a single-site build).
    X[:, _LAT_COL] = lat
    X[:, _LON_COL] = lon
    print(f"  {site:10s} {path.name:22s} samples={len(X):5d}  lat={lat:+.3f} lon={lon:+.3f}")
    return X, y, lat, lon


def _split_chronological(X: np.ndarray, y: np.ndarray, frac: float = 0.8):
    """First ``frac`` (chronological) as train, the remainder as val.

    The ERA5 caches are built in time order, so a positional split is a true
    chronological holdout for that site.
    """
    split = int(frac * len(X))
    return X[:split], y[:split], X[split:], y[split:]


def train_multisite(
    sites: list[str],
    output_path: Path = DEFAULT_OUTPUT,
    seed: int = SEED,
) -> dict:
    import xgboost as xgb

    print(f"Loading {len(sites)} site datasets from {DATA_DIR} ...")
    per_site: dict[str, dict] = {}
    Xtr_parts, ytr_parts = [], []
    for site in sites:
        X, y, lat, lon = _load_site(site)
        Xtr, ytr, Xval, yval = _split_chronological(X, y)
        per_site[site] = {"Xval": Xval, "yval": yval, "n_train": len(Xtr)}
        Xtr_parts.append(Xtr)
        ytr_parts.append(ytr)

    # Combine per-site TRAIN folds only. Because each site was split before
    # combining, no site's future contaminates another site's past. Row order
    # within the combined fold is irrelevant to a tree ensemble.
    X_train = np.concatenate(Xtr_parts, axis=0)
    y_train = np.concatenate(ytr_parts, axis=0)
    X_val = np.concatenate([per_site[s]["Xval"] for s in sites], axis=0)
    y_val = np.concatenate([per_site[s]["yval"] for s in sites], axis=0)
    print(f"Combined: train={len(X_train)}  val={len(X_val)}  features={N_FEATURES}")

    names = list(FEATURE_NAMES)
    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=names)
    dval = xgb.DMatrix(X_val, label=y_val, feature_names=names)

    # Identical config to api/ml/train_xgb.train().
    params = {
        "max_depth": 4,
        "eta": 0.03,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 8,
        "lambda": 3.0,
        "gamma": 0.1,
        "objective": "reg:quantileerror",
        "quantile_alpha": np.array(QUANTILES),
        "seed": seed,
    }
    booster = xgb.train(
        params,
        dtrain,
        num_boost_round=800,
        evals=[(dtrain, "train"), (dval, "val")],
        early_stopping_rounds=40,
        verbose_eval=False,
    )

    med = QUANTILES.index(0.5)

    def _eval(X: np.ndarray, y: np.ndarray) -> dict:
        preds = booster.predict(xgb.DMatrix(X, feature_names=names))
        m = _metrics(y, preds[:, med] if preds.ndim == 2 else preds)
        m["coverage_80"] = _interval_coverage(y, preds)
        m["n"] = int(len(y))
        return m

    print("\nPer-site validation metrics:")
    report: dict = {"sites": {}}
    for site in sites:
        m = _eval(per_site[site]["Xval"], per_site[site]["yval"])
        report["sites"][site] = m
        print(f"  {site:10s} n={m['n']:4d}  MAE={m['mae']:.4f}  R^2={m['r2']:.4f}  "
              f"cover={m['coverage_80']:.3f}")

    overall = _eval(X_val, y_val)
    report["overall"] = overall
    print(f"  {'OVERALL':10s} n={overall['n']:4d}  MAE={overall['mae']:.4f}  "
          f"R^2={overall['r2']:.4f}  cover={overall['coverage_80']:.3f}")

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(output_path))
    print(f"\nSaved multi-site model -> {output_path}")
    return report


def main() -> None:
    p = argparse.ArgumentParser(description="Train a combined multi-site seeing model.")
    p.add_argument("--sites", type=str, nargs="+", required=True,
                   help="site slugs to combine, e.g. stanford maunakea lapalma")
    p.add_argument("--output", type=str, default=str(DEFAULT_OUTPUT))
    p.add_argument("--seed", type=int, default=SEED)
    args = p.parse_args()
    train_multisite(args.sites, Path(args.output), seed=args.seed)


if __name__ == "__main__":
    main()
