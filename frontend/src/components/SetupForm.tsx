import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, MapPin, Search } from "lucide-react";
import type { Mode, PlanRequest } from "../types/zenith";
import { estimateBortle } from "../lib/lightPollution";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

const APERTURE_PRESETS = [70, 100, 150, 200, 300];

// Sky-darkness presets map a human label to a representative Bortle integer.
const DARKNESS_PRESETS: { label: string; bortle: number }[] = [
  { label: "City (Bortle 8-9)", bortle: 9 },
  { label: "Suburban (Bortle 6-7)", bortle: 6 },
  { label: "Rural (Bortle 4-5)", bortle: 4 },
  { label: "Dark site (Bortle 1-3)", bortle: 2 },
];

// Cycling status lines shown while the plan request is in flight.
const LOADING_STAGES = [
  "Querying SIMBAD catalog...",
  "Computing visibility windows...",
  "Running seeing forecast...",
  "Asking Claude...",
];

interface GeoResult {
  lat: number;
  lon: number;
  label: string;
}

interface Props {
  onSubmit: (req: PlanRequest) => void;
  loading?: boolean;
}

export function SetupForm({ onSubmit, loading }: Props) {
  const [city, setCity] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [aperture, setAperture] = useState<number>(150);
  const [customAperture, setCustomAperture] = useState("");
  const [mode, setMode] = useState<Mode>("observer");
  // null = auto (use the coordinate-based estimate).
  const [bortle, setBortle] = useState<number | null>(null);
  const [focalLength, setFocalLength] = useState("750");
  const [sensorWidth, setSensorWidth] = useState("23.5");
  const [sensorHeight, setSensorHeight] = useState("15.6");
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Autocomplete state.
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const justSelected = useRef(false);

  // Debounced live geocoding so the user picks from a list rather than
  // committing to a possibly-mistyped place name.
  useEffect(() => {
    const q = city.trim();
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    if (q.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const controller = new AbortController();
    const id = setTimeout(async () => {
      setSearching(true);
      try {
        const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=0`;
        const resp = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
        const data: Array<{ lat: string; lon: string; display_name: string }> = await resp.json();
        setSuggestions(
          data.map((d) => ({
            lat: parseFloat(d.lat),
            lon: parseFloat(d.lon),
            label: d.display_name,
          })),
        );
        setShowSuggestions(true);
        setActiveIndex(-1);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Geocoding failed");
        }
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => {
      controller.abort();
      clearTimeout(id);
    };
  }, [city]);

  function selectSuggestion(s: GeoResult) {
    justSelected.current = true;
    setCoords({ lat: s.lat, lon: s.lon });
    setCity(s.label.split(",").slice(0, 2).join(",").trim());
    setLocationLabel(`${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`);
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveIndex(-1);
    setError(null);
  }

  function onCityKeyDown(e: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectSuggestion(suggestions[activeIndex >= 0 ? activeIndex : 0]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  function useBrowserLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation not supported by this browser.");
      return;
    }
    setError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocationLabel(
          `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`,
        );
        setCity("Current location");
        setLocating(false);
      },
      (err) => {
        setError(err.message);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }

  function parseTextLocation(value: string): { lat: number; lon: number } | null {
    const m = value.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  // Live estimate from whatever location is currently entered.
  const parsedCoords = coords ?? parseTextLocation(locationLabel);
  const estimatedBortle = useMemo(
    () => (parsedCoords ? estimateBortle(parsedCoords.lat, parsedCoords.lon) : null),
    [parsedCoords?.lat, parsedCoords?.lon],
  );

  // Live field-of-view readout (degrees) for astrophotographer mode.
  const fov = useMemo(() => {
    const f = parseFloat(focalLength);
    const w = parseFloat(sensorWidth);
    const h = parseFloat(sensorHeight);
    if (!f || !w || !h || f <= 0) return null;
    return { w: (w / f) * 57.3, h: (h / f) * 57.3 };
  }, [focalLength, sensorWidth, sensorHeight]);

  function submit() {
    setError(null);
    const parsed = coords ?? parseTextLocation(locationLabel);
    if (!parsed) {
      setError("Search for a place and pick it from the list, or enter 'lat, lon'.");
      return;
    }
    const apertureValue = customAperture ? parseFloat(customAperture) : aperture;
    if (!apertureValue || apertureValue <= 0) {
      setError("Aperture must be a positive number.");
      return;
    }
    const req: PlanRequest = {
      lat: parsed.lat,
      lon: parsed.lon,
      aperture_mm: apertureValue,
      mode,
      bortle_class: bortle ?? undefined,
    };
    if (mode === "astrophotographer") {
      req.focal_length_mm = parseFloat(focalLength) || undefined;
      req.sensor_width_mm = parseFloat(sensorWidth) || undefined;
      req.sensor_height_mm = parseFloat(sensorHeight) || undefined;
    }
    onSubmit(req);
  }

  if (loading) {
    return (
      <div className="setup">
        <div className="setup__brand">
          <div className="setup__wordmark">ZENITH</div>
          <div className="setup__tagline">Observation Planner</div>
        </div>
        <LoadingSweep />
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="setup__brand">
        <div className="setup__wordmark">ZENITH</div>
        <div className="setup__tagline">Observation Planner</div>
      </div>

      <div className="setup__field">
        <div className="setup__label">Location</div>
        <div className="setup__input-row">
          <div className="geo-wrap">
            <input
              type="text"
              placeholder="Search for a city or place…"
              value={city}
              autoComplete="off"
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={onCityKeyDown}
              onFocus={() => suggestions.length && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            />
            {showSuggestions && suggestions.length > 0 && (
              <ul className="geo-suggestions">
                {suggestions.map((s, i) => (
                  <li
                    key={`${s.lat},${s.lon}`}
                    className={`geo-suggestion ${i === activeIndex ? "active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(s);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <MapPin size={13} className="geo-suggestion__icon" />
                    <span className="geo-suggestion__name">{s.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={useBrowserLocation}
            disabled={locating}
            aria-label="Use my location"
          >
            <MapPin size={14} />
          </button>
        </div>
        <div className="setup__input-row" style={{ marginTop: 6 }}>
          <input
            type="text"
            className="mono"
            placeholder="…or enter lat, lon (e.g. 37.87, -122.27)"
            value={locationLabel}
            onChange={(e) => {
              setLocationLabel(e.target.value);
              setCoords(null);
            }}
          />
        </div>
        {searching && <div className="geo-hint">searching…</div>}
        {coords && (
          <div className="geo-hint">
            <Search size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
            locked to {coords.lat.toFixed(4)}, {coords.lon.toFixed(4)}
          </div>
        )}
      </div>

      <div className="setup__field">
        <div className="setup__label">Aperture (mm)</div>
        <div className="aperture-row">
          {APERTURE_PRESETS.map((mm) => (
            <button
              key={mm}
              className={!customAperture && aperture === mm ? "active" : ""}
              onClick={() => {
                setAperture(mm);
                setCustomAperture("");
              }}
            >
              <span className="mono">{mm}</span>
            </button>
          ))}
          <input
            className="mono"
            style={{ width: 80 }}
            placeholder="custom"
            value={customAperture}
            onChange={(e) => setCustomAperture(e.target.value)}
          />
        </div>
      </div>

      <div className="setup__field">
        <div className="setup__label">Mode</div>
        <div className="mode-pill">
          <button
            className={mode === "observer" ? "active" : ""}
            onClick={() => setMode("observer")}
          >
            Observer
          </button>
          <button
            className={mode === "astrophotographer" ? "active" : ""}
            onClick={() => setMode("astrophotographer")}
          >
            Astrophotographer
          </button>
        </div>
      </div>

      <div className="setup__field">
        <div className="setup__label">Sky darkness</div>
        <div className="mode-pill" style={{ flexWrap: "wrap" }}>
          <button
            className={bortle === null ? "active" : ""}
            onClick={() => setBortle(null)}
          >
            Auto
          </button>
          {DARKNESS_PRESETS.map((p) => (
            <button
              key={p.bortle}
              className={bortle === p.bortle ? "active" : ""}
              onClick={() => setBortle(p.bortle)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {estimatedBortle !== null && (
          <div className="geo-hint" style={{ marginTop: 6 }}>
            Estimated for your location: <span className="mono">Bortle {estimatedBortle}</span>
            {bortle !== null ? " (overridden above)" : ""}
          </div>
        )}
      </div>

      {mode === "astrophotographer" && (
        <div className="setup__field">
          <div className="setup__label">Imaging train</div>
          <div className="aperture-row" style={{ flexWrap: "wrap", gap: 8 }}>
            <label className="muted" style={{ fontSize: 11 }}>
              Focal length (mm)
              <input
                className="mono"
                style={{ width: 90, display: "block", marginTop: 2 }}
                value={focalLength}
                onChange={(e) => setFocalLength(e.target.value)}
              />
            </label>
            <label className="muted" style={{ fontSize: 11 }}>
              Sensor width (mm)
              <input
                className="mono"
                style={{ width: 90, display: "block", marginTop: 2 }}
                value={sensorWidth}
                onChange={(e) => setSensorWidth(e.target.value)}
              />
            </label>
            <label className="muted" style={{ fontSize: 11 }}>
              Sensor height (mm)
              <input
                className="mono"
                style={{ width: 90, display: "block", marginTop: 2 }}
                value={sensorHeight}
                onChange={(e) => setSensorHeight(e.target.value)}
              />
            </label>
          </div>
          {fov && (
            <div className="geo-hint" style={{ marginTop: 6 }}>
              Field of view:{" "}
              <span className="mono">
                {fov.w.toFixed(1)}° × {fov.h.toFixed(1)}°
              </span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mono" style={{ color: "var(--negative)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <button className="setup__submit" onClick={submit}>
        Plan tonight
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading sweep — a thin blue line sweeps left→right under cycling status text.
// ---------------------------------------------------------------------------

function LoadingSweep() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStage((s) => (s + 1) % LOADING_STAGES.length), 1300);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="loader">
      <div className="loader__sweep" />
      <div className="loader__status">{LOADING_STAGES[stage]}</div>
    </div>
  );
}
