#!/usr/bin/env python3
"""Sanity-check that observer location actually changes target selection.

Posts the SAME date/aperture/mode to /api/plan for several locations and
reports, per location, the top targets plus the pairwise overlap (Jaccard)
of their target sets.

What to expect (this is correct astronomy, not a bug):
  * Same latitude, different longitude  -> HIGH overlap (often ~100%).
    Longitude only shifts WHEN night happens, not WHICH targets are up
    across a multi-hour window on a given date.
  * Different latitude / opposite hemisphere -> LOW overlap. Different
    declinations are visible, so the set should change a lot.

Usage:
    # against a locally running backend
    python scripts/compare_locations.py

    # against the deployed edge worker
    python scripts/compare_locations.py --base https://zenith-api.zuha-hassen.workers.dev

    # pin a date so the seasonal sky is identical across runs
    python scripts/compare_locations.py --date 2026-06-02
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from itertools import combinations

# (label, lat, lon) — chosen to isolate each variable:
#   Denver vs Washington: ~same latitude, different longitude -> expect HIGH overlap
#   Washington vs Sydney: opposite hemisphere               -> expect LOW overlap
#   Quito (equator) sees both hemispheres                    -> partial overlap with each
LOCATIONS = [
    ("Washington DC (39N)", 38.9, -77.0),
    ("Denver       (40N)", 39.7, -104.99),
    ("Reykjavik    (64N)", 64.1, -21.9),
    ("Quito        (0)", -0.2, -78.5),
    ("Sydney      (34S)", -33.9, 151.2),
]


def fetch_targets(base: str, lat: float, lon: float, date: str | None,
                  aperture: float, mode: str, top: int) -> list[str]:
    payload = {
        "lat": lat, "lon": lon, "aperture_mm": aperture, "mode": mode,
    }
    if date:
        payload["date"] = date
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api/plan",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            # nginx/WAF on the droplet 403s the default "Python-urllib" UA.
            "User-Agent": "zenith-location-test/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.load(resp)
    names = [t["name"] for t in data.get("targets", [])]
    return names[:top]


def jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    return len(sa & sb) / len(sa | sb)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:8000",
                    help="API base URL (default: %(default)s)")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD to pin the sky season")
    ap.add_argument("--aperture", type=float, default=150.0)
    ap.add_argument("--mode", default="observer")
    ap.add_argument("--top", type=int, default=15, help="targets per location to compare")
    args = ap.parse_args()

    results: dict[str, list[str]] = {}
    for label, lat, lon in LOCATIONS:
        try:
            names = fetch_targets(args.base, lat, lon, args.date,
                                  args.aperture, args.mode, args.top)
        except Exception as exc:  # noqa: BLE001 - surface any transport error
            print(f"ERROR fetching {label}: {exc}", file=sys.stderr)
            return 1
        results[label] = names
        print(f"\n=== {label}  ({len(names)} targets) ===")
        print("  " + ", ".join(names) if names else "  (none)")

    print("\n=== pairwise overlap (Jaccard, top-{}) ===".format(args.top))
    for (la, na), (lb, nb) in combinations(results.items(), 2):
        pct = jaccard(na, nb) * 100
        flag = ""
        if pct >= 80:
            flag = "  <- nearly identical"
        elif pct <= 25:
            flag = "  <- clearly different"
        print(f"  {la:22s} vs {lb:22s}: {pct:5.1f}%{flag}")

    print(
        "\nInterpretation: same-latitude pairs (Washington/Denver) SHOULD be high;\n"
        "cross-hemisphere pairs (Washington/Sydney) SHOULD be low. If even the\n"
        "cross-hemisphere pair is ~100%, location is being ignored -> real bug."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
