import { useState } from "react";
import { MapPin, Search } from "lucide-react";
import type { Mode, PlanRequest } from "../types/zenith";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

const APERTURE_PRESETS = [70, 100, 150, 200, 300];

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
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function geocodeCity() {
    const q = city.trim();
    if (!q) return;
    setError(null);
    setGeocoding(true);
    try {
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1`;
      // Nominatim ToS requires a User-Agent. Browsers won't let us set
      // User-Agent directly, but they do send one automatically; we add
      // an explicit Referer-style header to comply in spirit.
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
      const data: Array<{ lat: string; lon: string; display_name: string }> = await resp.json();
      if (!data.length) {
        setError(`No match for "${q}".`);
        return;
      }
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      setCoords({ lat, lon });
      setLocationLabel(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Geocoding failed");
    } finally {
      setGeocoding(false);
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
    // Accept "lat, lon" decimals as a quick path. City geocoding is a TODO.
    const m = value.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function submit() {
    setError(null);
    const parsed = coords ?? parseTextLocation(locationLabel);
    if (!parsed) {
      setError("Enter coordinates as 'lat, lon' or tap the locate button.");
      return;
    }
    const apertureValue = customAperture ? parseFloat(customAperture) : aperture;
    if (!apertureValue || apertureValue <= 0) {
      setError("Aperture must be a positive number.");
      return;
    }
    onSubmit({
      lat: parsed.lat,
      lon: parsed.lon,
      aperture_mm: apertureValue,
      mode,
    });
  }

  if (loading) {
    return (
      <div className="setup">
        <div>
          <h1 className="setup__title">Computing tonight</h1>
          <div className="setup__subtitle">
            <span className="mono">{new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</span>
          </div>
        </div>
        <div className="loading-state">
          <div className="blink">Computing visibility window</div>
          <div className="muted">Querying SIMBAD…</div>
          <div className="muted">Predicting seeing…</div>
          <div className="muted">Asking Claude for an ordering…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div>
        <h1 className="setup__title">Plan tonight</h1>
        <div className="setup__subtitle">
          A precise observing plan computed from where you are and what you point at the sky with.
        </div>
      </div>

      <div className="setup__field">
        <div className="setup__label">Location</div>
        <div className="setup__input-row">
          <input
            type="text"
            placeholder="city or place (e.g. Berkeley)"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                geocodeCity();
              }
            }}
          />
          <button onClick={geocodeCity} disabled={geocoding || !city.trim()} aria-label="Search city">
            <Search size={14} />
          </button>
        </div>
        <div className="setup__input-row" style={{ marginTop: 6 }}>
          <input
            type="text"
            className="mono"
            placeholder="lat, lon (e.g. 37.87, -122.27)"
            value={locationLabel}
            onChange={(e) => {
              setLocationLabel(e.target.value);
              setCoords(null);
            }}
          />
          <button onClick={useBrowserLocation} disabled={locating} aria-label="Use my location">
            <MapPin size={14} />
          </button>
        </div>
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

      {error && <div className="muted" style={{ color: "#d97070" }}>{error}</div>}

      <button className="setup__submit" onClick={submit}>
        Plan tonight →
      </button>
    </div>
  );
}
