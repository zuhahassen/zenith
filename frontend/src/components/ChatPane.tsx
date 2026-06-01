import { useState } from "react";
import { ArrowUp, Send } from "lucide-react";
import { useExplainer } from "../hooks/useExplainer";
import type { ChatMessage } from "../types/zenith";

interface Props {
  planContext: Record<string, unknown>;
}

export function ChatPane({ planContext }: Props) {
  const [open, setOpen] = useState(false);
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
      .mutateAsync({
        question,
        plan_context: planContext,
        history: messages, // server applies the truncation
      })
      .then((res) => {
        setMessages((m) => [...m, { role: "assistant", content: res.answer }]);
      })
      .catch((err) => {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `Error: ${err.message || "request failed"}` },
        ]);
      });
  }

  return (
    <div className={`chat-pane ${open ? "open" : "collapsed"}`}>
      <div className="chat-pane__bar" onClick={() => setOpen((o) => !o)}>
        <span>Ask about your session</span>
        <ArrowUp size={14} style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </div>

      {open && (
        <div className="chat-pane__body">
          <div className="chat-pane__messages">
            {messages.length === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                Ask anything about tonight's plan — alternative targets, observing tips, why one
                object scored higher than another.
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chat-msg chat-msg--${m.role}`}
              >
                {m.content}
              </div>
            ))}
            {explainer.isPending && (
              <div className="chat-msg chat-msg--assistant muted">…</div>
            )}
          </div>

          <div className="chat-pane__input-row">
            <input
              type="text"
              placeholder="What should I look at first?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button onClick={send} disabled={!draft.trim() || explainer.isPending} aria-label="Send">
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
