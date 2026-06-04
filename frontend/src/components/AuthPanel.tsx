import { useEffect, useRef, useState } from "react";
import axios from "axios";

import { clearJWT } from "../lib/auth";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface Props {
  signedIn: boolean;
  email: string | null;
  // Called after the user signs out so the parent can refresh its auth state.
  onChange: () => void;
}

// Understated sign-in affordance for the top bar. Never blocks the app: guest
// mode is the default and this is a pure enhancement. Clicking "Sign in" opens
// an inline panel (not a modal) just below the top bar.
export function AuthPanel({ signedIn, email, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  function reset() {
    setValue("");
    setSent(false);
    setError(null);
    setSending(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const addr = value.trim();
    if (!addr || sending) return;
    setSending(true);
    setError(null);
    try {
      await axios.post(`${API_BASE}/api/auth/request`, { email: addr }, { timeout: 12_000 });
      setSent(true);
      // Auto-close the panel 5s after a successful request.
      closeTimer.current = window.setTimeout(() => {
        setOpen(false);
        reset();
      }, 5000);
    } catch (err) {
      const msg =
        axios.isAxiosError(err) && err.response?.status === 429
          ? "Too many requests — wait a few minutes and try again."
          : "Couldn't send the link. Check the address and try again.";
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  function signOut() {
    clearJWT();
    onChange();
  }

  return (
    <>
      {signedIn ? (
        <span className="auth-bar">
          <span className="auth-bar__email" title={email ?? undefined}>
            {truncate(email ?? "", 20)}
          </span>
          <button className="auth-bar__link" onClick={signOut}>
            Sign out
          </button>
        </span>
      ) : (
        <button
          className="auth-bar__link"
          onClick={() => {
            setOpen((o) => !o);
            reset();
          }}
        >
          Sign in
        </button>
      )}

      {open && !signedIn && (
        <div className="auth-panel">
          {sent ? (
            <div className="auth-panel__msg">
              Check your email — the link expires in 15 minutes.
            </div>
          ) : (
            <form className="auth-panel__form" onSubmit={submit}>
              <input
                type="email"
                className="auth-panel__input"
                placeholder="you@example.com"
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                aria-label="Email address"
              />
              <button type="submit" className="auth-panel__btn" disabled={sending}>
                {sending ? "Sending…" : "Send magic link"}
              </button>
              {error && <span className="auth-panel__err">{error}</span>}
            </form>
          )}
        </div>
      )}
    </>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
