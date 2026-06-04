import { useHistory } from "../hooks/useHistory";
import { getUserId } from "../lib/feedback";
import { seeingHex, typeInfo } from "../lib/format";
import type { HistorySession } from "../types/zenith";

interface Props {
  selectedId: number | null;
  onSelect: (session: HistorySession) => void;
}

export function HistoryView({ selectedId, onSelect }: Props) {
  const history = useHistory(getUserId(), 20);

  if (history.isLoading) {
    return <div className="center-load">Loading history…</div>;
  }

  const sessions = history.data?.sessions ?? [];

  if (history.isError) {
    return <div className="err" style={{ padding: "16px 20px" }}>{history.error.message}</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="center-load" style={{ lineHeight: 1.7 }}>
        No past sessions recorded.
        <br />
        Plan tonight's session to start building your history.
      </div>
    );
  }

  return (
    <div className="dtable-scroll">
      <table className="dtable">
        <thead>
          <tr>
            <th>Date</th>
            <th>Location</th>
            <th className="num">Targets</th>
            <th>Moon</th>
            <th className="num">Seeing</th>
            <th>Top target</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const info = typeInfo(s.top_target_type);
            const moonPct = s.moon_illumination != null ? Math.round(s.moon_illumination * 100) : null;
            return (
              <tr
                key={s.id}
                className={selectedId === s.id ? "selected" : ""}
                onClick={() => onSelect(s)}
              >
                <td className="mono" style={{ color: "var(--text-data)" }}>{fmtDate(s.timestamp)}</td>
                <td>{s.location_name || coords(s)}</td>
                <td className="num">{s.target_count ?? "—"}</td>
                <td>
                  {moonPct != null ? (
                    <span className="moon-cell">
                      <span className="moon-bar">
                        <span className="moon-bar__fill" style={{ width: `${moonPct}%` }} />
                      </span>
                      <span className="mono">{moonPct}%</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num" style={{ color: s.seeing_median != null ? seeingHex(s.seeing_median) : undefined }}>
                  {s.seeing_median != null ? `${s.seeing_median.toFixed(1)}″` : "—"}
                </td>
                <td>
                  {s.top_target ? (
                    <>
                      {s.top_target}
                      {s.top_target_type && (
                        <span style={{ color: info.color }}> ({info.code})</span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function coords(s: HistorySession): string {
  if (s.lat == null || s.lon == null) return "Unknown";
  return `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`;
}
