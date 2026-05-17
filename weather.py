"""
weather.py - Fetch weather conditions relevant to stargazing
Uses: Open-Meteo API (free, no API key needed)

Week 3-4 focus: gather data on weather and coordinates
"""

import httpx
from dataclasses import dataclass


OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


@dataclass
class WeatherConditions:
    cloud_cover: float       # 0–100%
    humidity: float          # 0–100%
    visibility_km: float     # km
    wind_speed: float        # km/h
    temperature_c: float
    precipitation_mm: float  # current hour precipitation
    weather_score: float     # 0–1, 1 = perfect conditions


async def fetch_weather(lat: float, lon: float) -> dict:
    """
    Fetch current weather conditions from Open-Meteo (free, no key required).
    Returns a dict matching WeatherConditions fields.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": [
            "cloud_cover",
            "relative_humidity_2m",
            "precipitation",
            "wind_speed_10m",
            "temperature_2m",
            "visibility",
        ],
        "timezone": "auto",
        "forecast_days": 1,
    }

    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(OPEN_METEO_URL, params=params)
        response.raise_for_status()
        data = response.json()

    current = data.get("current", {})

    cloud_cover = current.get("cloud_cover", 100)
    humidity = current.get("relative_humidity_2m", 100)
    precipitation = current.get("precipitation", 0)
    wind_speed = current.get("wind_speed_10m", 0)
    temperature = current.get("temperature_2m", 0)
    visibility = current.get("visibility", 0) / 1000  # convert m → km

    score = _compute_weather_score(cloud_cover, humidity, precipitation, wind_speed)

    return {
        "cloud_cover": cloud_cover,
        "humidity": humidity,
        "precipitation_mm": precipitation,
        "wind_speed": wind_speed,
        "temperature_c": temperature,
        "visibility_km": visibility,
        "weather_score": score,
    }


def _compute_weather_score(
    cloud_cover: float,
    humidity: float,
    precipitation: float,
    wind_speed: float,
) -> float:
    """
    Heuristic weather score (0–1) for stargazing quality.
    Penalizes clouds, humidity, precipitation, and high winds.
    """
    if precipitation > 0:
        return 0.0  # Rain = definitely not tonight

    cloud_penalty = cloud_cover / 100  # 0 = clear, 1 = overcast
    humidity_penalty = max(0, (humidity - 60) / 40)  # penalty above 60%
    wind_penalty = max(0, (wind_speed - 20) / 30)     # penalty above 20 km/h

    score = 1.0 - (0.6 * cloud_penalty + 0.25 * humidity_penalty + 0.15 * wind_penalty)
    return max(0.0, min(1.0, score))


async def fetch_nightly_forecast(lat: float, lon: float, days: int = 7) -> list[dict]:
    """
    Fetch nightly weather forecast for upcoming evenings.
    Useful for the calendar feature (Week 7-8): find best nights to observe.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": ["cloud_cover_mean", "precipitation_sum", "wind_speed_10m_max"],
        "timezone": "auto",
        "forecast_days": days,
    }

    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(OPEN_METEO_URL, params=params)
        response.raise_for_status()
        data = response.json()

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    cloud_covers = daily.get("cloud_cover_mean", [])
    precipitation = daily.get("precipitation_sum", [])
    winds = daily.get("wind_speed_10m_max", [])

    return [
        {
            "date": dates[i],
            "cloud_cover": cloud_covers[i],
            "precipitation_mm": precipitation[i],
            "wind_speed": winds[i],
            "weather_score": _compute_weather_score(
                cloud_covers[i], 70, precipitation[i], winds[i]
            ),
        }
        for i in range(len(dates))
    ]