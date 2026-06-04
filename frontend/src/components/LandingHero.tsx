import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

interface Props {
  onEnter: () => void;
}

const ALADIN_SRC = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";

// Iconic deep-sky waypoints [RA, Dec] in degrees, used to slowly pan the
// ambient sky background across familiar showpieces.
const SKY_TOUR: Array<[number, number]> = [
  [83.82, -5.39], // M42 Orion Nebula
  [56.75, 24.12], // M45 Pleiades
  [10.68, 41.27], // M31 Andromeda
  [250.42, 36.46], // M13 Hercules Cluster
  [270.9, -24.38], // M8 Lagoon Nebula
  [161.26, -59.68], // Eta Carinae
];

/** Inject the Aladin Lite script once and resolve when its global is ready. */
function loadAladin(): Promise<any> {
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
    s.src = ALADIN_SRC;
    s.charset = "utf-8";
    s.onload = () => resolve(w.A);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

interface Star {
  x: number;
  y: number;
  r: number;
  base: number; // base brightness 0..1
  tw: number; // twinkle speed
  ph: number; // twinkle phase
  hue: number; // subtle colour cast
}

/**
 * Minimal landing shown once per session: a realistic Stellarium-style night
 * sky rendered on a canvas (varied star magnitudes, a faint Milky Way band,
 * gentle twinkle) behind a large serif wordmark. Dismissed by swiping up,
 * scrolling, a tap, or a key press, which slides the panel away to reveal the
 * planner.
 */
export function LandingHero({ onEnter }: Props) {
  const [exiting, setExiting] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const dismissed = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // On phones or low-core devices the live Aladin survey is too heavy, so fall
  // back to the lightweight canvas starfield.
  const [lowPower] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia("(max-width: 640px)").matches ||
        (navigator.hardwareConcurrency || 8) < 4),
  );

  // Aladin Lite live sky background (capable devices). Loads the script, inits
  // a chrome-less photographic survey, then slowly pans across showpiece DSOs.
  useEffect(() => {
    if (lowPower) return;
    let cancelled = false;
    let aladin: any;
    let timer = 0;
    loadAladin()
      .then((A) => {
        if (cancelled || !A) return;
        A.init.then(() => {
          if (cancelled) return;
          aladin = A.aladin("#landing-aladin", {
            survey: "P/DSS2/color",
            target: "M 42",
            fov: 60,
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
            backgroundColor: "#04060e",
          });
          let i = 0;
          timer = window.setInterval(() => {
            i = (i + 1) % SKY_TOUR.length;
            const [ra, dec] = SKY_TOUR[i];
            try {
              aladin.animateToRaDec(ra, dec, 16);
            } catch {
              /* ignore animation hiccups */
            }
          }, 22000);
        });
      })
      .catch(() => {
        /* network/embedding failure: the gradient sky carries the scene */
      });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lowPower]);

  // Realistic starfield fallback: many faint stars, a few bright ones, plus a
  // diagonal Milky Way band. Drawn on a canvas and twinkled with rAF.
  useEffect(() => {
    if (!lowPower) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stars: Star[] = [];
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const build = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.round((w * h) / 1600);
      stars = [];
      for (let i = 0; i < count; i++) {
        const bright = Math.random();
        // Skew toward faint stars; a handful are bright with a glow.
        const mag = Math.pow(bright, 3);
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.3 + mag * 1.7,
          base: 0.25 + mag * 0.75,
          tw: 0.4 + Math.random() * 1.6,
          ph: Math.random() * Math.PI * 2,
          hue: 200 + Math.random() * 60, // bluish-white
        });
      }

      // Milky Way band: a diagonal strip of extra faint stars.
      const bandCount = Math.round((w * h) / 5000);
      const angle = -0.5;
      for (let i = 0; i < bandCount; i++) {
        const t = Math.random();
        const along = t * Math.hypot(w, h);
        const spread = (Math.random() - 0.5) * h * 0.42;
        const cx = w * 0.5 + Math.cos(angle) * (along - Math.hypot(w, h) / 2);
        const cy = h * 0.5 + Math.sin(angle) * (along - Math.hypot(w, h) / 2) + spread;
        if (cx < 0 || cx > w || cy < 0 || cy > h) continue;
        stars.push({
          x: cx,
          y: cy,
          r: 0.25 + Math.random() * 0.6,
          base: 0.12 + Math.random() * 0.3,
          tw: 0.3 + Math.random() * 1.2,
          ph: Math.random() * Math.PI * 2,
          hue: 210 + Math.random() * 50,
        });
      }
    };

    let raf = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const tw = reduce ? 1 : 0.75 + 0.25 * Math.sin(t * 0.001 * s.tw + s.ph);
        const a = Math.min(1, s.base * tw);
        if (s.r > 1.2) {
          const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
          g.addColorStop(0, `hsla(${s.hue}, 80%, 92%, ${a})`);
          g.addColorStop(1, `hsla(${s.hue}, 80%, 92%, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `hsla(${s.hue}, 70%, 95%, ${a})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    build();
    raf = requestAnimationFrame(draw);
    const onResize = () => build();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [lowPower]);

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
      {lowPower ? (
        <canvas ref={canvasRef} className="landing__sky" aria-hidden />
      ) : (
        <div id="landing-aladin" className="landing__aladin" aria-hidden />
      )}

      <div className="landing__tint" aria-hidden />
      <div className="landing__fade" aria-hidden />

      <div className="landing__content">
        <div className="landing__eyebrow">Observation Planner</div>
        <h1 className="landing__brand">Zenith</h1>
      </div>

      <div className="landing__enter">
        <ChevronUp className="landing__chev" size={20} />
        <span className="landing__enter-text">Swipe up to begin</span>
      </div>
    </div>
  );
}
