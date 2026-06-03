import { useState } from "react";
import { Terminal } from "lucide-react";
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
        <span className="chat-pane__bar-left">
          <Terminal size={14} />
          Session Q&amp;A
        </span>
        <span className="chat-pane__bar-right">{open ? "↓ collapse" : "↑ expand"}</span>
      </div>

      {open && (
        <div className="chat-pane__body">
          <div className="chat-pane__messages">
            {messages.length === 0 && (
              <div className="chat-msg chat-msg--assistant">
                Ask anything about tonight's plan — alternative targets, observing tips, why one
                object scored higher than another.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg--${m.role}`}>
                {m.content}
              </div>
            ))}
            {explainer.isPending && (
              <div className="chat-msg chat-msg--assistant">
                <span className="typing">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            )}
          </div>

          <div className="chat-pane__input-wrap">
            <div className="chat-pane__input-row">
              <span className="chat-pane__prompt">&gt;_</span>
              <input
                type="text"
                placeholder="ask about your session"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </div>
            <div className="chat-pane__inputhint">enter to send · shift+enter for newline</div>
          </div>
        </div>
      )}
    </div>
  );
}
