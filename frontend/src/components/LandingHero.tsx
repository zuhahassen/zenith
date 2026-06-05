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

/** RA/Dec (degrees) pointing at the observer's local zenith, from sidereal time. */
function zenithRaDec(lat: number, lon: number): [number, number] {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const J2000 = Date.now() / 86400000 - 10957.5;
  const GST = (6.697375 + 0.0657098242 * J2000 + utcH * 1.00273791) % 24;
  const LST = (((GST + lon / 15) % 24) + 24) % 24; // local sidereal time, hours
  return [LST * 15, lat];
}

/** Sun altitude (degrees) at a given instant and location (low-precision). */
function sunAltitudeAt(date: Date, lat: number, lon: number): number {
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
  const dayOfYear = Math.floor(
    (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000,
  );
  const declination = -23.45 * Math.cos(((360 / 365) * (dayOfYear + 10) * Math.PI) / 180);
  const hourAngle = (utcH - 12 + lon / 15) * 15;
  const latR = (lat * Math.PI) / 180;
  const decR = (declination * Math.PI) / 180;
  const haR = (hourAngle * Math.PI) / 180;
  return (
    (Math.asin(
      Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR),
    ) *
      180) /
    Math.PI
  );
}

/** Next local time (e.g. "9:14 PM") the sun drops below -12°, or null. */
function nightStartTime(lat: number, lon: number): string | null {
  const now = new Date();
  let prev = sunAltitudeAt(now, lat, lon);
  for (let m = 5; m <= 24 * 60; m += 5) {
    const d = new Date(now.getTime() + m * 60000);
    const alt = sunAltitudeAt(d, lat, lon);
    if (prev >= -12 && alt < -12) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    prev = alt;
  }
  return null;
}

/**
 * Landing shown on every load with a time-aware Aladin Lite sky: at
 * astronomical night it points at the observer's zenith (geolocation +
 * sidereal time) for the real local sky; by day/twilight or without
 * geolocation it runs a curated "beauty reel" of showpiece deep-sky objects.
 * Dismissed by swiping up, scrolling, a tap, or a key press.
 */
export function LandingHero({ onEnter }: Props) {
  const [exiting, setExiting] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const dismissed = useRef(false);
  // Fade the live sky in once Aladin has initialised (avoids a flash of empty).
  const [aladinReady, setAladinReady] = useState(false);
  const [locationLabel, setLocationLabel] = useState("Locating sky…");
  // night = real local sky (live); otherwise the daytime beauty reel.
  const [nightMode, setNightMode] = useState(false);

  // Aladin Lite sky background. Loads script + CSS, then either points at the
  // observer's zenith (astronomical night) or runs a curated beauty reel.
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

    // Gentle parallax: nudge RA by 0.003°/100ms around the current target.
    const startDrift = (ra: number, dec: number) => {
      window.clearInterval(driftTimer);
      let d = 0;
      driftTimer = window.setInterval(() => {
        if (!aladin) return;
        d += 0.003;
        try {
          aladin.gotoRaDec(ra + d, dec);
        } catch {
          /* ignore */
        }
      }, 100);
    };

    const stopReel = () => {
      window.clearInterval(reelTimer);
      window.clearTimeout(flyTimer);
      window.clearInterval(driftTimer);
      reelTimer = driftTimer = flyTimer = 0;
    };

    // Cycle the curated showpieces every 8s: 2s fly-in, then drift.
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
        window.clearTimeout(flyTimer);
        flyTimer = window.setTimeout(() => {
          if (!cancelled) startDrift(t.ra, t.dec);
        }, 2100);
      };
      show(0);
      reelTimer = window.setInterval(() => {
        i = (i + 1) % HERO_TARGETS.length;
        window.clearInterval(driftTimer);
        show(i);
      }, 8000);
    };

    const goNight = (lat: number, lon: number, city: string) => {
      stopReel();
      setSurvey("P/DSS2/color");
      const [ra, dec] = zenithRaDec(lat, lon);
      try {
        aladin.gotoRaDec(ra, dec);
        aladin.setFov(110);
      } catch {
        /* ignore */
      }
      startDrift(ra, dec);
      setNightMode(true);
      const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      setLocationLabel(`Live sky · ${city} · ${time}`);
    };

    const goDay = (lat: number, lon: number, city: string) => {
      setNightMode(false); // reel keeps running
      const ns = nightStartTime(lat, lon);
      setLocationLabel(
        ns ? `Tonight's sky · ${city} · night begins ~${ns}` : `Tonight's sky · ${city}`,
      );
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

          // Start the reel immediately while geolocation resolves.
          runReel();

          if (!navigator.geolocation) {
            setNightMode(false);
            setLocationLabel("Tonight's sky · Milky Way core");
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (cancelled) return;
              const { latitude: lat, longitude: lon } = pos.coords;
              fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`)
                .then((r) => r.json())
                .then((d) => d.address ?? {})
                .catch(() => ({}))
                .then((a: any) => {
                  if (cancelled) return;
                  const city = a.city || a.town || a.village || a.county || "your location";
                  if (sunAltitudeAt(new Date(), lat, lon) < -12) goNight(lat, lon, city);
                  else goDay(lat, lon, city);
                });
            },
            () => {
              if (cancelled) return;
              setNightMode(false);
              setLocationLabel("Tonight's sky · Milky Way core");
            },
            { timeout: 8000 },
          );
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

      <div className={`landing__tint ${nightMode ? "is-night" : "is-day"}`} aria-hidden />
      <div className="landing__fade" aria-hidden />

      <div className="landing__content">
        <div className="landing__eyebrow">
          <span className={`landing__dot ${nightMode ? "is-live" : ""}`} aria-hidden />
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
