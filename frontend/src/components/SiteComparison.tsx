import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MapPin, Plus, Trophy, X } from "lucide-react";
import { useCompareSites } from "../hooks/useCompareSites";
import type {
  CompareSiteInput,
  CompareSiteResult,
  Mode,
} from "../types/zenith";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const APERTURE_PRESETS = [70, 100, 150, 200, 300];
const MAX_SITES = 5;

interface GeoResult {
  lat: number;
  lon: number;
  label: string;
}

interface Props {
  onBack: () => void;
}

export function SiteComparison({ onBack }: Props) {
  const [sites, setSites] = useState<CompareSiteInput[]>([]);
  const [aperture, setAperture] = useState(150);
  const [mode, setMode] = useState<Mode>("observer");
  const [error, setError] = useState<string | null>(null);

  const compare = useCompareSites();
  const result = compare.data;

  function addSite(s: CompareSiteInput) {
    setSites((prev) => {
      if (prev.length >= MAX_SITES) return prev;
      if (prev.some((p) => p.lat === s.lat && p.lon === s.lon)) return prev;
      return [...prev, s];
    });
  }

  function removeSite(idx: number) {
    setSites((prev) => prev.filter((_, i) => i !== idx));
  }

  function run() {
    setError(null);
    if (sites.length < 2) {
      setError("Add at least two sites to compare.");
      return;
    }
    compare.mutate({ sites, aperture_mm: aperture, mode });
  }

  return (
    <div className="setup" style={{ maxWidth: 720 }}>
      <div className="setup__brand">
        <div className="setup__wordmark">COMPARE SITES</div>
        <div className="setup__tagline">Rank candidate locations for tonight</div>
      </div>

      <button
        onClick={onBack}
        style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6 }}
      >
        <ArrowLeft size={14} /> Back to planner
      </button>

      {!result && (
        <>
          <SiteSearch onAdd={addSite} disabled={sites.length >= MAX_SITES} />

          {sites.length > 0 && (
            <div className="setup__field">
              <div className="setup__label">Candidate sites ({sites.length}/{MAX_SITES})</div>
              <ul className="compare-chips">
                {sites.map((s, i) => (
                  <li key={`${s.lat},${s.lon}`} className="compare-chip">
                    <MapPin size={12} />
                    <span className="compare-chip__label">{s.label}</span>
                    <span className="mono compare-chip__coords">
                      {s.lat.toFixed(2)}, {s.lon.toFixed(2)}
                    </span>
                    <button
                      className="compare-chip__remove"
                      aria-label="Remove site"
                      onClick={() => removeSite(i)}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="setup__field">
            <div className="setup__label">Aperture (mm)</div>
            <div className="aperture-row">
              {APERTURE_PRESETS.map((mm) => (
                <button
                  key={mm}
                  className={aperture === mm ? "active" : ""}
                  onClick={() => setAperture(mm)}
                >
                  <span className="mono">{mm}</span>
                </button>
              ))}
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

          {(error || compare.isError) && (
            <div className="mono" style={{ color: "var(--negative)", fontSize: 12 }}>
              {error ?? (compare.error as Error)?.message ?? "Comparison failed."}
            </div>
          )}

          <button
            className="setup__submit"
            onClick={run}
            disabled={compare.isPending || sites.length < 2}
          >
            {compare.isPending ? "Comparing sites…" : `Compare ${sites.length || ""} sites`}
          </button>
        </>
      )}

      {result && (
        <ComparisonResults
          sites={result.sites}
          bestSite={result.best_site}
          recommendation={result.recommendation}
          onReset={() => compare.reset()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site search (debounced Nominatim autocomplete)
// ---------------------------------------------------------------------------

function SiteSearch({
  onAdd,
  disabled,
}: {
  onAdd: (s: CompareSiteInput) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const justSelected = useRef(false);

  useEffect(() => {
    const q = query.trim();
    if (justSelected.current) {
      justSelected.current = false;
      return;
    }
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const id = setTimeout(async () => {
      setSearching(true);
      try {
        const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=5`;
        const resp = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
        const data: Array<{ lat: string; lon: string; display_name: string }> =
          await resp.json();
        setSuggestions(
          data.map((d) => ({
            lat: parseFloat(d.lat),
            lon: parseFloat(d.lon),
            label: d.display_name,
          })),
        );
        setOpen(true);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setOpen(false);
        }
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => {
      controller.abort();
      clearTimeout(id);
    };
  }, [query]);

  function select(s: GeoResult) {
    justSelected.current = true;
    onAdd({ label: s.label.split(",").slice(0, 2).join(",").trim(), lat: s.lat, lon: s.lon });
    setQuery("");
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div className="setup__field">
      <div className="setup__label">Add a site</div>
      <div className="geo-wrap">
        <input
          type="text"
          placeholder={disabled ? "Maximum of 5 sites reached" : "Search for a city or place…"}
          value={query}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && suggestions.length > 0 && (
          <ul className="geo-suggestions">
            {suggestions.map((s) => (
              <li
                key={`${s.lat},${s.lon}`}
                className="geo-suggestion"
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(s);
                }}
              >
                <Plus size={13} className="geo-suggestion__icon" />
                <span className="geo-suggestion__name">{s.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {searching && <div className="geo-hint">searching…</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ComparisonResults({
  sites,
  bestSite,
  recommendation,
  onReset,
}: {
  sites: CompareSiteResult[];
  bestSite: string | null;
  recommendation: string;
  onReset: () => void;
}) {
  return (
    <div className="compare-results">
      <div className="compare-reco">
        <Trophy size={15} className="compare-reco__icon" />
        <span>{recommendation}</span>
      </div>

      <div className="compare-grid">
        {sites.map((s, i) => (
          <SiteCard key={s.label} site={s} rank={i + 1} isBest={s.label === bestSite} />
        ))}
      </div>

      <button onClick={onReset} style={{ alignSelf: "flex-start" }}>
        Compare different sites
      </button>
    </div>
  );
}

function SiteCard({
  site,
  rank,
  isBest,
}: {
  site: CompareSiteResult;
  rank: number;
  isBest: boolean;
}) {
  if (site.error) {
    return (
      <div className="compare-card compare-card--error">
        <div className="compare-card__head">
          <span className="compare-card__rank mono">#{rank}</span>
          <span className="compare-card__name">{site.label}</span>
        </div>
        <div className="mono" style={{ color: "var(--negative)", fontSize: 12 }}>
          Forecast unavailable: {site.error}
        </div>
      </div>
    );
  }

  const sub = site.subscores;
  return (
    <div className={`compare-card ${isBest ? "compare-card--best" : ""}`}>
      <div className="compare-card__head">
        <span className="compare-card__rank mono">#{rank}</span>
        <span className="compare-card__name">{site.label}</span>
        {isBest && <span className="compare-card__badge">BEST</span>}
      </div>

      <div className="compare-card__score mono">
        {site.composite_score.toFixed(1)}
        <span className="compare-card__score-max">/100</span>
      </div>

      <dl className="compare-stats">
        <Stat label="Darkness" value={site.bortle_class != null ? `Bortle ${site.bortle_class}` : "—"} />
        <Stat
          label="Clouds"
          value={site.cloud_cover != null ? `${Math.round(site.cloud_cover)}%` : "—"}
        />
        <Stat
          label="Seeing"
          value={site.median_seeing_arcsec != null ? `${site.median_seeing_arcsec}″` : "—"}
        />
        <Stat label="Targets" value={String(site.visible_target_count)} />
      </dl>

      {sub && (
        <div className="compare-bars">
          <Bar label="Dark" frac={sub.darkness} />
          <Bar label="Wx" frac={sub.weather} />
          <Bar label="See" frac={sub.seeing} />
          <Bar label="Tgt" frac={sub.targets} />
        </div>
      )}

      {site.top_targets.length > 0 && (
        <div className="compare-card__targets mono">
          {site.top_targets.join(" · ")}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="compare-stat">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function Bar({ label, frac }: { label: string; frac: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  return (
    <div className="compare-bar">
      <span className="compare-bar__label">{label}</span>
      <div className="compare-bar__track">
        <div className="compare-bar__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
