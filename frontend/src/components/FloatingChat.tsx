import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { useExplainer } from "../hooks/useExplainer";
import type { ChatMessage } from "../types/zenith";

const EMPTY_HINT =
  "Ask me anything — what's Bortle 4? Which targets are best tonight? How do I find M 13?";

interface Props {
  // The current session's plan context, when a plan exists. Passed through to
  // /api/explain so the assistant can answer about tonight's targets; falls
  // back to an empty object for general astronomy questions.
  planContext?: Record<string, unknown>;
}

// Global "Ask about the sky" assistant. Reuses the backend /api/explain proxy
// (via useExplainer) so the Anthropic key stays server-side. When a plan has
// been generated it forwards that plan context so answers are grounded in
// tonight's session; otherwise it answers general astronomy questions.
export function FloatingChat({ planContext }: Props) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const explainer = useExplainer();
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, explainer.isPending]);

  function toggle() {
    setHasOpened(true);
    setOpen((o) => !o);
  }

  function send() {
    const question = draft.trim();
    if (!question || explainer.isPending) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setDraft("");
    explainer
      .mutateAsync({ question, plan_context: planContext ?? {}, history })
      .then((res) => setMessages((m) => [...m, { role: "assistant", content: res.answer }]))
      .catch((err) =>
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `Error: ${err.message || "request failed"}` },
        ]),
      );
  }

  return (
    <>
      {open && (
        <div className="fchat" role="dialog" aria-label="Ask about the sky">
          <div className="fchat__head">
            <span className="fchat__title">Ask about the sky</span>
            <button className="fchat__close" aria-label="Close chat" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="fchat__log" ref={logRef}>
            {messages.length === 0 && <div className="fchat__hint">{EMPTY_HINT}</div>}
            {messages.map((m, i) => (
              <div key={i} className={`fchat__msg fchat__msg--${m.role}`}>
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
          <div className="fchat__input">
            <input
              type="text"
              placeholder="Type a question…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              className="fchat__send"
              aria-label="Send"
              onClick={send}
              disabled={!draft.trim() || explainer.isPending}
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      )}
      <button
        className={`fab ${!hasOpened ? "fab--pulse" : ""}`}
        aria-label={open ? "Close chat" : "Open chat"}
        onClick={toggle}
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </>
  );
}
