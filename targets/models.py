"""Dataclasses for the planner: inputs, a target, and a scored result."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class Observer:
    lat: float
    lon: float
    elevation_m: float = 0.0
    name: Optional[str] = None


@dataclass(frozen=True)
class Session:
    duration_hours: float = 4.0
    step_minutes: float = 10.0
    min_alt_deg: float = 25.0
    start: Optional[datetime] = None   # explicit UTC start
    date: Optional[datetime] = None    # falls back to twilight on this date


@dataclass(frozen=True)
class Target:
    name: str
    ra_deg: float
    dec_deg: float
    magnitude: Optional[float] = None
    size_arcmin: Optional[tuple[float, float]] = None  # (major, minor) semi-axes
    kind: str = "Unknown"  # "Galaxy" | "Nebula" | "GlCl" | "OpenCl" | ...
    common_name: Optional[str] = None


@dataclass(frozen=True)
class Gear:
    aperture_mm: float = 100.0


@dataclass(frozen=True)
class Preferences:
    preferred_kinds: tuple[str, ...] = ()
    last_viewed: dict[str, datetime] = field(default_factory=dict)


@dataclass
class Scored:
    target: Target
    score: float
    components: dict[str, float]            # s1..s5
    window: tuple[Optional[datetime], Optional[datetime], float]  # start, end, minutes
    transit_time: Optional[datetime]
    max_alt_deg: float
    min_airmass: float
    moon_sep_deg: float
    moon_illumination: float
    surface_brightness: Optional[float]
    sb_limit: float
    why: str
