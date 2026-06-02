"""Mocked Claude tests. No network access.

The planner and explainer both go through ``self.client.messages.create``;
we monkeypatch that to return a stub object shaped like the Anthropic SDK
response. The actual Anthropic types use ``response.content[0].text``,
so the stubs match that shape.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from api.agent.explainer import Explainer, MAX_HISTORY_TURNS
from api.agent.planner import (
    PlanResult,
    SessionPlanner,
    parse_plan_response,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stub_response(text: str) -> SimpleNamespace:
    return SimpleNamespace(content=[SimpleNamespace(text=text)])


class _FakeMessages:
    def __init__(self, response_text: str):
        self.response_text = response_text
        self.calls: list[dict] = []

    async def create(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        return _stub_response(self.response_text)


class _FakeClient:
    def __init__(self, response_text: str):
        self.messages = _FakeMessages(response_text)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


PLANNER_OUTPUT = """```json
{
  "plan": [
    {"name": "M13", "slot": "2026-06-02T05:30:00+00:00", "object_type": "GlCl", "why": "globular peaks early", "seeing_at_slot": 1.8},
    {"name": "M57", "slot": "2026-06-02T07:00:00+00:00", "object_type": "Nebula", "why": "small but bright", "seeing_at_slot": 2.0}
  ],
  "session_summary": "Two solid summer targets near the meridian."
}
```

## Session notes

Start with M13 while it's still climbing; the cluster benefits from any
seeing improvement during the night. Switch to M57 once Lyra is high.
"""


def test_parse_plan_response_extracts_json_and_notes():
    result = parse_plan_response(PLANNER_OUTPUT)
    assert len(result.ordered_targets) == 2
    assert result.ordered_targets[0]["name"] == "M13"
    assert result.session_summary.startswith("Two solid")
    assert "Start with M13" in result.session_notes


def test_parse_plan_response_handles_garbage_json():
    bad = "```json\n{ this is not json\n```\n## Session notes\nstill works"
    result = parse_plan_response(bad)
    assert result.ordered_targets == []
    assert result.session_summary == ""
    assert "still works" in result.session_notes


def test_parse_plan_response_handles_missing_blocks():
    result = parse_plan_response("nothing useful here")
    assert result == PlanResult(
        ordered_targets=[], session_summary="", session_notes="",
        raw_response=result.raw_response,
    )


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_planner_calls_openrouter_with_expected_shape(monkeypatch):
    fake = _FakeClient(PLANNER_OUTPUT)
    planner = SessionPlanner(api_key="test-key")
    monkeypatch.setattr(planner, "_client", fake)

    targets = [
        {"name": f"T{i}", "kind": "Galaxy", "score": 0.9 - i * 0.01,
         "max_alt_deg": 60, "window_start": "2026-06-02T05:00:00+00:00",
         "window_end": "2026-06-02T07:00:00+00:00", "magnitude": 8.0}
        for i in range(40)  # > MAX_TARGETS_IN_CONTEXT
    ]
    seeing_forecast = [{"slot": f"2026-06-02T0{h}:00:00+00:00",
                        "predicted_seeing_arcsec": 2.0, "confidence": 0.7}
                       for h in range(5, 9)]

    result = await planner.plan(
        targets=targets,
        seeing_forecast=seeing_forecast,
        user_profile={"mode": "observer", "equipment": {"aperture_mm": 150},
                      "target_feedback": []},
        mode="observer",
    )

    # Result parsed correctly
    assert isinstance(result, PlanResult)
    assert len(result.ordered_targets) == 2
    assert result.ordered_targets[0]["name"] == "M13"

    # Exactly one call to Claude
    assert len(fake.messages.calls) == 1
    call = fake.messages.calls[0]
    assert call["model"] == "anthropic/claude-sonnet-4.5"
    assert call["max_tokens"] >= 2000

    # System prompt has all three sections
    system = call["system"]
    assert "You are Zenith's observation planner" in system
    assert "Structured context" in system
    assert "Output format" in system

    # Only top 30 targets sent (not all 40)
    assert "T0" in system
    assert "T29" in system
    assert "T30" not in system

    # Seeing forecast included
    assert "predicted_seeing_arcsec" in system

    # User profile included when provided
    assert "target_feedback" in system


@pytest.mark.asyncio
async def test_planner_omits_user_profile_when_none(monkeypatch):
    fake = _FakeClient(PLANNER_OUTPUT)
    planner = SessionPlanner(api_key="test-key")
    monkeypatch.setattr(planner, "_client", fake)

    await planner.plan(targets=[], seeing_forecast=[], user_profile=None)
    call = fake.messages.calls[0]
    assert "target_feedback" not in call["system"]


def test_planner_requires_api_key():
    planner = SessionPlanner(api_key=None)
    planner.api_key = None  # belt + suspenders if env had it
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        _ = planner.client


# ---------------------------------------------------------------------------
# Explainer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_explainer_uses_haiku_and_includes_plan_context(monkeypatch):
    fake = _FakeClient("Sure — start with M13 while it's high.")
    explainer = Explainer(api_key="test-key")
    monkeypatch.setattr(explainer, "_client", fake)

    plan_context = {"ordered_targets": [{"name": "M13"}], "session_summary": "..."}
    answer = await explainer.ask(
        question="What should I look at first?",
        plan_context=plan_context,
        conversation_history=[],
    )

    assert "M13" in answer
    call = fake.messages.calls[0]
    assert call["model"] == "anthropic/claude-haiku-4.5"
    assert "M13" in call["system"]
    assert call["messages"][-1] == {
        "role": "user",
        "content": "What should I look at first?",
    }


@pytest.mark.asyncio
async def test_explainer_truncates_history(monkeypatch):
    fake = _FakeClient("ok")
    explainer = Explainer(api_key="test-key")
    monkeypatch.setattr(explainer, "_client", fake)

    # 10 prior turns (20 messages) — should be trimmed to MAX_HISTORY_TURNS pairs.
    history = []
    for i in range(10):
        history.append({"role": "user", "content": f"q{i}"})
        history.append({"role": "assistant", "content": f"a{i}"})

    await explainer.ask("next question", plan_context={}, conversation_history=history)
    messages = fake.messages.calls[0]["messages"]
    # MAX_HISTORY_TURNS pairs + the new user message
    assert len(messages) == MAX_HISTORY_TURNS * 2 + 1
    assert messages[-1]["content"] == "next question"
