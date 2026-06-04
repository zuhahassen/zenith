import { Suspense, lazy, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";

import { SetupForm } from "./components/SetupForm";
import { Sidebar, type View } from "./components/Sidebar";
import { TonightView } from "./components/TonightView";
import { TargetDetail } from "./components/TargetDetail";
import { usePlan } from "./hooks/usePlan";
import { getUserId, submitFeedback } from "./lib/feedback";
import { loadSettings, resetSettings, saveSettings, type ZenithSettings } from "./lib/settings";
import type { HistorySession, PlanRequest, PlanResponse, ScoredTarget } from "./types/zenith";

const CompareView = lazy(() =>
  import("./components/CompareView").then((m) => ({ default: m.CompareView })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const HistoryView = lazy(() =>
  import("./components/HistoryView").then((m) => ({ default: m.HistoryView })),
);
const QAPanel = lazy(() => import("./components/QAPanel").then((m) => ({ default: m.QAPanel })));

export default function App() {
  const plan = usePlan();
  const [settings, setSettings] = useState<ZenithSettings>(() => loadSettings());
  const [view, setView] = useState<View>("tonight");
  const [selectedTarget, setSelectedTarget] = useState<ScoredTarget | null>(null);
  const [ratings, setRatings] = useState<Record<string, number>>({});

  const data: PlanResponse | undefined = plan.data;

  function submit(req: PlanRequest, label: string) {
    setSelectedTarget(null);
    const next: ZenithSettings = {
      ...settings,
      locationLabel: label,
      lat: req.lat,
      lon: req.lon,
      aperture_mm: req.aperture_mm,
      mode: req.mode,
      bortle_class: req.bortle_class ?? null,
      catalog: req.catalog_filter ?? "all",
    };
    setSettings(next);
    saveSettings(next);
    setView("tonight");
    plan.mutate({ ...req, user_id: getUserId(), location_name: label });
  }

  // Re-run a past session: pre-fill the form defaults from the stored summary
  // and immediately generate a fresh plan for the same site + rig.
  function planAgain(session: HistorySession) {
    if (session.lat == null || session.lon == null) return;
    const label = session.location_name || `${session.lat.toFixed(2)}, ${session.lon.toFixed(2)}`;
    submit(
      {
        lat: session.lat,
        lon: session.lon,
        aperture_mm: session.aperture_mm ?? settings.aperture_mm,
        mode: session.mode,
        bortle_class: session.bortle ?? null,
      },
      label,
    );
  }

  function rate(name: string, rating: number) {
    setRatings((r) => ({ ...r, [name]: rating }));
    submitFeedback(name, rating);
  }

  function persistSettings(s: ZenithSettings) {
    setSettings(s);
    saveSettings(s);
  }

  const showRightPanel = Boolean(data);
  const locLabel = settings.locationLabel || (data ? `${data.request.lat.toFixed(2)}, ${data.request.lon.toFixed(2)}` : "");

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">Zenith</span>
        <span className="topbar__sep">·</span>
        <span className="topbar__sub">Observation Planner</span>
        <span className="topbar__spacer" />
        {locLabel && <span className="topbar__loc">{locLabel}</span>}
        <button className="topbar__gear" aria-label="Settings" onClick={() => setView("settings")}>
          <SettingsIcon size={15} />
        </button>
      </header>

      <div className={`layout ${showRightPanel ? "" : "layout--setup"}`}>
        <Sidebar view={view} onNavigate={setView} plan={data} />

        <div className="main">
          <MainContent
            view={view}
            data={data}
            loading={plan.isPending}
            error={plan.isError ? (plan.error as Error)?.message : null}
            settings={settings}
            selectedName={selectedTarget?.name ?? null}
            onSelect={setSelectedTarget}
            onSubmit={submit}
            onPlanAgain={planAgain}
            onSaveSettings={persistSettings}
            onResetSettings={() => persistSettings(resetSettings())}
          />
        </div>

        {showRightPanel && (
          <aside className="detail">
            {selectedTarget && data ? (
              <>
                <TargetDetail
                  target={selectedTarget}
                  aiPlan={data.ai_plan}
                  predictedSeeing={seeingForTarget(data, selectedTarget)}
                  mode={data.request.mode}
                  rating={ratings[selectedTarget.name] ?? 0}
                  onRate={rate}
                />
                <Suspense fallback={null}>
                  <QAPanel planContext={planContextFor(data)} />
                </Suspense>
              </>
            ) : (
              <div className="detail__empty">Select a target to view details</div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface MainContentProps {
  view: View;
  data?: PlanResponse;
  loading: boolean;
  error: string | null;
  settings: ZenithSettings;
  selectedName: string | null;
  onSelect: (t: ScoredTarget) => void;
  onSubmit: (req: PlanRequest, label: string) => void;
  onPlanAgain: (session: HistorySession) => void;
  onSaveSettings: (s: ZenithSettings) => void;
  onResetSettings: () => void;
}

function MainContent({
  view,
  data,
  loading,
  error,
  settings,
  selectedName,
  onSelect,
  onSubmit,
  onPlanAgain,
  onSaveSettings,
  onResetSettings,
}: MainContentProps) {
  if (view === "compare") {
    return (
      <>
        <div className="panel-title">Site Comparison</div>
        <Suspense fallback={<div className="center-load">Loading…</div>}>
          <CompareView settings={settings} />
        </Suspense>
      </>
    );
  }

  if (view === "history") {
    return (
      <>
        <div className="panel-title">History</div>
        <Suspense fallback={<div className="center-load">Loading…</div>}>
          <HistoryView onPlanAgain={onPlanAgain} />
        </Suspense>
      </>
    );
  }

  if (view === "settings") {
    return (
      <>
        <div className="panel-title">Settings</div>
        <Suspense fallback={<div className="center-load">Loading…</div>}>
          <SettingsView settings={settings} onSave={onSaveSettings} onReset={onResetSettings} />
        </Suspense>
      </>
    );
  }

  // Tonight view
  if (!data) {
    return (
      <>
        <div className="panel-title">Tonight</div>
        {error && <div className="err" style={{ padding: "0 20px" }}>{error}</div>}
        <SetupForm settings={settings} loading={loading} onSubmit={onSubmit} />
      </>
    );
  }

  return <TonightView data={data} selectedName={selectedName} onSelect={onSelect} />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seeingForTarget(
  data: PlanResponse | undefined,
  target: ScoredTarget | null,
): number | undefined {
  if (!data || !target || !target.window_start) return undefined;
  const targetTs = new Date(target.window_start).getTime();
  let best: { dt: number; value: number } | null = null;
  for (const slot of data.seeing_forecast) {
    const dt = Math.abs(new Date(slot.slot).getTime() - targetTs);
    if (best === null || dt < best.dt) best = { dt, value: slot.predicted_seeing_arcsec };
  }
  return best?.value;
}

function planContextFor(data: PlanResponse): Record<string, unknown> {
  return {
    location: { lat: data.request.lat, lon: data.request.lon },
    mode: data.request.mode,
    ordered_targets: data.ai_plan?.ordered_targets ?? [],
    session_summary: data.ai_plan?.session_summary,
    top_targets: data.targets.slice(0, 12).map((t) => ({
      name: t.name,
      kind: t.kind,
      score: t.score,
      max_alt_deg: t.max_alt_deg,
      window_start: t.window_start,
      window_end: t.window_end,
      why: t.why,
    })),
    seeing_forecast: data.seeing_forecast,
  };
}
