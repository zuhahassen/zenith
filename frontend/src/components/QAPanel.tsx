import { useState } from "react";
import { useExplainer } from "../hooks/useExplainer";
import type { ChatMessage } from "../types/zenith";

interface Props {
  planContext: Record<string, unknown>;
}

export function QAPanel({ planContext }: Props) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const explainer = useExplainer();

  function send() {
    const question = draft.trim();
    if (!question || explainer.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setDraft("");
    explainer
      .mutateAsync({ question, plan_context: planContext, history: messages })
      .then((res) => setMessages((m) => [...m, { role: "assistant", content: res.answer }]))
      .catch((err) =>
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `Error: ${err.message || "request failed"}` },
        ]),
      );
  }

  return (
    <div className="qa">
      <div className="tsection" style={{ borderTop: "none", paddingBottom: 0 }}>
        <div className="label">Ask about this session</div>
      </div>
      <div className="qa__log">
        {messages.length === 0 && (
          <div className="qa__hint">
            Ask anything about tonight's plan — alternative targets, why one object
            ranked higher, observing tips.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`qa__line--${m.role}`}>
            {m.content}
          </div>
        ))}
        {explainer.isPending && (
          <span className="typing">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      <div className="qa__input">
        <span className="qa__prompt">&gt;</span>
        <input
          type="text"
          placeholder="ask…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
    </div>
  );
}
