"""Claude Q&A explainer over OpenRouter.

Runs on the cheaper Haiku model and accepts the same plan context the
planner just emitted, so the assistant can answer follow-up questions
without re-deriving anything. History is capped at the most recent
``MAX_HISTORY_TURNS`` user/assistant pairs.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

from anthropic import AsyncAnthropic


logger = logging.getLogger(__name__)


# See planner.py — the Anthropic SDK auto-appends /v1/messages.
OPENROUTER_BASE_URL = "https://openrouter.ai/api"
# OpenRouter uses dots, not dashes, in the version segment.
EXPLAINER_MODEL = os.environ.get(
    "OPENROUTER_EXPLAINER_MODEL", "anthropic/claude-haiku-4.5"
)
MAX_HISTORY_TURNS = 6  # 6 user/assistant pairs = 12 messages


SYSTEM_PROMPT_TEMPLATE = (
    "You are Zenith's session assistant. Answer concisely about the user's "
    "observing plan. Reference real objects from the provided plan context. "
    "Never invent coordinates or catalog numbers — if a question requires "
    "data not in the plan context, say so plainly.\n\n"
    "## Plan context\n\n```json\n{plan_json}\n```"
)


class Explainer:
    """Anthropic-via-OpenRouter Q&A over the current session plan."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = EXPLAINER_MODEL,
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
                    "api_key= to Explainer()."
                )
            self._client = AsyncAnthropic(
                api_key=self.api_key,
                base_url=self.base_url,
            )
        return self._client

    async def ask(
        self,
        question: str,
        plan_context: dict,
        conversation_history: Optional[list[dict]] = None,
    ) -> str:
        """Return a plain-string answer.

        Args:
            question: the user's question.
            plan_context: the ``PlanResult.to_dict()`` payload (or any
                JSON-serializable dict). Injected verbatim into the system
                prompt.
            conversation_history: list of ``{"role", "content"}`` dicts
                from prior turns. Capped to the last ``MAX_HISTORY_TURNS``
                user/assistant pairs.
        """
        history = _truncate_history(conversation_history or [])
        system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
            plan_json=json.dumps(plan_context, default=str)
        )

        messages = list(history) + [{"role": "user", "content": question}]
        response = await self.client.messages.create(
            model=self.model,
            max_tokens=600,
            system=system_prompt,
            messages=messages,
        )

        return _extract_text(response)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _truncate_history(history: list[dict]) -> list[dict]:
    """Keep only the most recent ``MAX_HISTORY_TURNS`` user/assistant pairs."""
    if len(history) <= MAX_HISTORY_TURNS * 2:
        return history
    return history[-MAX_HISTORY_TURNS * 2:]


def _extract_text(response) -> str:
    if isinstance(response, str):
        return response
    content = getattr(response, "content", None)
    if not content:
        return ""
    first = content[0]
    return getattr(first, "text", "") or ""
