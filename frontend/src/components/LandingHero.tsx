import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

interface Props {
  onEnter: () => void;
}

const ALADIN_JS = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
const ALADIN_CSS = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";

// Curated showpieces for the daytime / no-geolocation "beauty reel".
const HERO_TARGETS = [
  { name: "Milky Way core", ra: 266.4, dec: -29.0, fov: 80 },
  { name: "Orion Nebula", ra: 83.8, dec: -5.4, fov: 15 },
  { name: "Eta Carinae", ra: 161.3, dec: -59.7, fov: 12 },
  { name: "Andromeda Galaxy", ra: 10.7, dec: 41.3, fov: 8 },
  { name: "Lagoon Nebula", ra: 270.9, dec: -24.4, fov: 10 },
];

/** Ensure the Aladin Lite stylesheet is present (required for correct rendering). */
function ensureAladinCss() {
  if (document.getElementById("aladin-lite-css")) return;
  const link = document.createElement("link");
  link.id = "aladin-lite-css";
  link.rel = "stylesheet";
  link.href = ALADIN_CSS;
  document.head.appendChild(link);
}

/** Inject the Aladin Lite script + CSS once and resolve when its global is ready. */
function loadAladin(): Promise<any> {
  ensureAladinCss();
  const w = window as any;
  if (w.A) return Promise.resolve(w.A);
  return new Promise((resolve, reject) => {
    const existing = document.getElementById("aladin-lite-script") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(w.A));
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.id = "aladin-lite-script";
    s.src = ALADIN_JS;
    s.charset = "utf-8";
    s.onload = () => resolve(w.A);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/**
 * Landing shown on every load with an Aladin Lite sky that continuously
 * iterates through a curated "beauty reel" of showpiece deep-sky objects
 * (no geolocation / live local sky). Dismissed by swiping up, scrolling, a
 * tap, or a key press.
 */
export function LandingHero({ onEnter }: Props) {
  const [exiting, setExiting] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const dismissed = useRef(false);
  // Fade the sky in once Aladin has initialised (avoids a flash of empty).
  const [aladinReady, setAladinReady] = useState(false);
  // Eyebrow label tracks the currently featured showpiece.
  const [locationLabel, setLocationLabel] = useState("Tonight's sky");

  // Aladin Lite sky background. Loads script + CSS, then runs the curated
  // beauty reel, cycling through showpiece deep-sky objects.
  useEffect(() => {
    let cancelled = false;
    let aladin: any;
    let reelTimer = 0;
    let driftTimer = 0;
    let flyTimer = 0;
    let currentSurvey = "P/DSS2/color";

    const setSurvey = (s: string) => {
      if (s === currentSurvey || !aladin) return;
      try {
        aladin.setImageSurvey(s);
        currentSurvey = s;
      } catch {
        /* ignore */
      }
    };

    // Gentle parallax. Slow + infrequent so Aladin's progressive HiPS tiles have
    // time to refine to full resolution between nudges (continuous panning keeps
    // the view coarse/pixelated).
    const startDrift = (ra: number, dec: number) => {
      window.clearInterval(driftTimer);
      let d = 0;
      driftTimer = window.setInterval(() => {
        if (!aladin) return;
        d += 0.0015;
        try {
          aladin.gotoRaDec(ra + d, dec);
        } catch {
          /* ignore */
        }
      }, 250);
    };

    // Hold still after arriving so tiles sharpen, then begin the slow drift.
    const settleThenDrift = (ra: number, dec: number) => {
      window.clearTimeout(flyTimer);
      flyTimer = window.setTimeout(() => {
        if (!cancelled) startDrift(ra, dec);
      }, 3500);
    };

    const stopReel = () => {
      window.clearInterval(reelTimer);
      window.clearTimeout(flyTimer);
      window.clearInterval(driftTimer);
      reelTimer = driftTimer = flyTimer = 0;
    };

    // Cycle the curated showpieces every 14s: 2s fly-in, settle, then slow drift.
    const runReel = () => {
      let i = 0;
      const show = (idx: number) => {
        const t = HERO_TARGETS[idx];
        setSurvey(t.name === "Milky Way core" ? "P/2MASS/color" : "P/DSS2/color");
        try {
          aladin.animateToRaDec(t.ra, t.dec, 2.0);
          aladin.setFov(t.fov);
        } catch {
          /* ignore */
        }
        setLocationLabel(t.name);
        settleThenDrift(t.ra, t.dec);
      };
      show(0);
      reelTimer = window.setInterval(() => {
        i = (i + 1) % HERO_TARGETS.length;
        window.clearInterval(driftTimer);
        show(i);
      }, 14000);
    };

    loadAladin()
      .then((A) => {
        if (cancelled || !A) return;
        A.init.then(() => {
          if (cancelled) return;
          aladin = A.aladin("#aladin-bg", {
            survey: "P/DSS2/color",
            fov: 80,
            showReticle: false,
            showZoomControl: false,
            showFullscreenControl: false,
            showLayersControl: false,
            showGotoControl: false,
            showShareControl: false,
            showCatalog: false,
            showFrame: false,
            showContextMenu: false,
            cooFrame: "equatorial",
            backgroundColor: "#080c14",
            projection: "SIN",
          });
          setAladinReady(true);

          // Continuously cycle through the curated showpieces.
          runReel();
        });
      })
      .catch(() => setLocationLabel("Night sky"));

    return () => {
      cancelled = true;
      stopReel();
    };
  }, []);

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
      <div
        id="aladin-bg"
        className={`landing__aladin ${aladinReady ? "is-ready" : ""}`}
        aria-hidden
      />

      <div className="landing__tint is-day" aria-hidden />
      <div className="landing__fade" aria-hidden />

      <div className="landing__content">
        <div className="landing__eyebrow">
          <span className="landing__dot" aria-hidden />
          <span id="location-label">{locationLabel}</span>
        </div>
        <h1 className="landing__brand">Zenith</h1>
      </div>

      <div className="landing__enter">
        <ChevronUp className="landing__chev" size={20} />
        <span className="landing__enter-text">Swipe up to begin</span>
      </div>
    </div>
  );
}
