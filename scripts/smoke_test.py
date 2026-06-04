#!/usr/bin/env python3
"""
Zenith smoke test — run after every deployment.

Usage:
    python scripts/smoke_test.py [--base-url http://localhost]
                                 [--skip "plan AI" --skip "explain"]

After running scripts/update_backend.sh on the droplet, run:
    python scripts/smoke_test.py --base-url http://localhost
to verify the full stack is healthy.

Notes
-----
* The plan/AI endpoints can take tens of seconds (live SIMBAD + Open-Meteo +
  Claude), so those requests use a 60 s timeout.
* /api/feedback, /api/community-favorites and /api/history are served by the
  Cloudflare Worker (D1), NOT by the FastAPI origin. When the base URL points
  at the droplet (http://localhost) these return 404 and are reported as
  SKIP (edge-only) rather than failures. Point --base-url at the Worker URL to
  exercise them end-to-end.
* Assertions match the real response contracts in api/main.py and worker/.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Callable, Optional

import httpx

# ANSI colors (disabled automatically when stdout is not a TTY).
_TTY = sys.stdout.isatty()
def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text
GREEN = lambda s: _c("32", s)
RED = lambda s: _c("31", s)
YELLOW = lambda s: _c("33", s)
DIM = lambda s: _c("2", s)

PLAN_TIMEOUT = 60.0
DEFAULT_TIMEOUT = 20.0


class Test:
    def __init__(
        self,
        name: str,
        method: str,
        path: str,
        body: Optional[dict],
        assertions: list[Callable[[dict], bool]],
        *,
        edge_only: bool = False,
        timeout: float = DEFAULT_TIMEOUT,
        expect_status: int = 200,
    ):
        self.name = name
        self.method = method
        self.path = path
        self.body = body
        self.assertions = assertions
        self.edge_only = edge_only
        self.timeout = timeout
        # Expected HTTP status for the happy path (e.g. 404 for not-found tests).
        self.expect_status = expect_status


# Real contracts (see api/main.py and worker/index.js + worker/db.js).
TESTS: list[Test] = [
    Test("health", "GET", "/api/health", None, [
        lambda r: r["status"] == "ok",
        lambda r: "seeing_model_loaded" in r,
        lambda r: "openrouter_configured" in r,
    ]),

    Test("weather", "GET", "/api/weather?lat=37.87&lon=-122.27", None, [
        lambda r: isinstance(r, dict),
        lambda r: "cloud_cover" in r or "temperature_2m" in r or "current" in r,
    ]),

    Test("plan deterministic", "POST", "/api/plan", {
        "lat": 37.87, "lon": -122.27, "aperture_mm": 150, "mode": "observer",
    }, [
        lambda r: r["count"] > 0,
        lambda r: len(r["targets"]) > 0,
        lambda r: len(r["seeing_forecast"]) == 16,
        lambda r: r["seeing_forecast"][0]["predicted_seeing_arcsec"] > 0,
        # Per-slot seeing genuinely varies across the night (not one repeated value).
        lambda r: len({round(s["predicted_seeing_arcsec"], 4)
                       for s in r["seeing_forecast"]}) > 1,
    ], timeout=PLAN_TIMEOUT),

    Test("plan AI", "POST", "/api/plan-ai", {
        "lat": 37.87, "lon": -122.27, "aperture_mm": 150, "mode": "observer",
    }, [
        lambda r: r["count"] > 0,
        lambda r: r["ai_plan"] is not None,
        lambda r: len(r["ai_plan"]["ordered_targets"]) > 0,
        lambda r: "why" in r["ai_plan"]["ordered_targets"][0],
        lambda r: "observer_note" in r["ai_plan"]["ordered_targets"][0],
        lambda r: "reference_image" in r["ai_plan"]["ordered_targets"][0],
        lambda r: r["ai_plan"]["session_summary"] != "",
    ], timeout=PLAN_TIMEOUT),

    Test("explain", "POST", "/api/explain", {
        "question": "What is the best target tonight?",
        "plan_context": {"ordered_targets": [{"name": "NGC 891", "object_type": "Gx"}]},
        "history": [],
    }, [
        lambda r: "answer" in r,
        lambda r: len(r["answer"]) > 20,
    ], timeout=PLAN_TIMEOUT),

    # Real compare-sites contract: sites carry `label` (not `name`); each result
    # has `composite_score` + `top_targets`; the payload has `best_site` +
    # `recommendation` (not `recommended`/`site_score`/`top_3_targets`).
    Test("compare sites", "POST", "/api/compare-sites", {
        "sites": [
            {"label": "Berkeley", "lat": 37.87, "lon": -122.27},
            {"label": "Mt Tam", "lat": 37.92, "lon": -122.60},
        ],
        "aperture_mm": 150,
        "mode": "observer",
    }, [
        lambda r: len(r["sites"]) == 2,
        lambda r: "recommendation" in r and "best_site" in r,
        lambda r: all("composite_score" in s for s in r["sites"]),
        lambda r: all("top_targets" in s for s in r["sites"]),
    ], timeout=PLAN_TIMEOUT),

    # Edge-only (Cloudflare Worker + D1): 404 against the FastAPI origin.
    Test("feedback", "POST", "/api/feedback", {
        "user_id": "smoke-test-user",
        "target_name": "NGC 891",
        "rating": 1,
    }, [
        lambda r: r.get("ok") is True,
    ], edge_only=True),

    Test("community favorites", "GET", "/api/community-favorites?limit=5", None, [
        lambda r: "favorites" in r,
        lambda r: isinstance(r["favorites"], list),
    ], edge_only=True),

    Test("history", "GET", "/api/history?user_id=smoke-test-user&limit=5", None, [
        lambda r: "sessions" in r,
        lambda r: isinstance(r["sessions"], list),
    ], edge_only=True),

    Test("catalog messier", "POST", "/api/plan", {
        "lat": 37.87, "lon": -122.27, "aperture_mm": 150,
        "mode": "observer", "catalog_filter": "messier",
    }, [
        lambda r: r["count"] > 0,
        # Filter may be ignored if it leaves <5 candidates, so assert leniently:
        # at least one of the top targets is a Messier object when applied.
        lambda r: any(t["name"].startswith("M") for t in r["targets"][:10]),
    ], timeout=PLAN_TIMEOUT),

    Test("astrophotographer mode", "POST", "/api/plan-ai", {
        "lat": 37.87, "lon": -122.27, "aperture_mm": 200,
        "mode": "astrophotographer",
        "focal_length_mm": 750, "sensor_width_mm": 23.5, "sensor_height_mm": 15.6,
    }, [
        lambda r: r["count"] > 0,
        lambda r: any(t.get("filter_windows") for t in r["targets"][:10]),
        lambda r: any(t.get("fov_note") for t in r["targets"][:10]),
    ], timeout=PLAN_TIMEOUT),

    # Auth: edge-only (Cloudflare Worker + D1). Returns 404 against the FastAPI
    # origin (skip), or the generic "check your email" message via the Worker.
    # We never assert email delivery.
    Test("auth request", "POST", "/api/auth/request", {
        "email": "smoke-test@example.com",
    }, [
        lambda r: "message" in r or "ok" in r,
    ], edge_only=True),

    # Multi-night calendar: M 42 over two months. Served by both the FastAPI
    # origin and the Worker (KV-cached), so it is NOT edge-only.
    Test("calendar M42", "POST", "/api/calendar", {
        "lat": 37.87, "lon": -122.27,
        "target_name": "M 42",
        "start_date": "2026-11-01",
        "end_date": "2026-12-31",
        "aperture_mm": 150,
    }, [
        lambda r: "nights" in r,
        lambda r: len(r["nights"]) > 0,
        lambda r: "target" in r,
        lambda r: r["target"]["name"] != "",
        lambda r: any(n["observable"] for n in r["nights"]),
        lambda r: all("quality_score" in n or not n["observable"] for n in r["nights"]),
    ], timeout=PLAN_TIMEOUT),

    # Unresolvable target → 404 with a top-level error + suggestion.
    Test("calendar not found", "POST", "/api/calendar", {
        "lat": 37.87, "lon": -122.27,
        "target_name": "NotARealObject12345",
        "start_date": "2026-06-01",
        "end_date": "2026-06-30",
    }, [
        lambda r: "error" in r,
    ], expect_status=404, timeout=PLAN_TIMEOUT),
]


def run_test(client: httpx.Client, base_url: str, test: Test) -> str:
    """Run one test. Returns 'pass' | 'fail' | 'skip'."""
    url = base_url.rstrip("/") + test.path
    started = time.perf_counter()
    try:
        if test.method == "GET":
            resp = client.get(url, timeout=test.timeout)
        else:
            resp = client.post(url, json=test.body, timeout=test.timeout)
    except Exception as exc:
        elapsed = time.perf_counter() - started
        print(f"{RED('✗')} {test.name} {DIM(f'({elapsed:.2f}s)')} — request error: {exc}")
        return "fail"

    elapsed = time.perf_counter() - started

    # Edge-only endpoints aren't served by the FastAPI origin.
    if resp.status_code in (404, 405) and test.edge_only:
        print(f"{YELLOW('○')} {test.name} {DIM(f'({elapsed:.2f}s)')} — skip (edge-only, not served at this base URL)")
        return "skip"

    if resp.status_code != test.expect_status:
        print(
            f"{RED('✗')} {test.name} {DIM(f'({elapsed:.2f}s)')} — "
            f"HTTP {resp.status_code} (expected {test.expect_status})"
        )
        _dump(resp.text)
        return "fail"

    try:
        data = resp.json()
    except Exception:
        print(f"{RED('✗')} {test.name} {DIM(f'({elapsed:.2f}s)')} — response not JSON")
        _dump(resp.text)
        return "fail"

    for i, assertion in enumerate(test.assertions, start=1):
        try:
            ok = assertion(data)
        except Exception as exc:
            print(f"{RED('✗')} {test.name} {DIM(f'({elapsed:.2f}s)')} — assertion {i} raised {type(exc).__name__}: {exc}")
            _dump(json.dumps(data))
            return "fail"
        if not ok:
            print(f"{RED('✗')} {test.name} {DIM(f'({elapsed:.2f}s)')} — assertion {i} failed")
            _dump(json.dumps(data))
            return "fail"

    print(f"{GREEN('✓')} {test.name} {DIM(f'({elapsed:.2f}s)')}")
    return "pass"


def _dump(text: str) -> None:
    snippet = text[:500]
    print(DIM(f"    response: {snippet}{'…' if len(text) > 500 else ''}"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Zenith API smoke test")
    parser.add_argument("--base-url", default="http://localhost",
                        help="API base URL (default: http://localhost)")
    parser.add_argument("--skip", action="append", default=[],
                        help="Test name(s) to skip, e.g. --skip 'plan AI'. Repeatable.")
    args = parser.parse_args()

    skip = {s.strip().lower() for s in args.skip}

    print(DIM(f"Zenith smoke test → {args.base_url}\n"))
    started = time.perf_counter()
    passed = failed = skipped = 0

    with httpx.Client(follow_redirects=True) as client:
        for test in TESTS:
            if test.name.lower() in skip:
                print(f"{YELLOW('○')} {test.name} — skip (--skip)")
                skipped += 1
                continue
            result = run_test(client, args.base_url, test)
            if result == "pass":
                passed += 1
            elif result == "skip":
                skipped += 1
            else:
                failed += 1

    elapsed = time.perf_counter() - started
    total = passed + failed
    summary = f"\n{passed}/{total} tests passed"
    if skipped:
        summary += f", {skipped} skipped"
    summary += f" ({elapsed:.1f}s elapsed)"
    print(GREEN(summary) if failed == 0 else RED(summary))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
