"""Small FastAPI server that exposes the planner.

Run:
    uvicorn api:app --reload

POST /plan with JSON like:
    {"lat": 37.87, "lon": -122.27, "duration_hours": 4, "aperture_mm": 150}
"""

from datetime import datetime
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from targets import CATALOG, Gear, Observer, Session, plan_session


app = FastAPI(title="Zenith")
app.mount("/static", StaticFiles(directory="website"), name="static")


class PlanRequest(BaseModel):
    lat: float
    lon: float
    elevation_m: float = 0.0
    duration_hours: float = 4.0
    min_alt_deg: float = 25.0
    aperture_mm: float = 150.0
    date: Optional[datetime] = Field(
        default=None,
        description="Anchor date (UTC). If omitted, uses tonight's twilight.",
    )


@app.get("/")
def root():
    return FileResponse("website/index.html")


@app.post("/plan")
def plan(req: PlanRequest):
    obs = Observer(lat=req.lat, lon=req.lon, elevation_m=req.elevation_m)
    session = Session(
        duration_hours=req.duration_hours,
        min_alt_deg=req.min_alt_deg,
        date=req.date,
    )
    results = plan_session(obs, session, CATALOG, gear=Gear(aperture_mm=req.aperture_mm))

    return {
        "count": len(results),
        "moon_illumination": results[0].moon_illumination if results else None,
        "targets": [_scored_to_json(r) for r in results],
    }


def _scored_to_json(r):
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
