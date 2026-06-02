"""Reference-image fetching for astronomy targets.

Resolves a thumbnail/preview image URL for a deep-sky target so the
frontend can render a real picture on each target card. The current
implementation uses NASA SkyView (DSS2 Red), which is free, requires no
auth, and produces a cutout for *any* sky position — making it a reliable
universal fallback. SkyView returns a PNG directly from a GET, so we hand
the frontend the URL instead of downloading bytes server-side.

A MAST/HST high-resolution path is stubbed out below (see the TODO) for a
future upgrade where we look up a real HST observation for famous targets.

Results are cached in a small in-memory LRU keyed by
``(target_name, round(ra, 2), round(dec, 2))`` so repeated targets within a
session don't re-hit SkyView.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Optional
from urllib.parse import urlencode


logger = logging.getLogger(__name__)


SKYVIEW_BASE = "https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl"
SKYVIEW_SURVEY = "DSS2 Red"
SKYVIEW_SIZE_DEG = 0.25     # field of view (degrees)
SKYVIEW_PIXELS = 512        # output image size (px, square)

CACHE_MAX_ENTRIES = 200
BATCH_CONCURRENCY = 10      # be polite to SkyView


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

        Tries each source in order and stops at the first success. Currently
        only the SkyView cutout is implemented (always available); the MAST
        HST path is a stub.
        """
        key = self._cache_key(target_name, ra, dec)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]

        result = self._skyview_image(ra, dec)

        # --- MAST/HST high-res path (stub) -------------------------------
        # TODO: For famous targets, look up a real HST observation and serve
        # a high-resolution cutout instead of the DSS2 survey image:
        #   1. Resolve the target to a MAST target id:
        #        GET https://mast.stsci.edu/api/v0.1/invoke
        #            ?request=Mast.Name.Lookup
        #            &params={"input": target_name, "format": "json"}
        #   2. Query for an HST product and build a cutout URL:
        #        https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:HST/product/{target_id}
        # Fall through to the SkyView result when no HST observation exists.
        # if result is None:
        #     result = await self._mast_hst_image(target_name)

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
        return (target_name, round(float(ra), 2), round(float(dec), 2))

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
