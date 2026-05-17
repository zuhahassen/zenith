"""
agent.py - recommendation agent that generates natural language advice based on sky data and user preferences 
"""

import json
import os
from anthropic import AsyncAnthropic


SYSTEM_PROMPT = """You are StargazeAI, an expert astronomy assistant that helps amateur astronomers plan their observing sessions.

You receive structured data about:
- The observer's location and time
- A ranked list of currently visible celestial objects (with altitude, type, and score)
- Current weather conditions

Your job is to:
1. Give a brief, friendly overview of tonight's sky conditions
2. Recommend the top 3–5 objects to observe, explaining WHY each one is great tonight
3. Give beginner-friendly tips for finding and observing each object
4. If conditions are poor, suggest what to do instead (plan for a better night, study charts, etc.)

Keep your tone enthusiastic but grounded. Be specific — reference actual object names, altitudes, and conditions.
Always tailor advice to the user's experience level and stated interests.
"""


class StargazingAgent:
    def __init__(self, api_key: str | None = None):
        self.client = AsyncAnthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))

    async def recommend(
        self,
        location: dict,
        ranked_objects: list[dict],
        weather: dict,
        user_prefs: dict,
        conversation_history: list[dict] | None = None,
    ) -> str:
        """
        Generate a natural language stargazing recommendation.
        Supports multi-turn conversation via conversation_history.
        """
        # Build context payload
        context = {
            "location": location,
            "weather": weather,
            "user_preferences": user_prefs,
            "top_objects": ranked_objects,
        }

        user_message = f"""
Here is the current observing context:

```json
{json.dumps(context, indent=2, default=str)}
```

Please give me your stargazing recommendations for tonight.
""".strip()

        # Build message history (multi-turn support)
        messages = list(conversation_history or [])
        messages.append({"role": "user", "content": user_message})

        response = await self.client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            messages=messages,
        )

        return response.content[0].text

    async def chat(
        self,
        user_message: str,
        context: dict,
        history: list[dict],
    ) -> tuple[str, list[dict]]:
        """
        Interactive multi-turn chat with the agent.
        Returns (response_text, updated_history).
        
        Week 7-8: live updating as sky conditions change.
        """
        # Inject live context as a system-like preamble
        context_preamble = f"[Live context: {json.dumps(context, default=str)}]\n\n"
        full_message = context_preamble + user_message

        updated_history = history + [{"role": "user", "content": full_message}]

        response = await self.client.messages.create(
            model="claude-opus-4-5",
            max_tokens=800,
            system=SYSTEM_PROMPT,
            messages=updated_history,
        )

        reply = response.content[0].text
        updated_history.append({"role": "assistant", "content": reply})

        return reply, updated_history

    async def explain_object(self, object_name: str, experience_level: str = "beginner") -> str:
        """
        Get a detailed explanation of a specific celestial object.
        Useful for the "snapshot" feature in Week 3-4.
        """
        prompt = (
            f"Explain the celestial object '{object_name}' to a {experience_level} astronomer. "
            "Cover: what it is, what it looks like through a telescope, how to find it, "
            "and the best time of year to observe it. Keep it to 3–4 paragraphs."
        )

        response = await self.client.messages.create(
            model="claude-opus-4-5",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )

        return response.content[0].text