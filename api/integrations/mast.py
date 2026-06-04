"""Reference-image fetching for astronomy targets.

Resolves a thumbnail/preview image URL for a deep-sky target so the frontend
can render a real picture on each target card. Two sources, tried in order:

  1. **HST / Hubble Legacy Archive (HLA).** For positions with real Hubble
     coverage we serve a genuine HST color composite. We discover images via
     the HLA SIAP service (``hlaSIAP.cgi``), rank the matches (3-color
     composites, drizzled Hubble Heritage / HLSP products, ACS, longest
     exposure), and rewrite the chosen full-mosaic ``fitscut`` URL into a
     fixed-size cutout that loads quickly in the browser. Auth-free.
  2. **NASA SkyView (DSS2 Red).** A ground-based survey cutout available for
     *any* sky position — the universal fallback when a target has no HST
     coverage or HLA is unreachable.

Both sources return a PNG directly from a GET, so we hand the frontend the URL
instead of downloading bytes server-side. The ``source`` field ("HST/HLA" or
"SkyView/DSS2 Red") lets the UI label the image accurately.

Note on the original spec: the MAST Mashup ``invoke`` API (name lookup + CAOM
cone) now returns 404, and the ``fitscut`` ``red=merged`` position shortcut is
not a valid selector. The HLA SIAP path below is the working equivalent.

Results are cached in a small in-memory LRU keyed by
``(target_name, round(ra, 3), round(dec, 3))`` so repeated targets within a
session don't re-hit the network. Rounding to 3 decimals (~0.06 deg) keeps the
key stable across float jitter while staying fine enough that two distinct
deep-sky objects never collide onto the same entry (2 decimals, ~0.6 deg, did).
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import xml.etree.ElementTree as ET
from collections import OrderedDict
from typing import Optional
from urllib.parse import urlencode

import httpx


logger = logging.getLogger(__name__)


SKYVIEW_BASE = "https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl"
SKYVIEW_SURVEY = "DSS2 Red"
SKYVIEW_SIZE_DEG = 0.25     # field of view (degrees)
SKYVIEW_PIXELS = 512        # output image size (px, square)

# Hubble Legacy Archive (real HST imagery).
HLA_SIAP_URL = "https://hla.stsci.edu/cgi-bin/hlaSIAP.cgi"
HLA_SEARCH_SIZE_DEG = 0.1   # SIAP footprint search size (degrees)
HLA_CUTOUT_PIXELS = 512     # rendered cutout size (px, square)
HLA_MIN_PNG_BYTES = 6000    # below this a cutout is treated as near-blank
                            # (thin sub-mosaics render to a ~2 KB empty PNG)
HLA_TIMEOUT_S = 8.0         # SIAP discovery timeout; miss -> SkyView fallback.
                            # Heavily-observed fields (e.g. M42, ~360 matches)
                            # take ~4-5 s server-side to assemble the VOTable.

CACHE_MAX_ENTRIES = 200
BATCH_CONCURRENCY = 10      # be polite to the image services


class MASTClient:
    """Fetches and caches reference images for astronomy targets."""

    def __init__(self) -> None:
        # OrderedDict as a simple LRU: move-to-end on hit, popitem(last=False)
        # to evict the oldest when over capacity.
        self._cache: "OrderedDict[tuple, Optional[dict]]" = OrderedDict()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_reference_image(
        self,
        target_name: str,
        ra: float,
        dec: float,
    ) -> Optional[dict]:
        """Return ``{url, source, width, height}`` for a target, or ``None``.

        Tries the HLA HST cutout first and falls back to the SkyView DSS2
        survey cutout, stopping at the first success. ``None`` is only
        returned in the (unexpected) event both sources fail.
        """
        key = self._cache_key(target_name, ra, dec)
        if key in self._cache:
            self._cache.move_to_end(key)
            logger.info("Image cache hit: %s (%.3f, %.3f)", target_name, ra, dec)
            return self._cache[key]

        # Primary: a real HST color cutout from the Hubble Legacy Archive when
        # the position has Hubble coverage. Any miss/timeout/error falls
        # through to the always-available SkyView DSS2 survey cutout.
        result = await self._hla_image(ra, dec)
        if result is None:
            result = self._skyview_image(ra, dec)

        self._store(key, result)
        return result

    async def get_reference_images_batch(
        self,
        targets: list[dict],
    ) -> dict[str, dict]:
        """Fetch images for up to ``BATCH_CONCURRENCY`` targets concurrently.

        Args:
            targets: list of dicts each with ``name``, ``ra_deg``/``ra``,
                and ``dec_deg``/``dec`` keys.

        Returns:
            Mapping of ``target_name -> {url, source, width, height}``.
            Targets whose fetch returned ``None`` are omitted.
        """
        capped = targets[:BATCH_CONCURRENCY]
        semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)

        async def _one(t: dict) -> tuple[str, Optional[dict]]:
            name = t.get("name") or t.get("common_name") or ""
            ra = _coalesce(t.get("ra_deg"), t.get("ra"))
            dec = _coalesce(t.get("dec_deg"), t.get("dec"))
            if not name or ra is None or dec is None:
                return name, None
            async with semaphore:
                try:
                    img = await self.get_reference_image(name, float(ra), float(dec))
                except Exception as exc:  # never let one target sink the batch
                    logger.warning("reference image failed for %s: %s", name, exc)
                    img = None
            return name, img

        pairs = await asyncio.gather(*(_one(t) for t in capped))
        return {name: img for name, img in pairs if name and img is not None}

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _hla_image(self, ra: float, dec: float) -> Optional[dict]:
        """Resolve a real HST color cutout via the HLA SIAP service.

        Returns ``{url, source, width, height, instrument, dataset}`` for the
        best HST color image covering ``(ra, dec)``, or ``None`` when there is
        no HST coverage or the service is unreachable (caller then uses
        SkyView). The 3 s-class timeout keeps a slow archive from stalling the
        planner.
        """
        params = {
            "POS": f"{ra},{dec}",
            "SIZE": HLA_SEARCH_SIZE_DEG,
            "FORMAT": "image/png",
            "imagetype": "color",
        }
        try:
            async with httpx.AsyncClient(timeout=HLA_TIMEOUT_S, follow_redirects=True) as client:
                resp = await client.get(HLA_SIAP_URL, params=params)
                resp.raise_for_status()
                text = resp.text
        except Exception as exc:  # network error, timeout, bad status
            logger.info("HLA SIAP miss at (%.3f, %.3f): %s", ra, dec, exc)
            return None

        best = _best_hla_row(text)
        if best is None:
            return None
        url, instrument, dataset = best
        # Verify the chosen cutout actually renders real content. Some HST
        # products (e.g. thin Orion mosaic strips) return a valid 200 image/png
        # that is effectively blank; we reject those and let SkyView handle it.
        if not await self._renders_content(url):
            logger.info("HLA cutout for %s rendered near-empty; using SkyView", dataset)
            return None
        return {
            "url": url,
            "source": "HST/HLA",
            "width": HLA_CUTOUT_PIXELS,
            "height": HLA_CUTOUT_PIXELS,
            "instrument": instrument,
            "dataset": dataset,
        }

    async def _renders_content(self, url: str) -> bool:
        """True iff ``url`` streams >= ``HLA_MIN_PNG_BYTES`` of image data.

        Reads only enough of the response to decide (then aborts the stream),
        so we confirm a non-blank PNG without downloading the full cutout.
        """
        try:
            async with httpx.AsyncClient(timeout=HLA_TIMEOUT_S, follow_redirects=True) as client:
                async with client.stream("GET", url) as resp:
                    if resp.status_code != 200:
                        return False
                    if "image" not in resp.headers.get("content-type", ""):
                        return False
                    seen = 0
                    async for chunk in resp.aiter_bytes():
                        seen += len(chunk)
                        if seen >= HLA_MIN_PNG_BYTES:
                            return True
                    return False
        except Exception as exc:  # timeout, connection reset, etc.
            logger.info("HLA cutout verify failed: %s", exc)
            return False

    def _skyview_image(self, ra: float, dec: float) -> dict:
        """Build a SkyView DSS2 Red cutout URL for the given position."""
        query = urlencode({
            "Survey": SKYVIEW_SURVEY,
            "Position": f"{ra},{dec}",
            "Size": SKYVIEW_SIZE_DEG,
            "Pixels": SKYVIEW_PIXELS,
            "Return": "PNG",
        })
        return {
            "url": f"{SKYVIEW_BASE}?{query}",
            "source": "SkyView/DSS2 Red",
            "width": SKYVIEW_PIXELS,
            "height": SKYVIEW_PIXELS,
        }

    def _cache_key(self, target_name: str, ra: float, dec: float) -> tuple:
        # 3 decimals (~0.06 deg): fine enough that two distinct deep-sky
        # objects never share a key, coarse enough to absorb float jitter.
        return (target_name, round(float(ra), 3), round(float(dec), 3))

    def _store(self, key: tuple, value: Optional[dict]) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_MAX_ENTRIES:
            self._cache.popitem(last=False)


def _coalesce(*values):
    for v in values:
        if v is not None:
            return v
    return None


def _parse_votable(xml_text: str) -> tuple[list[str], list[list[Optional[str]]]]:
    """Parse a VOTable into ``(field_names, rows)``. Namespace-agnostic."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return [], []

    def local(e) -> str:
        return e.tag.split("}")[-1]

    fields: list[str] = []
    rows: list[list[Optional[str]]] = []
    for e in root.iter():
        t = local(e)
        if t == "FIELD":
            fields.append(e.get("name"))
        elif t == "TR":
            rows.append([c.text for c in e if local(c) == "TD"])
    return fields, rows


def _best_hla_row(xml_text: str) -> Optional[tuple[str, Optional[str], Optional[str]]]:
    """Choose the best HST color image from an HLA SIAP VOTable.

    Returns ``(cutout_url, instrument, dataset)`` or ``None``. Ranks by, in
    priority order: a true 3-color composite, a drizzled Hubble Heritage / HLSP
    product, an ACS detector, then exposure time. The SIAP ``URL`` renders the
    whole mosaic (``size=ALL``); we rewrite it to a fixed-pixel cutout so the
    browser gets a fast thumbnail instead of a multi-MB full mosaic.
    """
    fields, rows = _parse_votable(xml_text)
    if not rows:
        return None
    idx = {n: i for i, n in enumerate(fields)}

    def col(r: list, n: str) -> Optional[str]:
        i = idx.get(n)
        return r[i] if i is not None and i < len(r) else None

    def score(r: list) -> tuple:
        url = html.unescape(col(r, "URL") or "")
        dataset = (col(r, "Dataset") or "").lower()
        detector = (col(r, "Detector") or "").lower()
        try:
            exptime = float(col(r, "ExpTime") or 0)
        except (TypeError, ValueError):
            exptime = 0.0
        three_color = ("green=" in url) and ("blue=" in url)
        # Combined, target-framed color mosaics render as rich thumbnails; thin
        # "strip" sub-images of large mosaics render near-empty at this zoom, so
        # rank any strip last regardless of its other merits.
        combined = any(tok in dataset for tok in ("colorimage", "heritage", "total"))
        is_strip = "strip" in dataset
        heritage = ("heritage" in dataset) or ("hlsp" in dataset)
        drizzled = any(tok in dataset for tok in ("drz", "drc", "mosaic"))
        acs = "acs" in detector
        return (not is_strip, combined, three_color, heritage, drizzled, acs, exptime)

    candidates = [r for r in rows if col(r, "URL")]
    if not candidates:
        return None
    best = max(candidates, key=score)
    url = html.unescape(col(best, "URL") or "")
    # Whole-mosaic render (size=ALL) -> fixed-size cutout for a fast thumbnail.
    url = re.sub(r"size=[^&]*", f"size={HLA_CUTOUT_PIXELS}", url)
    return url, col(best, "Detector"), col(best, "Dataset")
