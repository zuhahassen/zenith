"""Live Astroquery SIMBAD catalog interface.

Replaces the former static Messier list. Queries SIMBAD via TAP (ADQL) for
each requested object type, with magnitude + angular-size filters and an
optional latitude cut.

Caching:
  - Results are cached in-process for 24 hours (`CACHE_TTL_SECONDS`).
  - The cache key is a stable hash of the query parameters and the payload
    is JSON-serializable, so the same shape is suitable for the Cloudflare
    KV layer the Worker maintains at the edge for /api/targets (24h TTL).

The previous hand-picked Messier list is preserved as `SEED_CATALOG` for
offline tests and as a fallback if SIMBAD is unreachable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Optional

from .visibility import Target


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SIMBAD object-type mapping
# ---------------------------------------------------------------------------
# Reference: https://simbad.cds.unistra.fr/guide/otypes.htx
# We accept high-level kinds from the API and fan them out into the SIMBAD
# short codes that actually live in the `basic.otype` column.
OTYPE_MAP: dict[str, list[str]] = {
    "galaxy":            ["G", "GiC", "GiG", "GiP", "BiC", "PaG", "EmG", "SBG"],
    "open_cluster":      ["OpC", "Cl*"],
    "globular_cluster":  ["GlC"],
    "nebula":            ["Neb", "HII", "RNe", "DNe", "MoC"],
    "planetary_nebula":  ["PN"],
    "supernova_remnant": ["SNR"],
}


# ---------------------------------------------------------------------------
# Cache (in-process, mirrors the Worker's 24h KV TTL)
# ---------------------------------------------------------------------------
CACHE_TTL_SECONDS = 24 * 60 * 60
_CACHE: dict[str, tuple[float, list[dict]]] = {}


def _cache_key(
    object_types: list[str],
    magnitude_limit: float,
    location: Optional[tuple[float, float]],
    min_angular_size: float,
    row_limit: int,
) -> str:
    payload = json.dumps(
        {
            "types": sorted(t.lower() for t in object_types),
            "mag": round(magnitude_limit, 3),
            "loc": [round(x, 2) for x in location] if location else None,
            "size": round(min_angular_size, 3),
            "rows": row_limit,
        },
        sort_keys=True,
    )
    return "simbad:" + hashlib.sha1(payload.encode()).hexdigest()[:16]


def _cache_get(key: str) -> Optional[list[dict]]:
    hit = _CACHE.get(key)
    if not hit:
        return None
    expires_at, value = hit
    if time.time() > expires_at:
        _CACHE.pop(key, None)
        return None
    return value


def _cache_set(key: str, value: list[dict]) -> None:
    _CACHE[key] = (time.time() + CACHE_TTL_SECONDS, value)


def clear_cache() -> None:
    """Drop all cached SIMBAD responses. Useful in tests."""
    _CACHE.clear()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def fetch_targets(
    object_types: list[str],
    magnitude_limit: float = 12.0,
    location: Optional[tuple[float, float]] = None,
    min_angular_size_arcmin: float = 0.5,
    row_limit: int = 500,
) -> list[dict]:
    """Live SIMBAD query → list of standardized target dicts.

    Args:
        object_types: high-level kinds, e.g. ``["galaxy", "nebula",
            "globular_cluster"]``. Unknown kinds are passed through as raw
            SIMBAD otype codes.
        magnitude_limit: drop objects fainter than this V-band magnitude.
        location: (lat, lon). When provided, drops objects whose declination
            puts them permanently below the horizon for that latitude (with
            a 5° altitude buffer).
        min_angular_size_arcmin: drop objects with major axis below this.
        row_limit: hard cap on rows returned by SIMBAD.

    Returns:
        JSON-serializable list of dicts with keys: ``name``, ``common_name``,
        ``type``, ``ra``, ``dec``, ``magnitude``, ``angular_size``
        (``[major, minor]`` in arcmin).
    """
    key = _cache_key(object_types, magnitude_limit, location,
                     min_angular_size_arcmin, row_limit)
    cached = _cache_get(key)
    if cached is not None:
        logger.debug("SIMBAD cache hit: %s", key)
        return cached

    try:
        results = _query_simbad(
            object_types, magnitude_limit, location,
            min_angular_size_arcmin, row_limit,
        )
    except Exception as exc:  # network failure, TAP outage, malformed ADQL
        logger.warning("SIMBAD query failed (%s); returning empty list", exc)
        return []

    _cache_set(key, results)
    return results


def to_targets(rows: list[dict]) -> list[Target]:
    """Convert the dict shape returned by :func:`fetch_targets` into the
    :class:`Target` dataclass consumed by the visibility pipeline."""
    out: list[Target] = []
    for r in rows:
        size = r.get("angular_size")
        size_tuple: Optional[tuple[float, float]]
        if size and size[0] is not None and size[1] is not None:
            size_tuple = (float(size[0]), float(size[1]))
        else:
            size_tuple = None
        out.append(
            Target(
                name=r["name"],
                ra_deg=float(r["ra"]),
                dec_deg=float(r["dec"]),
                magnitude=(float(r["magnitude"]) if r.get("magnitude") is not None else None),
                size_arcmin=size_tuple,
                kind=r.get("type") or "Unknown",
                common_name=r.get("common_name"),
            )
        )
    return out


# ---------------------------------------------------------------------------
# SIMBAD TAP query
# ---------------------------------------------------------------------------


def _resolve_otype_codes(object_types: list[str]) -> list[str]:
    codes: list[str] = []
    for raw in object_types:
        key = raw.lower().strip()
        codes.extend(OTYPE_MAP.get(key, [raw]))
    # De-dup, preserve order.
    seen: set[str] = set()
    unique: list[str] = []
    for c in codes:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def _query_simbad(
    object_types: list[str],
    mag_limit: float,
    location: Optional[tuple[float, float]],
    min_size: float,
    row_limit: int,
) -> list[dict]:
    # Import lazily so test collection / cold imports don't pay the astroquery
    # startup cost when only SEED_CATALOG is used.
    from astroquery.simbad import Simbad

    codes = _resolve_otype_codes(object_types)
    if not codes:
        return []

    otype_in = ", ".join(f"'{c}'" for c in codes)
    where = [
        f"otype IN ({otype_in})",
        "allfluxes.V IS NOT NULL",
        f"allfluxes.V <= {float(mag_limit)}",
        "galdim_majaxis IS NOT NULL",
        f"galdim_majaxis >= {float(min_size)}",
    ]

    if location is not None:
        lat = float(location[0])
        # An object at declination delta is permanently below the horizon
        # when delta < lat - 90° (north) or delta > lat + 90° (south).
        # Trim by 5° to leave a usable altitude buffer.
        if lat >= 0:
            where.append(f"dec >= {lat - 85.0}")
        else:
            where.append(f"dec <= {lat + 85.0}")

    # NOTE: SIMBAD's `basic` table has no magnitude columns; V-band lives in
    # `allfluxes`. SIMBAD's ADQL parser also rejects qualified column refs in
    # ORDER BY, so we alias `allfluxes.V` as `vmag`.
    adql = (
        f"SELECT TOP {int(row_limit)} "
        "main_id, ra, dec, otype, allfluxes.V AS vmag, "
        "galdim_majaxis, galdim_minaxis "
        "FROM basic JOIN allfluxes ON basic.oid = allfluxes.oidref "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY vmag ASC"
    )

    logger.info(
        "SIMBAD TAP query: types=%s mag<=%s size>=%s rows<=%s",
        codes, mag_limit, min_size, row_limit,
    )
    table = Simbad.query_tap(adql)
    if table is None or len(table) == 0:
        return []

    return [_row_to_dict(row) for row in table]


def _row_to_dict(row) -> dict:
    name = _clean_name(row["main_id"])
    return {
        "name": name,
        "common_name": COMMON_NAMES.get(name.replace(" ", "").upper()),
        "type": _normalize_otype(_str(row["otype"])),
        "ra": float(row["ra"]),
        "dec": float(row["dec"]),
        "magnitude": (float(row["vmag"]) if _present(row["vmag"]) else None),
        "angular_size": [
            float(row["galdim_majaxis"]) if _present(row["galdim_majaxis"]) else None,
            float(row["galdim_minaxis"]) if _present(row["galdim_minaxis"]) else None,
        ],
    }


def _present(value) -> bool:
    # astropy MaskedColumn entries can be masked sentinels.
    if value is None:
        return False
    try:
        import numpy as np
        if isinstance(value, float) and np.isnan(value):
            return False
    except Exception:
        pass
    return getattr(value, "mask", False) is not True


def _str(value) -> str:
    return "" if value is None else str(value).strip()


def _clean_name(value) -> str:
    # SIMBAD pads identifiers (e.g. "M  31"); collapse the run of spaces.
    return " ".join(_str(value).split())


def _normalize_otype(code: str) -> str:
    """Map SIMBAD otype short codes back into the human-readable kinds the
    scorer understands (Galaxy / Nebula / GlCl / OpenCl / ...)."""
    code = code.strip()
    if code in {"G", "GiC", "GiG", "GiP", "BiC", "PaG", "EmG", "SBG"}:
        return "Galaxy"
    if code == "OpC" or code == "Cl*":
        return "OpenCl"
    if code == "GlC":
        return "GlCl"
    if code == "PN":
        return "Nebula"  # planetary nebula scored as nebula
    if code in {"Neb", "HII", "RNe", "DNe", "MoC", "SNR"}:
        return "Nebula"
    return code or "Unknown"


# ---------------------------------------------------------------------------
# Common-name lookup table
# ---------------------------------------------------------------------------
# SIMBAD's main_id is canonical (e.g. "M  31") but rarely friendly. A full
# resolution would join the `ident` table; that's a future enhancement. For
# now, a static map covers the highest-traffic Messier/NGC objects.
COMMON_NAMES: dict[str, str] = {
    "M31":    "Andromeda Galaxy",
    "M13":    "Hercules Cluster",
    "M42":    "Orion Nebula",
    "M45":    "Pleiades",
    "M57":    "Ring Nebula",
    "M51":    "Whirlpool Galaxy",
    "M81":    "Bode's Galaxy",
    "M27":    "Dumbbell Nebula",
    "M22":    "Sagittarius Cluster",
    "M8":     "Lagoon Nebula",
    "M101":   "Pinwheel Galaxy",
    "M104":   "Sombrero Galaxy",
    "M97":    "Owl Nebula",
    "M1":     "Crab Nebula",
    "M16":    "Eagle Nebula",
    "M17":    "Omega Nebula",
    "M20":    "Trifid Nebula",
    "NGC869": "Double Cluster",
    "NGC7000": "North America Nebula",
    "NGC6960": "Veil Nebula",
}


# ---------------------------------------------------------------------------
# Offline seed catalog (preserved for tests and SIMBAD-down fallback)
# ---------------------------------------------------------------------------


def _seed(name, common, ra, dec, mag, maj, min_, kind):
    return Target(
        name=name, common_name=common,
        ra_deg=ra, dec_deg=dec, magnitude=mag,
        size_arcmin=(maj, min_) if maj else None,
        kind=kind,
    )


SEED_CATALOG: list[Target] = [
    _seed("M31",   "Andromeda Galaxy",      10.6847,  41.2687, 3.4, 95.0, 30.0, "Galaxy"),
    _seed("M13",   "Hercules Cluster",     250.4235,  36.4613, 5.8, 10.0, 10.0, "GlCl"),
    _seed("M42",   "Orion Nebula",          83.8221,  -5.3911, 4.0, 33.0, 30.0, "Nebula"),
    _seed("M45",   "Pleiades",              56.7500,  24.1167, 1.6, 55.0, 55.0, "OpenCl"),
    _seed("M57",   "Ring Nebula",          283.3962,  33.0292, 8.8,  1.4,  1.0, "Nebula"),
    _seed("M51",   "Whirlpool Galaxy",     202.4696,  47.1953, 8.4, 11.2,  6.9, "Galaxy"),
    _seed("M81",   "Bode's Galaxy",        148.8882,  69.0653, 6.9, 26.9, 14.1, "Galaxy"),
    _seed("M27",   "Dumbbell Nebula",      299.9015,  22.7211, 7.5,  8.0,  5.7, "Nebula"),
    _seed("M22",   "Sagittarius Cluster",  279.0997, -23.9047, 5.1, 24.0, 24.0, "GlCl"),
    _seed("M8",    "Lagoon Nebula",        270.9042, -24.3867, 6.0, 45.0, 30.0, "Nebula"),
    _seed("M101",  "Pinwheel Galaxy",      210.8024,  54.3489, 7.9, 28.8, 26.9, "Galaxy"),
    _seed("M104",  "Sombrero Galaxy",      189.9976, -11.6231, 8.0,  8.7,  3.5, "Galaxy"),
    _seed("NGC869", "Double Cluster",       34.7417,  57.1333, 3.7, 30.0, 30.0, "OpenCl"),
]


# Backwards-compat alias. Step 7 will swap callers over to fetch_targets().
CATALOG: list[Target] = SEED_CATALOG
