import { useMemo, useState } from "react";
import { hhmm, typeInfo } from "../lib/format";
import type { ScoredTarget } from "../types/zenith";

const PAGE = 50;
const TYPE_FILTERS = ["Gx", "EN", "PN", "GlCl", "OpCl"];

type SortKey = "name" | "type" | "magnitude" | "max_alt_deg" | "score" | "window";
type Dir = "asc" | "desc";

interface Props {
  targets: ScoredTarget[];
  selectedName: string | null;
  onSelect: (t: ScoredTarget) => void;
  aiOrderedNames: string[];
}

export function TargetTable({ targets, selectedName, onSelect, aiOrderedNames }: Props) {
  const [search, setSearch] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [aiOnly, setAiOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [dir, setDir] = useState<Dir>("desc");
  const [page, setPage] = useState(0);

  const aiSet = useMemo(() => new Set(aiOrderedNames), [aiOrderedNames]);

  const filtered = useMemo(() => {
    let rows = targets;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.common_name ?? "").toLowerCase().includes(q),
      );
    }
    if (activeTypes.size > 0) {
      rows = rows.filter((t) => activeTypes.has(typeInfo(t.kind).code));
    }
    if (aiOnly) rows = rows.filter((t) => aiSet.has(t.name));
    return [...rows].sort((a, b) => cmp(a, b, sortKey) * (dir === "asc" ? 1 : -1));
  }, [targets, search, activeTypes, aiOnly, aiSet, sortKey, dir]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const clampedPage = Math.min(page, pages - 1);
  const slice = filtered.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE);

  function toggleType(code: string) {
    setPage(0);
    setActiveTypes((s) => {
      const n = new Set(s);
      n.has(code) ? n.delete(code) : n.add(code);
      return n;
    });
  }

  function sortBy(key: SortKey) {
    if (key === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDir(key === "name" || key === "type" ? "asc" : "desc");
    }
  }

  const arrow = (key: SortKey) =>
    key === sortKey ? <span className="sort">{dir === "asc" ? "▲" : "▼"}</span> : null;

  return (
    <>
      <div className="filterbar">
        <input
          type="text"
          placeholder="search object…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <div className="type-toggles">
          {TYPE_FILTERS.map((code) => (
            <button
              key={code}
              className={`type-toggle ${activeTypes.has(code) ? "on" : ""}`}
              onClick={() => toggleType(code)}
            >
              {code}
            </button>
          ))}
        </div>
        {aiOrderedNames.length > 0 && (
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={aiOnly}
              onChange={(e) => {
                setAiOnly(e.target.checked);
                setPage(0);
              }}
            />
            AI plan only
          </label>
        )}
      </div>

      <div className="dtable-scroll">
        <table className="dtable">
          <thead>
            <tr>
              <th className="caret-cell" />
              <th onClick={() => sortBy("name")}>Object {arrow("name")}</th>
              <th onClick={() => sortBy("type")}>Type {arrow("type")}</th>
              <th className="num" onClick={() => sortBy("magnitude")}>
                Mag {arrow("magnitude")}
              </th>
              <th className="num" onClick={() => sortBy("max_alt_deg")}>
                Alt {arrow("max_alt_deg")}
              </th>
              <th className="num" onClick={() => sortBy("score")}>
                Score {arrow("score")}
              </th>
              <th onClick={() => sortBy("window")}>Window {arrow("window")}</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((t) => {
              const info = typeInfo(t.kind);
              const sel = t.name === selectedName;
              return (
                <tr
                  key={t.name}
                  className={sel ? "selected" : ""}
                  onClick={() => onSelect(t)}
                >
                  <td className="caret-cell">{sel ? "▶" : ""}</td>
                  <td>
                    <span className="obj-name">{t.name}</span>
                    {t.common_name && (
                      <span className="obj-common"> {t.common_name}</span>
                    )}
                  </td>
                  <td className="type-cell" style={{ color: info.color }}>
                    {info.code}
                  </td>
                  <td className="num">{t.magnitude != null ? t.magnitude.toFixed(1) : "—"}</td>
                  <td className="num">{t.max_alt_deg.toFixed(0)}°</td>
                  <td className="num">{t.score.toFixed(2)}</td>
                  <td className="win-cell">
                    {t.window_start ? `${hhmm(t.window_start)}–${hhmm(t.window_end)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="pager__btn" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
            ← prev
          </button>
          <span className="pager__range mono">
            {clampedPage * PAGE + 1}–{Math.min(clampedPage * PAGE + PAGE, filtered.length)} of {filtered.length}
          </span>
          <button className="pager__btn" disabled={clampedPage >= pages - 1} onClick={() => setPage(clampedPage + 1)}>
            next →
          </button>
        </div>
      )}
    </>
  );
}

function cmp(a: ScoredTarget, b: ScoredTarget, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    case "type":
      return typeInfo(a.kind).code.localeCompare(typeInfo(b.kind).code);
    case "magnitude":
      return (a.magnitude ?? 99) - (b.magnitude ?? 99);
    case "max_alt_deg":
      return a.max_alt_deg - b.max_alt_deg;
    case "score":
      return a.score - b.score;
    case "window":
      return (
        new Date(a.window_start ?? 0).getTime() - new Date(b.window_start ?? 0).getTime()
      );
  }
}
