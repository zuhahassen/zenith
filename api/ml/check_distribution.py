"""Diagnostic for the derived seeing-FWHM labels in an ERA5 training cache.

Loads the (X, y) npz produced by ``api.ml.era5.build_dataset`` (e.g. via
``api.ml.harvest_stanford``) and reports descriptive statistics for the
physically-derived seeing targets ``y``. It also sanity-checks the
distribution against expectations:

  * Seeing should be approximately log-normal (right-skewed, roughly symmetric
    in log-space). A large skewness of ``log(y)`` flags a departure.
  * The median should fall in a realistic California-foothills band
    (0.8" .. 2.5"). Outside that range likely indicates a units bug or a
    mis-calibrated Cn^2 outer-scale model.

Pure NumPy, no SciPy dependency. Network- and xarray-free.

    python -m api.ml.check_distribution
    python -m api.ml.check_distribution --npz api/ml/data/stanford_3yr.npz
    python -m api.ml.check_distribution --strict   # exit non-zero on warnings
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

DEFAULT_NPZ = Path(__file__).resolve().parent / "data" / "stanford_3yr.npz"

# Realistic median-seeing band for a California foothills / coastal-range site.
MEDIAN_MIN_ARCSEC = 0.8
MEDIAN_MAX_ARCSEC = 2.5
# |skewness of log(y)| above this is treated as a departure from log-normal.
LOG_SKEW_TOLERANCE = 1.0


def _skewness(x: np.ndarray) -> float:
    """Population (Fisher-Pearson) skewness."""
    x = np.asarray(x, dtype=float)
    n = x.size
    if n < 3:
        return float("nan")
    mu = x.mean()
    s = x.std()  # population std (ddof=0)
    if s == 0:
        return 0.0
    return float(np.mean(((x - mu) / s) ** 3))


def describe(y: np.ndarray) -> dict:
    y = np.asarray(y, dtype=float)
    y = y[np.isfinite(y)]
    stats = {
        "count": int(y.size),
        "mean": float(np.mean(y)),
        "median": float(np.median(y)),
        "min": float(np.min(y)),
        "max": float(np.max(y)),
        "variance": float(np.var(y)),
        "skewness": _skewness(y),
        "log_skewness": _skewness(np.log(y[y > 0])) if np.any(y > 0) else float("nan"),
    }
    return stats


def check(npz_path: Path, strict: bool = False) -> int:
    if not npz_path.exists():
        print(f"ERROR: cache not found: {npz_path}", file=sys.stderr)
        print("Run `python -m api.ml.harvest_stanford` first.", file=sys.stderr)
        return 2

    data = np.load(npz_path)
    if "y" not in data:
        print(f"ERROR: {npz_path} has no 'y' array (keys: {list(data.keys())})", file=sys.stderr)
        return 2

    y = data["y"]
    s = describe(y)

    print(f"Seeing-FWHM label distribution  ({npz_path})")
    print(f"  count        : {s['count']}")
    print(f"  mean         : {s['mean']:.4f} arcsec")
    print(f"  median       : {s['median']:.4f} arcsec")
    print(f"  min / max    : {s['min']:.4f} / {s['max']:.4f} arcsec")
    print(f"  variance     : {s['variance']:.4f}")
    print(f"  skewness     : {s['skewness']:.4f}")
    print(f"  log-skewness : {s['log_skewness']:.4f}  (≈0 => log-normal)")

    warnings: list[str] = []

    if not (MEDIAN_MIN_ARCSEC <= s["median"] <= MEDIAN_MAX_ARCSEC):
        warnings.append(
            f"median {s['median']:.3f}\" is outside the realistic "
            f"[{MEDIAN_MIN_ARCSEC}, {MEDIAN_MAX_ARCSEC}]\" band — check units / Cn^2 calibration."
        )
    if np.isfinite(s["log_skewness"]) and abs(s["log_skewness"]) > LOG_SKEW_TOLERANCE:
        warnings.append(
            f"|log-skewness| {abs(s['log_skewness']):.3f} > {LOG_SKEW_TOLERANCE} — "
            f"distribution departs from log-normal."
        )
    if s["skewness"] < 0:
        warnings.append("raw distribution is left-skewed; seeing should be right-skewed.")

    if warnings:
        print("\nWARNINGS:")
        for w in warnings:
            print(f"  - {w}")
        if strict:
            return 1
    else:
        print("\nOK: distribution is log-normal-shaped with a realistic median.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate derived seeing-label distribution.")
    parser.add_argument("--npz", type=str, default=str(DEFAULT_NPZ),
                        help="Path to the (X, y) npz cache.")
    parser.add_argument("--strict", action="store_true",
                        help="Exit non-zero if any distribution warning fires.")
    args = parser.parse_args()
    return check(Path(args.npz), strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
