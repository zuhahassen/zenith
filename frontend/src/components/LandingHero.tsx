import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";

interface Props {
  onEnter: () => void;
}

const ALADIN_JS = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
const ALADIN_CSS = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";

// Galactic centre (RA, Dec, degrees) — used when geolocation is unavailable.
const MILKY_WAY_CORE: [number, number] = [266.4, -29.0];

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

/** RA/Dec (degrees) pointing at the observer's local zenith, from sidereal time. */
function zenithRaDec(lat: number, lon: number): [number, number] {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const J2000 = Date.now() / 86400000 - 10957.5;
  const GST = (6.697375 + 0.0657098242 * J2000 + utcH * 1.00273791) % 24;
  const LST = (((GST + lon / 15) % 24) + 24) % 24; // local sidereal time, hours
  return [LST * 15, lat];
}

/**
 * Landing shown on every load: a live Aladin Lite photographic sky pointed at
 * the observer's zenith (via geolocation + sidereal time), drifting slowly for
 * an ambient feel, behind a large serif wordmark. Dismissed by swiping up,
 * scrolling, a tap, or a key press, which slides the panel away to reveal the
 * planner.
 */
export function LandingHero({ onEnter }: Props) {
  const [exiting, setExiting] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const dismissed = useRef(false);
  // Fade the live sky in once Aladin has initialised (avoids a flash of empty).
  const [aladinReady, setAladinReady] = useState(false);
  const [locationLabel, setLocationLabel] = useState("Locating sky…");

  // Live Aladin Lite sky background. Loads the script + CSS, inits a chrome-less
  // photographic survey, points at the user's zenith, and drifts gently.
  useEffect(() => {
    let cancelled = false;
    let aladin: any;
    let drift = 0;
    let timer = 0;

    const startDrift = (ra: number, dec: number, step: number) => {
      timer = window.setInterval(() => {
        if (!aladin) return;
        drift += step;
        try {
          aladin.gotoRaDec(ra + drift, dec);
        } catch {
          /* ignore */
        }
      }, 100);
    };

    loadAladin()
      .then((A) => {
        if (cancelled || !A) return;
        A.init.then(() => {
          if (cancelled) return;
          aladin = A.aladin("#aladin-bg", {
            survey: "P/DSS2/color",
            target: "M 13",
            fov: 120,
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

          const useFallback = () => {
            if (cancelled) return;
            try {
              aladin.gotoRaDec(...MILKY_WAY_CORE);
            } catch {
              /* ignore */
            }
            startDrift(MILKY_WAY_CORE[0], MILKY_WAY_CORE[1], 0.003);
            setLocationLabel("Live sky · Milky Way core");
          };

          if (!navigator.geolocation) {
            useFallback();
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (cancelled) return;
              const { latitude: lat, longitude: lon } = pos.coords;
              const [ra, dec] = zenithRaDec(lat, lon);
              try {
                aladin.gotoRaDec(ra, dec);
                aladin.setFov(110);
              } catch {
                /* ignore */
              }
              startDrift(ra, dec, 0.004);
              fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`)
                .then((r) => r.json())
                .then((d) => {
                  if (cancelled) return;
                  const a = d.address ?? {};
                  const city = a.city || a.town || a.village || a.county || "your location";
                  const time = new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  setLocationLabel(`Live sky · ${city} · ${time}`);
                })
                .catch(() => setLocationLabel("Live sky · your location"));
            },
            useFallback,
            { timeout: 8000 },
          );
        });
      })
      .catch(() => setLocationLabel("Night sky"));

    return () => {
      cancelled = true;
      window.clearInterval(timer);
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

      <div className="landing__tint" aria-hidden />
      <div className="landing__fade" aria-hidden />

      <div className="landing__content">
        <div className="landing__eyebrow">
          <span className={`landing__dot ${aladinReady ? "is-live" : ""}`} aria-hidden />
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
