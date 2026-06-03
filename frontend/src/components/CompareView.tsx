import { useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { useCompareSites } from "../hooks/useCompareSites";
import type { ZenithSettings } from "../lib/settings";
import type { CompareSiteInput, CompareSiteResult } from "../types/zenith";

interface Props {
  settings: ZenithSettings;
}

export function CompareView({ settings }: Props) {
  const [sites, setSites] = useState<CompareSiteInput[]>(
    settings.lat != null && settings.lon != null
      ? [{ label: settings.locationLabel || "Home", lat: settings.lat, lon: settings.lon }]
      : [],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const compare = useCompareSites();

  function run() {
    if (sites.length < 2) return;
    compare.mutate({
      sites,
      aperture_mm: settings.aperture_mm,
      mode: settings.mode,
      catalog_filter: settings.catalog === "all" ? null : settings.catalog,
    });
  }

  const results = compare.data?.sites
    ? [...compare.data.sites].sort((a, b) => b.composite_score - a.composite_score)
    : [];
  const selectedResult = results.find((r) => r.label === selected);

  return (
    <div className="compare2">
      <div className="compare2__add">
        <AddSite onAdd={(s) => setSites((prev) => [...prev, s])} disabled={sites.length >= 5} />
        <button
          className="primary"
          disabled={sites.length < 2 || compare.isPending}
          onClick={run}
        >
          {compare.isPending ? "Comparing…" : "Compare"}
        </button>
      </div>

      {sites.length > 0 && (
        <div className="compare-chips2">
          {sites.map((s, i) => (
            <span className="compare-chip2" key={`${s.label}-${i}`}>
              {s.label}
              <button onClick={() => setSites((p) => p.filter((_, j) => j !== i))} aria-label="Remove">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {compare.isError && <div className="err">{compare.error.message}</div>}

      {results.length > 0 && (
        <>
          <table className="compare-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Bortle</th>
                <th>Seeing</th>
                <th>Targets</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr
                  key={r.label}
                  className={`${selected === r.label ? "selected" : ""} ${i === 0 ? "best" : ""}`}
                  onClick={() => setSelected(r.label)}
                >
                  <td>
                    {selected === r.label && <span className="chip-dot">●</span>}
                    {r.label}
                  </td>
                  <td>{r.bortle_class ?? "—"}</td>
                  <td>{r.median_seeing_arcsec != null ? `${r.median_seeing_arcsec.toFixed(1)}″` : "—"}</td>
                  <td>{r.visible_target_count}</td>
                  <td>
                    {r.composite_score.toFixed(2)}
                    {i === 0 && <span className="compare-star"> ★★</span>}
                    {i === 1 && results.length > 2 && <span className="compare-star"> ★</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {compare.data?.recommendation && (
            <div className="compare-reco2">{compare.data.recommendation}</div>
          )}

          {selectedResult && <TopTargets result={selectedResult} />}
        </>
      )}
    </div>
  );
}

function TopTargets({ result }: { result: CompareSiteResult }) {
  if (!result.top_targets.length) return null;
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>
        Top targets · {result.label}
      </div>
      <div className="compare-toptargets">{result.top_targets.join("  ·  ")}</div>
    </div>
  );
}

function AddSite({
  onAdd,
  disabled,
}: {
  onAdd: (s: CompareSiteInput) => void;
  disabled: boolean;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CompareSiteInput[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  function search(value: string) {
    window.clearTimeout(timer.current);
    if (value.trim().length < 3) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(value)}`;
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
        placeholder={disabled ? "Max 5 sites" : "Add site…"}
        value={q}
        disabled={disabled}
        onChange={(e) => {
          setQ(e.target.value);
          search(e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="geo-suggestions">
          {results.map((r, i) => (
            <li
              key={i}
              className="geo-suggestion"
              onMouseDown={() => {
                onAdd(r);
                setQ("");
                setResults([]);
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
