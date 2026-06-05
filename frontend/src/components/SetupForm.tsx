import { useEffect, useRef, useState } from "react";
import { MapPin, Crosshair } from "lucide-react";
import { estimateBortle } from "../lib/lightPollution";
import type { ZenithSettings } from "../lib/settings";
import type { CatalogFilter, Mode, PlanRequest } from "../types/zenith";

const APERTURES = [70, 100, 127, 150, 200, 300];
const SKY_LEVELS: { label: string; bortle: number }[] = [
  { label: "City", bortle: 8 },
  { label: "Suburban", bortle: 6 },
  { label: "Rural", bortle: 4 },
  { label: "Dark", bortle: 2 },
];
const PIPELINE_STAGES = [
  "Resolving location…",
  "Computing darkness window…",
  "Querying SIMBAD catalog…",
  "Scoring target visibility…",
  "Predicting seeing…",
  "Finalizing your plan…",
];

interface GeoResult {
  label: string;
  lat: number;
  lon: number;
}

interface Props {
  settings: ZenithSettings;
  loading: boolean;
  onSubmit: (req: PlanRequest, label: string) => void;
}

export function SetupForm({ settings, loading, onSubmit }: Props) {
  const [label, setLabel] = useState(settings.locationLabel);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    settings.lat != null && settings.lon != null
      ? { lat: settings.lat, lon: settings.lon }
      : null,
  );
  const [date, setDate] = useState<string>(todayISO());
  const [aperture, setAperture] = useState(settings.aperture_mm);
  const [mode, setMode] = useState<Mode>(settings.mode);
  const [bortle, setBortle] = useState<number | null>(settings.bortle_class);
  const [catalog, setCatalog] = useState<"all" | CatalogFilter>(settings.catalog);
  const [focal, setFocal] = useState(settings.focal_length_mm);
  const [sensorW, setSensorW] = useState(settings.sensor_width_mm);
  const [sensorH, setSensorH] = useState(settings.sensor_height_mm);

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [loading]);

  const estBortle = coords ? estimateBortle(coords.lat, coords.lon) : null;
  const fovDeg = focal > 0 ? ((sensorW / focal) * (180 / Math.PI)).toFixed(1) : "—";

  function submit() {
    if (!coords) return;
    const req: PlanRequest = {
      lat: coords.lat,
      lon: coords.lon,
      aperture_mm: aperture,
      date,
      mode,
      bortle_class: bortle,
      catalog_filter: catalog === "all" ? null : catalog,
      ...(mode === "astrophotographer"
        ? {
            focal_length_mm: focal,
            sensor_width_mm: sensorW,
            sensor_height_mm: sensorH,
          }
        : {}),
    };
    onSubmit(req, label || `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`);
  }

  return (
    <div className="obslog-wrap">
      <form
        className="obslog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="obslog__header">
          <h1 className="obslog__title">New Observation Session</h1>
          <div className="obslog__meta mono">
            {date}
            {label ? `  ·  ${label}` : ""}
          </div>
        </header>

        <div className="field">
          <label className="label">Location</label>
          <div className="field__row">
            <GeoInput
              label={label}
              onLabel={setLabel}
              onPick={(r) => {
                setLabel(r.label);
                setCoords({ lat: r.lat, lon: r.lon });
              }}
            />
            <UseGpsButton
              onFix={(lat, lon) => {
                setCoords({ lat, lon });
                setLabel(`${lat.toFixed(3)}, ${lon.toFixed(3)}`);
              }}
            />
          </div>
        </div>

        <div className="field">
          <label className="label">Date</label>
          <div className="field__row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button type="button" onClick={() => setDate(todayISO())}>
              Tonight
            </button>
          </div>
        </div>

        <div className="field">
          <label className="label">Aperture · mm</label>
          <div className="ap-grid">
            {APERTURES.map((a) => (
              <button
                type="button"
                key={a}
                className={`ap-box ${aperture === a ? "on" : ""}`}
                onClick={() => setAperture(a)}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="label">Mode</label>
          <div className="mode-toggle">
            <button
              type="button"
              className={`mode-btn ${mode === "observer" ? "on" : ""}`}
              onClick={() => setMode("observer")}
            >
              Visual Observer
            </button>
            <button
              type="button"
              className={`mode-btn ${mode === "astrophotographer" ? "on" : ""}`}
              onClick={() => setMode("astrophotographer")}
            >
              Astrophotographer
            </button>
          </div>
        </div>

        <div className="field">
          <label className="label">Sky darkness</label>
          <div className="sky-row">
            {SKY_LEVELS.map((s) => (
              <button
                type="button"
                key={s.label}
                className={`sky-btn ${bortle === s.bortle ? "on" : ""}`}
                onClick={() => setBortle(s.bortle)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {estBortle && (
            <div className="field__hint mono">
              auto-estimate · Bortle {estBortle}
              {bortle !== null && (
                <>
                  {"  ·  "}
                  <button type="button" className="linkbtn" onClick={() => setBortle(null)}>
                    use auto
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="field">
          <label className="label">Catalog</label>
          <select
            className="field__select"
            value={catalog}
            onChange={(e) => setCatalog(e.target.value as Props["settings"]["catalog"])}
          >
            <option value="all">All targets</option>
            <option value="messier">Messier</option>
            <option value="caldwell">Caldwell</option>
            <option value="herschel400">Herschel 400</option>
          </select>
        </div>

        {mode === "astrophotographer" && (
          <details className="imaging">
            <summary className="imaging__summary">Imaging equipment</summary>
            <div className="imaging__body">
              <div className="imaging__row">
                <div className="field">
                  <label className="label">Focal length · mm</label>
                  <input
                    type="number"
                    value={focal}
                    onChange={(e) => setFocal(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label className="label">Sensor W × H · mm</label>
                  <div className="field__row">
                    <input
                      type="number"
                      step="0.1"
                      value={sensorW}
                      onChange={(e) => setSensorW(Number(e.target.value))}
                    />
                    <span className="imaging__x">×</span>
                    <input
                      type="number"
                      step="0.1"
                      value={sensorH}
                      onChange={(e) => setSensorH(Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>
              <div className="imaging__fov mono">field of view ≈ {fovDeg}°</div>
            </div>
          </details>
        )}

        {loading ? (
          <div className="obslog__loading">
            <button
              type="submit"
              className="primary obslog__submit"
              disabled
              aria-label="Planning your session"
            >
              Plan Tonight's Session →
            </button>
            <div className="scan-line" aria-hidden>
              <span />
            </div>
            <div className="progress-status mono">
              {PIPELINE_STAGES[Math.min(elapsed, PIPELINE_STAGES.length - 1)]} · {elapsed}s
            </div>
          </div>
        ) : (
          <button type="submit" className="primary obslog__submit" disabled={!coords}>
            Plan Tonight's Session →
          </button>
        )}
      </form>
    </div>
  );
}

// --- Geocode autocomplete (Nominatim) -------------------------------------

function GeoInput({
  label,
  onLabel,
  onPick,
}: {
  label: string;
  onLabel: (v: string) => void;
  onPick: (r: GeoResult) => void;
}) {
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  function query(q: string) {
    window.clearTimeout(timer.current);
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const json = (await res.json()) as { display_name: string; lat: string; lon: string }[];
        setResults(
          json.map((r) => ({
            label: r.display_name.split(",").slice(0, 2).join(",").trim(),
            lat: Number(r.lat),
            lon: Number(r.lon),
          })),
        );
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 350);
  }

  return (
    <div className="geo-wrap">
      <input
        type="text"
        placeholder="City or place…"
        value={label}
        onChange={(e) => {
          onLabel(e.target.value);
          query(e.target.value);
        }}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="geo-suggestions">
          {results.map((r, i) => (
            <li
              key={i}
              className="geo-suggestion"
              onMouseDown={() => {
                onPick(r);
                setOpen(false);
              }}
            >
              <MapPin size={13} className="geo-suggestion__icon" />
              <span className="geo-suggestion__name">{r.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UseGpsButton({ onFix }: { onFix: (lat: number, lon: number) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            onFix(pos.coords.latitude, pos.coords.longitude);
            setBusy(false);
          },
          () => setBusy(false),
          { timeout: 8000 },
        );
      }}
    >
      <Crosshair size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
      GPS
    </button>
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
