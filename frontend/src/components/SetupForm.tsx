import { useEffect, useRef, useState } from "react";
import { MapPin, Crosshair } from "lucide-react";
import { estimateBortle } from "../lib/lightPollution";
import type { ZenithSettings } from "../lib/settings";
import type { CatalogFilter, Mode, PlanRequest } from "../types/zenith";

const APERTURES = [70, 100, 150, 200, 300];
const PIPELINE_STAGES = [
  "Resolving location…",
  "Computing darkness window…",
  "Querying SIMBAD catalog…",
  "Scoring target visibility…",
  "Predicting seeing…",
  "Asking Claude to plan…",
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
  const [customAp, setCustomAp] = useState("");
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
    const ap = customAp ? Number(customAp) : aperture;
    const req: PlanRequest = {
      lat: coords.lat,
      lon: coords.lon,
      aperture_mm: ap,
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
    <div className="setup-wrap">
      <div className="fieldset">
        <div className="fieldset__legend">Tonight's Session</div>
        <div className="form-grid">
          <div className="form-row">
            <span className="form-row__label">Location</span>
            <div className="form-row__control">
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

          <div className="form-row">
            <span className="form-row__label">Date</span>
            <div className="form-row__control">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <button onClick={() => setDate(todayISO())}>Tonight</button>
            </div>
          </div>

          <div className="form-row">
            <span className="form-row__label">Aperture</span>
            <div className="form-row__control">
              <div className="segmented">
                {APERTURES.map((a) => (
                  <button
                    key={a}
                    className={!customAp && aperture === a ? "active" : ""}
                    onClick={() => {
                      setAperture(a);
                      setCustomAp("");
                    }}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <input
                type="number"
                placeholder="custom mm"
                value={customAp}
                style={{ width: 90 }}
                onChange={(e) => setCustomAp(e.target.value)}
              />
            </div>
          </div>

          <div className="form-row">
            <span className="form-row__label">Mode</span>
            <div className="form-row__control">
              <div className="segmented">
                <button
                  className={mode === "observer" ? "active" : ""}
                  onClick={() => setMode("observer")}
                >
                  Visual Observer
                </button>
                <button
                  className={mode === "astrophotographer" ? "active" : ""}
                  onClick={() => setMode("astrophotographer")}
                >
                  Astrophotographer
                </button>
              </div>
            </div>
          </div>

          <div className="form-row">
            <span className="form-row__label">Sky</span>
            <div className="form-row__control">
              <select
                value={bortle ?? "auto"}
                onChange={(e) =>
                  setBortle(e.target.value === "auto" ? null : Number(e.target.value))
                }
              >
                <option value="auto">
                  Auto{estBortle ? ` (est. Bortle ${estBortle})` : ""}
                </option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((b) => (
                  <option key={b} value={b}>
                    Bortle {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <span className="form-row__label">Catalog</span>
            <div className="form-row__control">
              <select value={catalog} onChange={(e) => setCatalog(e.target.value as Props["settings"]["catalog"])}>
                <option value="all">All targets</option>
                <option value="messier">Messier</option>
                <option value="caldwell">Caldwell</option>
                <option value="herschel400">Herschel 400</option>
              </select>
            </div>
          </div>

          <div className={`astro-collapse ${mode === "astrophotographer" ? "open" : ""}`}>
            <div className="form-row" style={{ paddingTop: 4 }}>
              <span className="form-row__label">Focal</span>
              <div className="form-row__control">
                <input
                  type="number"
                  value={focal}
                  style={{ width: 90 }}
                  onChange={(e) => setFocal(Number(e.target.value))}
                />
                <span className="field-hint">mm</span>
                <input
                  type="number"
                  value={sensorW}
                  step="0.1"
                  style={{ width: 70 }}
                  onChange={(e) => setSensorW(Number(e.target.value))}
                />
                <span className="field-hint">×</span>
                <input
                  type="number"
                  value={sensorH}
                  step="0.1"
                  style={{ width: 70 }}
                  onChange={(e) => setSensorH(Number(e.target.value))}
                />
                <span className="field-hint">
                  mm · FoV <span className="data">{fovDeg}°</span>
                </span>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="progress-row">
              <div className="progress-bar">
                <div className="progress-bar__sweep" />
              </div>
              <span className="progress-status">
                {PIPELINE_STAGES[Math.min(elapsed, PIPELINE_STAGES.length - 1)]}
              </span>
              <span className="progress-elapsed">{elapsed}s</span>
            </div>
          ) : (
            <div className="setup-actions">
              <button className="primary" disabled={!coords} onClick={submit}>
                Plan Tonight's Session →
              </button>
            </div>
          )}
        </div>
      </div>
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
