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

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv

# Load .env from the repo root before any module reads env vars. This is a
# no-op in production where env vars come from systemd / Cloudflare.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agent.explainer import Explainer
from .agent.planner import SessionPlanner
from .integrations.weather import fetch_nightly_forecast, fetch_weather
from .pipeline.catalog import SEED_CATALOG, fetch_targets, to_targets
from .pipeline.seeing import NUM_SLOTS, SeeingPredictor
from .pipeline.visibility import Gear, Observer, Scored, Session, plan_session


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

    # Optional knobs that mirror the legacy /plan contract.
    elevation_m: float = 0.0
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
    try:
        result = await _planner.plan(
            targets=base["targets"],
            seeing_forecast=base["seeing_forecast"],
            user_profile=None,
            mode=req.mode,
        )
        base["ai_plan"] = result.to_dict()
    except Exception as exc:  # missing key, OpenRouter outage, parse error
        base["ai_plan"] = {
            "ordered_targets": [],
            "session_summary": "",
            "session_notes": "",
            "error": str(exc),
        }
    return base


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
    targets = to_targets(catalog_rows) if catalog_rows else SEED_CATALOG

    scored = plan_session(obs, session, targets, gear=gear)

    try:
        weather_history = await _weather_history_for_seeing(req.lat, req.lon)
    except Exception:
        weather_history = []
    seeing_forecast = _seeing.predict(weather_history)

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
    }


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
_HISTORY_ENTRIES = 12  # last 12 hourly samples feeding the seeing features


async def _weather_history_for_seeing(lat: float, lon: float) -> list[dict]:
    """Pull recent hourly weather from Open-Meteo for the seeing predictor.

    Returns one dict per hour with the field names ``api.ml.features``
    expects, so the rolling-window stats (temp_mean_3h,
    wind_speed_delta_30m, …) get real data instead of NaN. Wind u/v
    components are derived from speed + direction when the API doesn't
    supply ``wind_u_10m``/``wind_v_10m`` directly (which it currently
    doesn't), since ``features.py`` prefers u/v over speed+direction.
    """
    import httpx

    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": _HOURLY_VARS,
        "past_days": 1,
        "forecast_days": 1,
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

    rows: list[dict] = []
    for i, ts in enumerate(times):
        if ts > now_ts:
            continue  # don't feed forecast values into the predictor's history

        speed = _safe_get(hourly, "windspeed_10m", i)
        direction = _safe_get(hourly, "winddirection_10m", i)
        u = _safe_get(hourly, "wind_u_10m", i)
        v = _safe_get(hourly, "wind_v_10m", i)
        if u is None or v is None:
            u, v = _wind_components(speed, direction)

        rows.append({
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
        })

    return rows[-_HISTORY_ENTRIES:]


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
    }
