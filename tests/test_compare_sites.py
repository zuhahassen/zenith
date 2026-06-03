"""Tests for /api/compare-sites scoring, ranking, and graceful LLM fallback."""

import api.main as main
from api.main import CompareSite, _heuristic_recommendation, _score_site
from fastapi.testclient import TestClient


def _plan(bortle, weather_score, cloud, seeing_vals, n_targets):
    return {
        "bortle_class": bortle,
        "weather": {"weather_score": weather_score, "cloud_cover": cloud},
        "seeing_forecast": [{"predicted_seeing_arcsec": v} for v in seeing_vals],
        "targets": [{"name": f"M {i}"} for i in range(1, n_targets + 1)],
    }


def test_score_site_composite_math():
    site = CompareSite(label="Dark Site", lat=38.7, lon=-123.0)
    # Bortle 3, clear, good seeing, plenty of targets.
    plan = _plan(3, 0.9, 10.0, [1.5, 1.5, 1.5], 25)
    s = _score_site(site, plan)

    assert s["subscores"]["darkness"] == round((9 - 3) / 8.0, 3)  # 0.75
    assert s["subscores"]["weather"] == 0.9
    assert s["subscores"]["targets"] == 1.0  # 25 saturates
    # Seeing 1.5" between 1.0 (best) and 3.5 (worst) -> (3.5-1.5)/2.5 = 0.8
    assert s["subscores"]["seeing"] == 0.8
    assert s["median_seeing_arcsec"] == 1.5
    assert s["top_targets"] == ["M 1", "M 2", "M 3"]


def test_darker_clearer_site_outranks_bright_one():
    dark = _score_site(
        CompareSite(label="Dark", lat=0, lon=0), _plan(3, 0.9, 10, [1.4], 20)
    )
    bright = _score_site(
        CompareSite(label="City", lat=0, lon=0), _plan(8, 0.6, 40, [2.0], 20)
    )
    assert dark["composite_score"] > bright["composite_score"]


def test_heuristic_recommendation_cites_factors():
    best = _score_site(
        CompareSite(label="Lake Sonoma", lat=38.7, lon=-123.0),
        _plan(4, 0.85, 15.0, [1.6], 18),
    )
    sentence = _heuristic_recommendation([best])
    assert "Lake Sonoma" in sentence
    assert "Bortle 4" in sentence
    assert "15% cloud cover" in sentence


def test_endpoint_ranks_and_falls_back_without_llm(monkeypatch):
    plans = {
        37.87: _plan(6, 0.7, 30, [1.9], 15),   # Berkeley (bright)
        37.93: _plan(5, 0.8, 20, [1.7], 18),   # Mt Tamalpais
        38.71: _plan(3, 0.85, 12, [1.6], 22),  # Lake Sonoma (darkest)
    }

    async def fake_pipeline(req):
        return plans[round(req.lat, 2)]

    monkeypatch.setattr(main, "_run_pipeline", fake_pipeline)
    monkeypatch.setattr(main._explainer, "api_key", None)  # force heuristic path

    client = TestClient(main.app)
    resp = client.post(
        "/api/compare-sites",
        json={
            "sites": [
                {"label": "Berkeley", "lat": 37.87, "lon": -122.27},
                {"label": "Mount Tamalpais", "lat": 37.93, "lon": -122.60},
                {"label": "Lake Sonoma", "lat": 38.71, "lon": -123.05},
            ],
            "aperture_mm": 200,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["best_site"] == "Lake Sonoma"
    # Sorted best-first.
    scores = [s["composite_score"] for s in body["sites"]]
    assert scores == sorted(scores, reverse=True)
    assert "Lake Sonoma" in body["recommendation"]
