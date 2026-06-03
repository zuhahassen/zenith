"""FastAPI entry point for Zenith.

Run:
    uvicorn api.main:app --reload

Public routes (all routed through the Cloudflare Worker at /api/*):
    POST /api/plan      → deterministic pipeline (no LLM)
    POST /api/plan-ai   → deterministic pipeline + Claude session planner
    POST /api/explain   → Claude Q&A over an existing plan context
    GET  /api/targets   → live SIMBAD catalog query
    GET  /api/weather   → Open-Meteo passthrough
    GET  /                → serves the Pages frontend during local dev

The legacy /plan route is kept as an alias for backwards compatibility with
the unprefixed shape the previous version exposed.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Literal, Optional

from dotenv import load_dotenv

# Load .env from the repo root before any module reads env vars. This is a
# no-op in production where env vars come from systemd / Cloudflare.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agent.explainer import Explainer
from .agent.planner import SessionPlanner
from .integrations.mast import MASTClient
from .integrations.weather import fetch_nightly_forecast, fetch_weather
from .pipeline.catalog import NAMED_CATALOGS, SEED_CATALOG, fetch_targets, filter_to_catalog, to_targets
from .pipeline.light_pollution import estimate_bortle
from .pipeline.seeing import NUM_SLOTS, SLOT_MINUTES, SeeingPredictor
from .pipeline.visibility import (
    Gear,
    Observer,
    Scored,
    Session,
    location_for,
    plan_session,
    session_start,
)


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Zenith")

# CORS: the Cloudflare Worker terminates CORS in production, but in local dev
# the Pages frontend (or `wrangler dev`) talks to this app directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# Module-level singletons. Each picks up its config from env vars lazily so
# that a missing OPENROUTER_API_KEY doesn't crash startup — only /api/plan-ai
# and /api/explain fail loudly with a 503 when the key is absent.
_seeing = SeeingPredictor()
_planner = SessionPlanner()
_explainer = Explainer()
_mast = MASTClient()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


Mode = Literal["observer", "astrophotographer"]


class PlanRequest(BaseModel):
    lat: float = Field(..., description="Observer latitude in degrees")
    lon: float = Field(..., description="Observer longitude in degrees")
    aperture_mm: float = Field(150.0, gt=0)
    date: Optional[datetime] = Field(
        default=None,
        description="Session anchor date (UTC). Defaults to tonight's twilight.",
    )
    user_id: Optional[str] = Field(
        default=None,
        description="Client UUID — used to look up preferences (Step ≥ 8).",
    )
    mode: Mode = Field("observer")

    # Sky darkness. When omitted, estimated from coordinates.
    bortle_class: Optional[int] = Field(default=None, ge=1, le=9)

    # Restrict candidates to a named observing list. One of the keys in
    # NAMED_CATALOGS ("messier", "caldwell", "herschel400") or None for the
    # full catalog. Unknown values are ignored.
    catalog_filter: Optional[str] = Field(default=None)

    # Astrophotographer equipment (used for FoV framing in astro mode).
    focal_length_mm: Optional[float] = Field(default=None, gt=0)
    sensor_width_mm: Optional[float] = Field(default=None, gt=0)
    sensor_height_mm: Optional[float] = Field(default=None, gt=0)

    # Feedback context (injected by the Worker from D1 when user_id is known).
    liked_targets: list[str] = Field(default_factory=list)
    disliked_targets: list[str] = Field(default_factory=list)

    # Optional knobs that mirror the legacy /plan contract.
    elevation_m: float = 0.0
    duration_hours: float = 4.0
    min_alt_deg: float = 25.0


class CompareSite(BaseModel):
    label: str = Field(..., description="Human label, e.g. 'Mount Tamalpais'")
    lat: float
    lon: float


class CompareSitesRequest(BaseModel):
    """Compare 2–5 candidate observing sites for the same night."""

    sites: list[CompareSite] = Field(..., min_length=2, max_length=5)
    aperture_mm: float = Field(150.0, gt=0)
    mode: Mode = Field("observer")
    date: Optional[datetime] = Field(default=None)
    catalog_filter: Optional[str] = Field(default=None)
    duration_hours: float = 4.0
    min_alt_deg: float = 25.0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/")
def root():
    index = FRONTEND_DIR / "index.html"
    if not index.exists():
        return {"status": "ok", "service": "zenith"}
    return FileResponse(str(index))


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "seeing_model_loaded": _seeing.has_model,
        "openrouter_configured": bool(_planner.api_key),
        "catalog": "live-simbad+seed-fallback",
    }


@app.post("/api/plan")
async def api_plan(req: PlanRequest):
    """Run the deterministic pipeline: catalog → visibility → scorer → seeing."""
    return await _run_pipeline(req)


@app.post("/api/plan-ai")
async def api_plan_ai(req: PlanRequest):
    """Deterministic pipeline + Claude planner.

    Returns the same shape as ``/api/plan`` plus an ``ai_plan`` field with
    Claude's curated ordering and markdown notes. Falls back gracefully
    if OpenRouter is unreachable: the deterministic payload is still
    returned and ``ai_plan`` carries an ``error`` string.
    """
    base = await _run_pipeline(req)
    user_profile = None
    if req.liked_targets or req.disliked_targets:
        user_profile = {
            "mode": req.mode,
            "target_feedback": {
                "liked": req.liked_targets,
                "disliked": req.disliked_targets,
            },
        }
    try:
        result = await _planner.plan(
            targets=base["targets"],
            seeing_forecast=base["seeing_forecast"],
            user_profile=user_profile,
            mode=req.mode,
        )
        ai_plan = result.to_dict()
        await _attach_reference_images(ai_plan, base["targets"])
        base["ai_plan"] = ai_plan
    except Exception as exc:  # missing key, OpenRouter outage, parse error
        logger.exception("AI planner failed")
        base["ai_plan"] = {
            "ordered_targets": [],
            "session_summary": "",
            "session_notes": "",
            "error": _describe_exc(exc),
            "error_type": type(exc).__name__,
        }
    return base


def _describe_exc(exc: Exception) -> str:
    """Human-readable, debuggable description of an upstream failure.

    The Anthropic SDK's APIConnectionError stringifies to a bare
    "Connection error." which hides the real cause. Surface the exception
    type plus any nested cause so the frontend/logs show something
    actionable (e.g. the underlying httpx ConnectTimeout vs an HTTP 401).
    """
    name = type(exc).__name__
    msg = str(exc).strip()
    cause = exc.__cause__ or exc.__context__
    detail = msg or name
    if cause is not None and str(cause).strip() and str(cause) not in detail:
        detail = f"{detail} (cause: {type(cause).__name__}: {cause})"
    return f"{name}: {detail}" if msg and name not in detail else detail


async def _attach_reference_images(ai_plan: dict, scored_targets: list[dict]) -> None:
    """Fetch SkyView reference images for the top targets in the plan and
    attach ``reference_image`` ({url, source} | None) to each ordered target.

    Claude's ordered targets carry a ``name`` but not coordinates, so we
    join against the deterministic scored list to recover ra/dec.
    """
    ordered = ai_plan.get("ordered_targets") or []
    if not ordered:
        return

    coords = {
        t["name"]: (t.get("ra_deg"), t.get("dec_deg"))
        for t in scored_targets
        if t.get("name") is not None
    }

    top = ordered[:10]
    batch_input = []
    for t in top:
        name = t.get("name")
        ra, dec = coords.get(name, (None, None))
        if name and ra is not None and dec is not None:
            batch_input.append({"name": name, "ra_deg": ra, "dec_deg": dec})

    images = await _mast.get_reference_images_batch(batch_input)

    for t in ordered:
        img = images.get(t.get("name"))
        t["reference_image"] = (
            {"url": img["url"], "source": img["source"]} if img else None
        )


class ExplainRequest(BaseModel):
    question: str
    plan_context: dict
    history: list[dict] = Field(default_factory=list)


@app.post("/api/explain")
async def api_explain(req: ExplainRequest):
    """Q&A over an existing plan context (cheap model via OpenRouter)."""
    try:
        answer = await _explainer.ask(
            question=req.question,
            plan_context=req.plan_context,
            conversation_history=req.history,
        )
    except RuntimeError as exc:  # missing OPENROUTER_API_KEY
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"explainer error: {exc}")
    return {"answer": answer}


# ---------------------------------------------------------------------------
# Site comparison
# ---------------------------------------------------------------------------
#
# Composite-score weights. Darkness dominates (it's the single biggest driver of
# what a visual observer can see), then weather (a cloudy dark site beats
# nothing but loses to a clear suburban one), then atmospheric seeing, then the
# raw count of well-placed targets. Weights sum to 1.0.
_COMPARE_WEIGHTS = {
    "darkness": 0.40,
    "weather": 0.30,
    "seeing": 0.20,
    "targets": 0.10,
}
# Seeing (arcsec FWHM) mapped linearly to a 0–1 score between these anchors.
_SEEING_BEST_ARCSEC = 1.0   # excellent -> score 1.0
_SEEING_WORST_ARCSEC = 3.5  # poor      -> score 0.0
# Target count mapped linearly to 0–1; this many well-placed objects saturates.
_TARGET_COUNT_FULL = 25


@app.post("/api/compare-sites")
async def api_compare_sites(req: CompareSitesRequest) -> dict:
    """Score and rank 2–5 candidate sites for the same night.

    Runs the full deterministic pipeline (catalog → visibility → seeing →
    weather) for every site concurrently, derives a transparent composite score
    per site, and returns them ranked best-first plus a one-sentence
    recommendation (Claude when configured, deterministic otherwise).
    """
    plan_reqs = [
        PlanRequest(
            lat=s.lat,
            lon=s.lon,
            aperture_mm=req.aperture_mm,
            mode=req.mode,
            date=req.date,
            catalog_filter=req.catalog_filter,
            duration_hours=req.duration_hours,
            min_alt_deg=req.min_alt_deg,
        )
        for s in req.sites
    ]

    # Fan out: one pipeline run per site, in parallel. A single site failing
    # (e.g. SIMBAD/weather hiccup) must not sink the whole comparison.
    results = await asyncio.gather(
        *(_run_pipeline(pr) for pr in plan_reqs),
        return_exceptions=True,
    )

    scored_sites: list[dict] = []
    for site, result in zip(req.sites, results):
        if isinstance(result, Exception):
            logger.warning("compare-sites: pipeline failed for %s: %s", site.label, result)
            scored_sites.append(_failed_site(site, result))
        else:
            scored_sites.append(_score_site(site, result))

    scored_sites.sort(key=lambda s: s["composite_score"], reverse=True)
    best = scored_sites[0] if scored_sites else None

    recommendation = await _compare_recommendation(scored_sites)

    return {
        "sites": scored_sites,
        "best_site": best["label"] if best else None,
        "recommendation": recommendation,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
    }


def _score_site(site: CompareSite, plan: dict) -> dict:
    """Derive per-site sub-scores and the weighted composite from a plan run."""
    bortle = plan.get("bortle_class") or plan.get("request", {}).get("bortle_class") or 6
    weather = plan.get("weather")
    targets = plan.get("targets") or []
    seeing = plan.get("seeing_forecast") or []

    # Darkness: Bortle 1 -> 1.0, Bortle 9 -> 0.0.
    darkness_score = (9 - bortle) / 8.0

    # Weather: reuse the integration's 0–1 heuristic; unknown -> neutral 0.5.
    weather_score = float(weather["weather_score"]) if weather and weather.get("weather_score") is not None else 0.5
    cloud_cover = float(weather["cloud_cover"]) if weather and weather.get("cloud_cover") is not None else None

    # Seeing: median predicted FWHM across the night's slots.
    arcsec_values = [
        s["predicted_seeing_arcsec"]
        for s in seeing
        if s.get("predicted_seeing_arcsec") is not None
    ]
    median_seeing = float(median(arcsec_values)) if arcsec_values else None
    seeing_score = (
        _clamp01((_SEEING_WORST_ARCSEC - median_seeing) / (_SEEING_WORST_ARCSEC - _SEEING_BEST_ARCSEC))
        if median_seeing is not None
        else 0.5
    )

    # Targets: how many well-placed objects the site offers.
    target_count = len(targets)
    targets_score = _clamp01(target_count / _TARGET_COUNT_FULL)

    composite = 100.0 * (
        _COMPARE_WEIGHTS["darkness"] * darkness_score
        + _COMPARE_WEIGHTS["weather"] * weather_score
        + _COMPARE_WEIGHTS["seeing"] * seeing_score
        + _COMPARE_WEIGHTS["targets"] * targets_score
    )

    return {
        "label": site.label,
        "lat": site.lat,
        "lon": site.lon,
        "bortle_class": bortle,
        "cloud_cover": cloud_cover,
        "weather_score": round(weather_score, 3),
        "median_seeing_arcsec": round(median_seeing, 2) if median_seeing is not None else None,
        "visible_target_count": target_count,
        "top_targets": [t.get("name") for t in targets[:3] if t.get("name")],
        "subscores": {
            "darkness": round(darkness_score, 3),
            "weather": round(weather_score, 3),
            "seeing": round(seeing_score, 3),
            "targets": round(targets_score, 3),
        },
        "composite_score": round(composite, 1),
        "error": None,
    }


def _failed_site(site: CompareSite, exc: Exception) -> dict:
    """Placeholder entry (composite 0) for a site whose pipeline failed."""
    return {
        "label": site.label,
        "lat": site.lat,
        "lon": site.lon,
        "bortle_class": None,
        "cloud_cover": None,
        "weather_score": None,
        "median_seeing_arcsec": None,
        "visible_target_count": 0,
        "top_targets": [],
        "subscores": None,
        "composite_score": 0.0,
        "error": _describe_exc(exc),
    }


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


async def _compare_recommendation(scored_sites: list[dict]) -> str:
    """One-sentence pick. Claude when OPENROUTER_API_KEY is set, else heuristic."""
    if not scored_sites:
        return "No sites to compare."

    deterministic = _heuristic_recommendation(scored_sites)

    # Best-effort LLM polish; never fatal if the key is missing or the call fails.
    if not _explainer.api_key:
        return deterministic
    try:
        context = {
            "sites": [
                {
                    k: s[k]
                    for k in ("label", "bortle_class", "cloud_cover",
                              "median_seeing_arcsec", "visible_target_count",
                              "composite_score")
                }
                for s in scored_sites
            ]
        }
        answer = await _explainer.ask(
            question=(
                "In one sentence, recommend which of these observing sites is "
                "best for tonight and why, citing the concrete factor "
                "(darkness, clouds, or seeing) that decides it."
            ),
            plan_context=context,
        )
        answer = (answer or "").strip()
        return answer or deterministic
    except Exception as exc:  # missing key, OpenRouter outage, parse error
        logger.info("compare-sites recommendation fell back to heuristic: %s", exc)
        return deterministic


def _heuristic_recommendation(scored_sites: list[dict]) -> str:
    """Deterministic recommendation sentence used as the no-LLM fallback."""
    best = scored_sites[0]
    if best["composite_score"] <= 0:
        return "None of the candidate sites returned a usable forecast tonight."

    reasons = []
    if best.get("bortle_class") is not None:
        reasons.append(f"Bortle {best['bortle_class']} skies")
    if best.get("cloud_cover") is not None:
        reasons.append(f"{round(best['cloud_cover'])}% cloud cover")
    if best.get("median_seeing_arcsec") is not None:
        reasons.append(f"{best['median_seeing_arcsec']}\u2033 median seeing")
    reason_str = ", ".join(reasons) if reasons else "the best overall conditions"
    return (
        f"{best['label']} is the best pick tonight (score "
        f"{best['composite_score']}/100) thanks to {reason_str}."
    )


# ---------------------------------------------------------------------------
# Shared pipeline
# ---------------------------------------------------------------------------


async def _run_pipeline(req: PlanRequest) -> dict:
    obs = Observer(lat=req.lat, lon=req.lon, elevation_m=req.elevation_m)
    session = Session(
        duration_hours=req.duration_hours,
        min_alt_deg=req.min_alt_deg,
        date=req.date,
    )
    gear = Gear(aperture_mm=req.aperture_mm)

    catalog_rows = fetch_targets(
        object_types=_object_types_for_mode(req.mode),
        magnitude_limit=_mag_limit_for_aperture(req.aperture_mm),
        location=(req.lat, req.lon),
        min_angular_size_arcmin=0.5,
        row_limit=400,
    )

    # Optional named-catalog restriction (Messier / Caldwell / Herschel 400),
    # applied after the SIMBAD query and before visibility. If the filter would
    # leave too few candidates to make a useful plan, ignore it rather than
    # returning a near-empty session.
    if req.catalog_filter and req.catalog_filter in NAMED_CATALOGS and catalog_rows:
        filtered = filter_to_catalog(catalog_rows, req.catalog_filter)
        if len(filtered) >= _MIN_CATALOG_FILTER_TARGETS:
            catalog_rows = filtered
        else:
            logger.warning(
                "catalog_filter '%s' left only %d candidate(s) (<%d); ignoring filter",
                req.catalog_filter, len(filtered), _MIN_CATALOG_FILTER_TARGETS,
            )

    targets = to_targets(catalog_rows) if catalog_rows else SEED_CATALOG

    estimated_bortle = estimate_bortle(req.lat, req.lon)
    bortle = req.bortle_class or estimated_bortle

    fov_w, fov_h = _sensor_fov_deg(req)

    scored = plan_session(
        obs, session, targets, gear=gear,
        bortle_class=bortle, mode=req.mode,
        fov_width_deg=fov_w, fov_height_deg=fov_h,
    )
    notice = None if scored else _empty_plan_reason(obs, session, targets)

    # Anchor slot 0 at tonight's astronomical dusk so the 16 half-hour slots
    # cover the actual observable night window rather than the API call time.
    seeing_anchor = _seeing_anchor(obs, session)
    try:
        weather_history = await _weather_history_for_seeing(req.lat, req.lon, seeing_anchor)
    except Exception:
        weather_history = []
    seeing_forecast = _seeing.predict(weather_history, session_start=seeing_anchor)

    try:
        weather = await fetch_weather(req.lat, req.lon)
    except Exception:
        weather = None

    return {
        "request": {
            "lat": req.lat, "lon": req.lon,
            "aperture_mm": req.aperture_mm, "mode": req.mode,
            "user_id": req.user_id,
            "date": req.date.isoformat() if req.date else None,
        },
        "count": len(scored),
        "moon_illumination": scored[0].moon_illumination if scored else None,
        "weather": weather,
        "seeing_forecast": seeing_forecast,
        "seeing_model_loaded": _seeing.has_model,
        "targets": [_scored_to_json(r) for r in scored],
        "catalog_source": "simbad" if catalog_rows else "seed",
        "notice": notice,
        "bortle_class": bortle,
        "estimated_bortle": estimated_bortle,
        "fov_deg": (
            {"width": round(fov_w, 2), "height": round(fov_h, 2)}
            if fov_w and fov_h else None
        ),
    }


def _sensor_fov_deg(req: PlanRequest) -> tuple[Optional[float], Optional[float]]:
    """Field of view in degrees from sensor size + focal length.

    FoV_deg = (sensor_mm / focal_mm) * 57.3 (small-angle, degrees per radian).
    Only computed in astrophotographer mode when all three values are present.
    """
    if req.mode != "astrophotographer":
        return None, None
    f = req.focal_length_mm
    w = req.sensor_width_mm
    h = req.sensor_height_mm
    if not (f and w and h):
        return None, None
    return (w / f) * 57.3, (h / f) * 57.3


def _empty_plan_reason(obs: Observer, session: Session, targets) -> str:
    """Explain why a plan came back empty so the UI can show a real reason
    instead of a blank list. Distinguishes three cases: no catalog, no
    astronomical darkness in the window, or everything filtered out."""
    if not targets:
        return (
            "No catalog targets matched your magnitude/size limits. Try a "
            "larger aperture or a different observing mode."
        )
    from .pipeline.visibility import (
        compute_sky,
        location_for,
        session_start,
        time_grid,
    )

    loc = location_for(obs)
    sky = compute_sky(time_grid(session_start(obs, session, loc), session), loc)
    if not bool(sky.is_dark.any()):
        return (
            "No astronomical darkness during this window at this latitude and "
            "date \u2014 e.g. high-latitude summer 'white nights'. Try a date "
            "closer to winter, a lower latitude, or a longer session."
        )
    return (
        "Targets were above the horizon but none cleared your filters "
        "(minimum altitude, moon separation, or aperture limits). Try "
        "lowering the minimum altitude, extending the session, or observing "
        "on a darker (less moonlit) night."
    )


@app.get("/api/targets")
def api_targets(
    types: str = Query("galaxy,globular_cluster,nebula"),
    magnitude_limit: float = 10.0,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    min_angular_size_arcmin: float = 0.5,
    row_limit: int = 200,
):
    """Live SIMBAD catalog query. Cached at the edge by the Worker (24h)."""
    object_types = [t.strip() for t in types.split(",") if t.strip()]
    location = (lat, lon) if (lat is not None and lon is not None) else None
    rows = fetch_targets(
        object_types=object_types,
        magnitude_limit=magnitude_limit,
        location=location,
        min_angular_size_arcmin=min_angular_size_arcmin,
        row_limit=row_limit,
    )
    return {"count": len(rows), "targets": rows}


@app.get("/api/weather")
async def api_weather(lat: float, lon: float, days: int = 1):
    """Open-Meteo passthrough. Cached at the edge by the Worker (1h)."""
    try:
        if days <= 1:
            return await fetch_weather(lat, lon)
        return {"forecast": await fetch_nightly_forecast(lat, lon, days)}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"upstream weather error: {exc}")


# ---------------------------------------------------------------------------
# Legacy alias — preserves the unprefixed /plan route used before the worker
# ---------------------------------------------------------------------------


class LegacyPlanRequest(BaseModel):
    lat: float
    lon: float
    elevation_m: float = 0.0
    duration_hours: float = 4.0
    min_alt_deg: float = 25.0
    aperture_mm: float = 150.0
    date: Optional[datetime] = None


@app.post("/plan")
async def legacy_plan(req: LegacyPlanRequest):
    return await _run_pipeline(PlanRequest(**req.model_dump(), mode="observer"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _object_types_for_mode(mode: Mode) -> list[str]:
    if mode == "astrophotographer":
        # Long-exposure imaging favors extended emission and reflection objects.
        return ["galaxy", "nebula", "planetary_nebula", "supernova_remnant"]
    # Visual observer — anything bright and visually interesting.
    return ["galaxy", "globular_cluster", "open_cluster", "nebula", "planetary_nebula"]


# A named-catalog filter that leaves fewer than this many candidates is
# discarded (the plan is more useful unfiltered than nearly empty).
_MIN_CATALOG_FILTER_TARGETS = 5


def _mag_limit_for_aperture(aperture_mm: float) -> float:
    """Reasonable V-band cutoff for the catalog query given aperture size."""
    if aperture_mm < 70:   return 8.0
    if aperture_mm < 150:  return 9.5
    if aperture_mm < 250:  return 11.0
    return 12.5


_OPEN_METEO_HOURLY_URL = "https://api.open-meteo.com/v1/forecast"
# wind_u_10m / wind_v_10m are requested but not part of the standard
# Open-Meteo forecast schema, so we derive them from speed + direction
# below. Listing them is harmless (the API ignores unknown variables).
_HOURLY_VARS = (
    "temperature_2m,relativehumidity_2m,dewpoint_2m,pressure_msl,"
    "windspeed_10m,winddirection_10m,wind_u_10m,wind_v_10m,cloudcover"
)
# Pressure-level (upper-air) fields. Open-Meteo's free forecast endpoint
# exposes these via the ``_<level>hPa`` suffix in ``hourly`` and reports wind
# as speed + direction (no u/v), so we derive components with
# ``_wind_components`` just like the surface wind. Populating these activates
# the multi-site model's two highest-gain features (wind_shear_850_300 and
# tropopause_stability), which were always NaN at inference before.
_PRESSURE_LEVELS = (850, 500, 300, 200)
_PRESSURE_LEVEL_VARS = ",".join(
    f"temperature_{lvl}hPa,windspeed_{lvl}hPa,winddirection_{lvl}hPa"
    for lvl in _PRESSURE_LEVELS
)
# The seeing predictor needs two things from this window:
#   * a few hours of PAST weather so the rolling-window features
#     (temp_mean_3h, wind_speed_delta_30m, ...) have real data, and
#   * the upcoming night's FORECAST hours so each of the 16 half-hour slots
#     selects a distinct sample and the per-slot seeing/confidence actually
#     varies (otherwise every slot reuses the latest observation).
_HISTORY_PAST_HOURS = 4         # >= the 3h rolling window plus margin
_FORECAST_MARGIN_HOURS = 2     # margin past the last slot so it isn't clamped
_SESSION_SPAN_HOURS = NUM_SLOTS * SLOT_MINUTES / 60.0  # 16 x 30min = 8h


def _seeing_anchor(obs: Observer, session: Session) -> datetime:
    """Anchor the seeing forecast at tonight's astronomical dusk (sun < -18 deg).

    Reuses the pipeline's Astropy twilight solver. Falls back to ``now`` when
    dusk has already passed (a late-evening call), so the slots never start in
    the past.
    """
    now = datetime.now(tz=timezone.utc)
    try:
        dusk = session_start(obs, session, location_for(obs)).to_datetime(timezone=timezone.utc)
    except Exception:
        return now
    return dusk if dusk > now else now


async def _weather_history_for_seeing(
    lat: float, lon: float, anchor: Optional[datetime] = None,
) -> list[dict]:
    """Pull recent hourly weather from Open-Meteo for the seeing predictor.

    Returns one dict per hour with the field names ``api.ml.features``
    expects, so the rolling-window stats (temp_mean_3h,
    wind_speed_delta_30m, …) get real data instead of NaN. Wind u/v
    components are derived from speed + direction when the API doesn't
    supply ``wind_u_10m``/``wind_v_10m`` directly (which it currently
    doesn't), since ``features.py`` prefers u/v over speed+direction.

    The kept window spans a few PAST hours (for the rolling stats) through the
    end of the observing session anchored at ``anchor`` (default: now), so each
    of the 16 forecast slots selects a distinct forecast hour.
    """
    import httpx

    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": _HOURLY_VARS + "," + _PRESSURE_LEVEL_VARS,
        "past_days": 1,
        "forecast_days": 2,
        "timeformat": "unixtime",
        "windspeed_unit": "ms",
    }

    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(_OPEN_METEO_HOURLY_URL, params=params)
        resp.raise_for_status()
        payload = resp.json()

    hourly = payload.get("hourly") or {}
    times: list[int] = hourly.get("time") or []
    if not times:
        return []

    now_ts = int(datetime.now(tz=timezone.utc).timestamp())
    anchor_ts = int((anchor or datetime.now(tz=timezone.utc)).timestamp())
    window_lo = now_ts - _HISTORY_PAST_HOURS * 3600
    window_hi = anchor_ts + int((_SESSION_SPAN_HOURS + _FORECAST_MARGIN_HOURS) * 3600)

    rows: list[dict] = []
    for i, ts in enumerate(times):
        if ts < window_lo or ts > window_hi:
            continue  # keep recent past (rolling stats) + near-term forecast (per-slot)

        speed = _safe_get(hourly, "windspeed_10m", i)
        direction = _safe_get(hourly, "winddirection_10m", i)
        u = _safe_get(hourly, "wind_u_10m", i)
        v = _safe_get(hourly, "wind_v_10m", i)
        if u is None or v is None:
            u, v = _wind_components(speed, direction)

        row = {
            "timestamp": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "temperature_2m": _safe_get(hourly, "temperature_2m", i),
            "relative_humidity_2m": _safe_get(hourly, "relativehumidity_2m", i),
            "dewpoint_2m": _safe_get(hourly, "dewpoint_2m", i),
            "pressure_msl": _safe_get(hourly, "pressure_msl", i),
            "wind_speed_10m": speed,
            "wind_direction_10m": direction,
            "wind_u_10m": u,
            "wind_v_10m": v,
            "cloud_cover": _safe_get(hourly, "cloudcover", i),
            # Site geolocation features. Ignored by the single-site Stanford
            # model (it trained on NaN here) but used by the multi-site model
            # to condition on which observatory it is predicting for.
            "site_lat": lat,
            "site_lon": lon,
        }

        # Upper-air profile. Open-Meteo gives wind as speed + direction at each
        # pressure level, so derive (u, v) the same way as the surface wind and
        # expose them under the ``wind_u_<lvl>`` / ``wind_v_<lvl>`` keys that
        # ``features._level_wind`` reads. ``temp_500`` / ``temp_850`` feed the
        # tropopause-stability feature. These are real values now instead of the
        # NaN the live feed produced before, activating wind_shear_850_300 and
        # tropopause_stability (the multi-site model's two highest-gain features).
        for lvl in _PRESSURE_LEVELS:
            lvl_speed = _safe_get(hourly, f"windspeed_{lvl}hPa", i)
            lvl_dir = _safe_get(hourly, f"winddirection_{lvl}hPa", i)
            lvl_u, lvl_v = _wind_components(lvl_speed, lvl_dir)
            row[f"wind_u_{lvl}"] = lvl_u
            row[f"wind_v_{lvl}"] = lvl_v
            row[f"temp_{lvl}"] = _safe_get(hourly, f"temperature_{lvl}hPa", i)

        rows.append(row)

    return rows


def _wind_components(speed, direction):
    """Derive (u, v) m/s from meteorological speed + direction.

    Direction is the bearing the wind blows FROM (Open-Meteo convention).
    u is the eastward component, v the northward; both point in the
    direction the wind is going TO, matching ``features._resolve_wind``.
    """
    import math

    if speed is None or direction is None:
        return None, None
    rad = math.radians(direction)
    u = -speed * math.sin(rad)
    v = -speed * math.cos(rad)
    return u, v


def _safe_get(d: dict, key: str, i: int):
    arr = d.get(key)
    if not arr or i >= len(arr):
        return None
    return arr[i]


def _scored_to_json(r: Scored) -> dict:
    w_start, w_end, w_min = r.window
    t = r.target
    return {
        "name": t.name,
        "common_name": t.common_name,
        "kind": t.kind,
        "ra_deg": t.ra_deg,
        "dec_deg": t.dec_deg,
        "magnitude": t.magnitude,
        "score": round(r.score, 4),
        "components": {k: round(v, 4) for k, v in r.components.items()},
        "window_start": w_start.isoformat() if w_start else None,
        "window_end": w_end.isoformat() if w_end else None,
        "window_minutes": round(w_min, 1),
        "transit_time": r.transit_time.isoformat() if r.transit_time else None,
        "max_alt_deg": round(r.max_alt_deg, 1),
        "min_airmass": round(r.min_airmass, 2),
        "moon_sep_deg": round(r.moon_sep_deg, 1),
        "surface_brightness": (
            round(r.surface_brightness, 2) if r.surface_brightness is not None else None
        ),
        "sb_limit": round(r.sb_limit, 2),
        "why": r.why,
        "bortle_class": r.bortle_class,
        "sb_penalty": round(r.sb_penalty, 2),
        "filter_windows": r.filter_windows,
        "fov_note": r.fov_note,
        "fov_score": round(r.fov_score, 2) if r.fov_score is not None else None,
    }
