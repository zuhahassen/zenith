import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

interface Props {
  onEnter: () => void;
}

/**
 * Minimal editorial landing shown once per session: a quiet deep-charcoal
 * screen with a large serif wordmark and generous negative space. Dismissed by
 * swiping up, scrolling, a tap, or a key press, which slides the panel away to
 * reveal the planner.
 */
export function LandingHero({ onEnter }: Props) {
  const [exiting, setExiting] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const dismissed = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    setExiting(true);
    window.setTimeout(onEnter, 750);
  }, [onEnter]);

  // Any meaningful downward scroll, an up-swipe, a tap, or a key enters the app.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > 6) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "Enter", " ", "PageDown"].includes(e.key)) dismiss();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dismiss]);

  return (
    <div
      className={`landing ${exiting ? "landing--exit" : ""}`}
      onClick={dismiss}
      onTouchStart={(e) => (touchStartY.current = e.touches[0].clientY)}
      onTouchEnd={(e) => {
        const start = touchStartY.current;
        if (start != null && start - e.changedTouches[0].clientY > 50) dismiss();
        touchStartY.current = null;
      }}
      role="button"
      tabIndex={0}
      aria-label="Enter Zenith"
    >
      <div className="landing__content">
        <div className="landing__eyebrow">Observation Planner</div>
        <h1 className="landing__brand">Zenith</h1>
        <div className="landing__rule" aria-hidden />
        <p className="landing__tagline">
          A clear-eyed planner for the night sky — real visibility, seeing
          forecasts, and the deep-sky targets worth your time.
        </p>
      </div>

      <div className="landing__enter">
        <ChevronUp className="landing__chev" size={20} />
        <span className="landing__enter-text">Swipe up to begin</span>
      </div>
    </div>
  );
}
