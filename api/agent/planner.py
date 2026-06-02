"""Claude session planner over OpenRouter.

Calls Anthropic via OpenRouter and returns an AI-ordered observing plan
plus markdown notes. The deterministic pipeline (visibility + scorer) runs
first and provides the *factual* context Claude is then asked to curate
and explain — Claude never invents coordinates or catalog numbers.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from anthropic import AsyncAnthropic


logger = logging.getLogger(__name__)


# The Anthropic SDK appends `/v1/messages` to base_url automatically.
# OpenRouter's Anthropic-compatible endpoint is at /api/v1/messages, so
# base_url must be /api — anything ending in /v1 produces /v1/v1/messages
# and a 404.
OPENROUTER_BASE_URL = "https://openrouter.ai/api"
# OpenRouter uses dots, not dashes, in the version segment.
# Override with OPENROUTER_PLANNER_MODEL if the catalog ID ever changes.
PLANNER_MODEL = os.environ.get(
    "OPENROUTER_PLANNER_MODEL", "anthropic/claude-sonnet-4.5"
)

MAX_TARGETS_IN_CONTEXT = 30


# ---------------------------------------------------------------------------
# Prompt sections (kept as module-level constants for inspection + tests)
# ---------------------------------------------------------------------------

SYSTEM_ROLE = (
    "You are Zenith's observation planner. You produce a JSON plan block "
    "first, then a markdown explanation. Never hallucinate object "
    "coordinates or catalog numbers — all factual astronomy data comes "
    "from the structured context below. Be concise and direct."
)

OUTPUT_SCHEMA = """## Output format

Return your response in exactly this format and nothing else:

```json
{
  "plan": [
    {
      "name": "M13",
      "slot": "2026-06-02T05:30:00+00:00",
      "object_type": "GlCl",
      "why": "one sentence — why this target, this slot",
      "seeing_at_slot": 1.8
    }
  ],
  "session_summary": "2-3 sentence summary of the night."
}
```

After the closing fence, write a markdown section that starts with
`## Session notes` and contains 2–4 short paragraphs of observing guidance
(setup tips, ordering rationale, contingencies). Do not include any other
prose outside the JSON block and the `## Session notes` section.
"""


@dataclass
class PlanResult:
    """Parsed Claude output."""
    ordered_targets: list[dict] = field(default_factory=list)
    session_summary: str = ""
    session_notes: str = ""
    raw_response: str = ""

    def to_dict(self) -> dict:
        return {
            "ordered_targets": self.ordered_targets,
            "session_summary": self.session_summary,
            "session_notes": self.session_notes,
        }


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


class SessionPlanner:
    """Anthropic-via-OpenRouter session planner."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = PLANNER_MODEL,
        base_url: str = OPENROUTER_BASE_URL,
    ):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        self.model = model
        self.base_url = base_url
        self._client: Optional[AsyncAnthropic] = None

    @property
    def client(self) -> AsyncAnthropic:
        if self._client is None:
            if not self.api_key:
                raise RuntimeError(
                    "OPENROUTER_API_KEY is not set. Add it to .env or pass "
                    "api_key= to SessionPlanner()."
                )
            self._client = AsyncAnthropic(
                api_key=self.api_key,
                base_url=self.base_url,
            )
        return self._client

    async def plan(
        self,
        targets: list[dict],
        seeing_forecast: list[dict],
        user_profile: Optional[dict] = None,
        mode: str = "observer",
    ) -> PlanResult:
        """Produce an AI-ordered plan from a scored target list.

        Args:
            targets: scored targets from the deterministic pipeline
                (output of ``/api/plan``). Top ``MAX_TARGETS_IN_CONTEXT``
                are passed to Claude.
            seeing_forecast: the 16-slot ``SeeingPredictor`` output.
            user_profile: optional dict with ``mode``, ``equipment``,
                ``target_feedback`` keys (D1 user_profiles row).
            mode: ``"observer"`` or ``"astrophotographer"`` — fall-through
                default when ``user_profile`` is missing.
        """
        context = self._build_context(targets, seeing_forecast, user_profile, mode)
        system_prompt = self._compose_system_prompt(context)

        response = await self.client.messages.create(
            model=self.model,
            max_tokens=2500,
            system=system_prompt,
            messages=[{"role": "user", "content": "Plan tonight's session."}],
        )

        text = _extract_text(response)
        return parse_plan_response(text)

    # ------------------------------------------------------------------
    # Context construction
    # ------------------------------------------------------------------

    @staticmethod
    def _build_context(
        targets: list[dict],
        seeing_forecast: list[dict],
        user_profile: Optional[dict],
        mode: str,
    ) -> dict:
        top = targets[:MAX_TARGETS_IN_CONTEXT]
        ctx: dict[str, Any] = {
            "mode": mode,
            "top_targets": [_slim_target(t) for t in top],
            "seeing_forecast": seeing_forecast,
        }
        if user_profile:
            ctx["user_profile"] = {
                "mode": user_profile.get("mode", mode),
                "equipment": user_profile.get("equipment", {}),
                "target_feedback": user_profile.get("target_feedback", []),
            }
        return ctx

    @staticmethod
    def _compose_system_prompt(context: dict) -> str:
        ctx_json = json.dumps(context, indent=2, default=str)
        sections = [
            SYSTEM_ROLE,
            "## Structured context\n\n```json\n" + ctx_json + "\n```",
        ]
        feedback = (context.get("user_profile") or {}).get("target_feedback")
        if feedback:
            liked = feedback.get("liked") if isinstance(feedback, dict) else None
            disliked = feedback.get("disliked") if isinstance(feedback, dict) else None
            lines = ["## User feedback"]
            if liked:
                lines.append(
                    "The user has previously rated these targets positively: "
                    f"{', '.join(liked)}. Favour them and similar objects."
                )
            if disliked:
                lines.append(
                    "Avoid re-recommending targets the user rated negatively: "
                    f"{', '.join(disliked)}."
                )
            if len(lines) > 1:
                sections.append("\n".join(lines))
        sections.append(OUTPUT_SCHEMA)
        return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
_NOTES_RE = re.compile(r"##\s*Session notes\s*\n(.*)$", re.DOTALL | re.IGNORECASE)


def parse_plan_response(text: str) -> PlanResult:
    """Split Claude's response into the JSON plan and the markdown notes."""
    plan_payload: dict[str, Any] = {}
    match = _JSON_BLOCK_RE.search(text)
    if match:
        try:
            plan_payload = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse plan JSON block: %s", exc)
            plan_payload = {}
    else:
        logger.warning("No ```json plan block found in planner response")

    notes_match = _NOTES_RE.search(text)
    notes = notes_match.group(1).strip() if notes_match else ""

    return PlanResult(
        ordered_targets=plan_payload.get("plan", []) or [],
        session_summary=plan_payload.get("session_summary", "") or "",
        session_notes=notes,
        raw_response=text,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slim_target(t: dict) -> dict:
    """Reduce a scored target row to just the fields Claude needs.

    Keeps the prompt small and prevents Claude from inventing fields it
    doesn't have permission to surface.
    """
    return {
        "name": t.get("name"),
        "common_name": t.get("common_name"),
        "type": t.get("kind") or t.get("type"),
        "score": t.get("score"),
        "peak_alt_deg": t.get("max_alt_deg"),
        "best_window": [t.get("window_start"), t.get("window_end")],
        "transit_time": t.get("transit_time"),
        "magnitude": t.get("magnitude"),
        "moon_sep_deg": t.get("moon_sep_deg"),
        "surface_brightness": t.get("surface_brightness"),
        "why": t.get("why"),
    }


def _extract_text(response: Any) -> str:
    """Tolerant text extraction. The Anthropic SDK returns a Message with
    a ``content`` list; the first block is typically a TextBlock with a
    ``.text`` attribute. Mocks in tests may return a plain string."""
    if isinstance(response, str):
        return response
    content = getattr(response, "content", None)
    if not content:
        return ""
    first = content[0]
    return getattr(first, "text", "") or ""
