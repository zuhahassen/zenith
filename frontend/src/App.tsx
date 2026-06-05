import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import axios from "axios";

import { AuthPanel } from "./components/AuthPanel";
import type { CalendarDeepLink } from "./components/CalendarView";
import { FloatingChat } from "./components/FloatingChat";
import { LandingHero } from "./components/LandingHero";
import { SetupForm } from "./components/SetupForm";
import { Sidebar, type View } from "./components/Sidebar";
import { TonightView } from "./components/TonightView";
import { TargetDetail } from "./components/TargetDetail";
import { usePlan } from "./hooks/usePlan";
import { setTimeZoneMode } from "./lib/format";
import { getGuestId, getUserEmail, isSignedIn, setJWT } from "./lib/auth";
import { getUserId, submitFeedback } from "./lib/feedback";
import { loadSettings, resetSettings, saveSettings, type ZenithSettings } from "./lib/settings";
import type { HistorySession, PlanRequest, PlanResponse, ScoredTarget } from "./types/zenith";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const CompareView = lazy(() =>
  import("./components/CompareView").then((m) => ({ default: m.CompareView })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const HistoryView = lazy(() =>
  import("./components/HistoryView").then((m) => ({ default: m.HistoryView })),
);
const HistorySessionDetail = lazy(() =>
  import("./components/HistorySessionDetail").then((m) => ({ default: m.HistorySessionDetail })),
);
const CalendarView = lazy(() =>
  import("./components/CalendarView").then((m) => ({ default: m.CalendarView })),
);
const QAPanel = lazy(() => import("./components/QAPanel").then((m) => ({ default: m.QAPanel })));

// Human labels for the current view, shown in the mission-control top bar.
const VIEW_LABELS: Record<View, string> = {
  tonight: "Tonight",
  compare: "Compare Sites",
  calendar: "Calendar",
  history: "History",
  settings: "Settings",
};

export default function App() {
  const plan = usePlan();
  const [settings, setSettings] = useState<ZenithSettings>(() => loadSettings());
  const [view, setView] = useState<View>("tonight");
  const [selectedTarget, setSelectedTarget] = useState<ScoredTarget | null>(null);
  const [selectedSession, setSelectedSession] = useState<HistorySession | null>(null);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  // Calendar deep-link (set from a target detail) + the target to auto-select
  // once a "Plan this night" plan finishes loading.
  const [calendarLink, setCalendarLink] = useState<CalendarDeepLink | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  // Auth state — purely additive. `authTick` is bumped to force a re-read of
  // localStorage after sign-in/sign-out without threading state everywhere.
  const [authTick, setAuthTick] = useState(0);
  const signedIn = useMemo(() => isSignedIn(), [authTick]);
  const userEmail = useMemo(() => getUserEmail(), [authTick]);
  const [authStatus, setAuthStatus] = useState<string | null>(null);

  // Landing hero — shown on every page load, but never on the magic-link
  // verification landing (/auth/verify) so sign-in completes uninterrupted.
  const [showLanding, setShowLanding] = useState(
    () => window.location.pathname !== "/auth/verify",
  );

  function enterApp() {
    setShowLanding(false);
  }

  const data: PlanResponse | undefined = plan.data;

  // Apply the display-timezone preference for all time formatters. Set during
  // render so children format with the current choice on the same pass; it's a
  // cheap idempotent module-level assignment.
  setTimeZoneMode(settings.timezone);

  // Handle the magic-link landing at /auth/verify?token=… exactly once on
  // mount: exchange the token for a JWT, merge guest data, then clean the URL.
  useEffect(() => {
    if (window.location.pathname !== "/auth/verify") return;
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const guestId = getGuestId(); // capture the anonymous id before switching
        const { data: verified } = await axios.get(
          `${API_BASE}/api/auth/verify`,
          { params: { token }, timeout: 12_000 },
        );
        if (cancelled || !verified?.token) {
          if (!cancelled) setAuthStatus("That sign-in link is invalid or expired.");
          window.history.replaceState({}, "", "/");
          return;
        }
        setJWT(verified.token);
        // Best-effort guest → account migration; never blocks sign-in.
        try {
          await axios.post(
            `${API_BASE}/api/auth/merge`,
            { guest_id: guestId, jwt: verified.token },
            { timeout: 10_000 },
          );
        } catch {
          /* migration is optional */
        }
        window.history.replaceState({}, "", "/");
        setAuthTick((t) => t + 1);
        setAuthStatus("Signed in successfully");
      } catch {
        if (!cancelled) setAuthStatus("That sign-in link is invalid or expired.");
        window.history.replaceState({}, "", "/");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Clear the transient top-bar status message after 3 seconds.
  useEffect(() => {
    if (!authStatus) return;
    const id = window.setTimeout(() => setAuthStatus(null), 3000);
    return () => window.clearTimeout(id);
  }, [authStatus]);

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

  // Deep-link from a target's detail panel into its season calendar:
  // today → today + 90 days, auto-submitted by CalendarView.
  function viewCalendar(targetName: string) {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + 90);
    setCalendarLink({ target: targetName, start: today, end: end.toISOString().slice(0, 10) });
    setView("calendar");
  }

  // "Plan this night" from a calendar cell: plan that date at the current site,
  // then try to auto-select the target once the plan returns.
  function planNight(targetName: string, dateISO: string) {
    if (settings.lat == null || settings.lon == null) return;
    setPendingSelect(targetName);
    submit(
      {
        lat: settings.lat,
        lon: settings.lon,
        aperture_mm: settings.aperture_mm,
        mode: settings.mode,
        bortle_class: settings.bortle_class,
        catalog_filter: settings.catalog === "all" ? null : settings.catalog,
        date: dateISO,
      },
      settings.locationLabel || `${settings.lat.toFixed(2)}, ${settings.lon.toFixed(2)}`,
    );
  }

  // After a plan-this-night submission resolves, select the matching target.
  useEffect(() => {
    if (!pendingSelect || !data) return;
    const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
    const match = data.targets.find(
      (t) => norm(t.name) === norm(pendingSelect) || norm(t.common_name ?? "") === norm(pendingSelect),
    );
    if (match) setSelectedTarget(match);
    setPendingSelect(null);
  }, [data, pendingSelect]);

  // The right panel hosts the target detail on Tonight, and the session detail
  // on History. It stays hidden on Compare/Calendar/Settings so the old
  // "Select a target…" placeholder no longer lingers on those tabs.
  const showRightPanel =
    (view === "tonight" && Boolean(data)) ||
    (view === "history" && Boolean(selectedSession));
  const locLabel = settings.locationLabel || (data ? `${data.request.lat.toFixed(2)}, ${data.request.lon.toFixed(2)}` : "");
  const viewName = VIEW_LABELS[view];
  const centerLabel = [locLabel, viewName].filter(Boolean).join(" · ");

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <span className="topbar__glyph">✦</span>
          <span className="topbar__brand">ZENITH</span>
        </div>
        <div className="topbar__center">{centerLabel}</div>
        <div className="topbar__right">
          {authStatus && <span className="topbar__authstatus">{authStatus}</span>}
          <AuthPanel
            signedIn={signedIn}
            email={userEmail}
            onChange={() => setAuthTick((t) => t + 1)}
          />
        </div>
      </header>

      <div className={`layout ${showRightPanel ? "" : "layout--setup"}`}>
        <Sidebar
          view={view}
          onNavigate={(v) => {
            setView(v);
            if (v !== "history") setSelectedSession(null);
          }}
          plan={data}
        />

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
            selectedSessionId={selectedSession?.id ?? null}
            onSelectSession={setSelectedSession}
            onSaveSettings={persistSettings}
            onResetSettings={() => persistSettings(resetSettings())}
            calendarLink={calendarLink}
            onPlanNight={planNight}
          />
        </div>

        {showRightPanel && (
          <aside className="detail">
            {view === "history" && selectedSession ? (
              <Suspense fallback={null}>
                <HistorySessionDetail
                  session={selectedSession}
                  onPlanAgain={planAgain}
                  onClose={() => setSelectedSession(null)}
                />
              </Suspense>
            ) : selectedTarget && data ? (
              <>
                <TargetDetail
                  target={selectedTarget}
                  aiPlan={data.ai_plan}
                  predictedSeeing={seeingForTarget(data, selectedTarget)}
                  mode={data.request.mode}
                  rating={ratings[selectedTarget.name] ?? 0}
                  onRate={rate}
                  onViewCalendar={viewCalendar}
                  onClose={() => setSelectedTarget(null)}
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

      <FloatingChat planContext={data ? planContextFor(data) : undefined} />

      {showLanding && <LandingHero onEnter={enterApp} />}
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
  selectedSessionId: number | null;
  onSelectSession: (session: HistorySession) => void;
  onSaveSettings: (s: ZenithSettings) => void;
  onResetSettings: () => void;
  calendarLink: CalendarDeepLink | null;
  onPlanNight: (targetName: string, dateISO: string) => void;
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
  selectedSessionId,
  onSelectSession,
  onSaveSettings,
  onResetSettings,
  calendarLink,
  onPlanNight,
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

  if (view === "calendar") {
    return (
      <>
        <div className="panel-title">Target Calendar</div>
        <Suspense fallback={<div className="center-load">Loading…</div>}>
          <CalendarView settings={settings} deepLink={calendarLink} onPlanNight={onPlanNight} />
        </Suspense>
      </>
    );
  }

  if (view === "history") {
    return (
      <>
        <div className="panel-title">History</div>
        <Suspense fallback={<div className="center-load">Loading…</div>}>
          <HistoryView selectedId={selectedSessionId} onSelect={onSelectSession} />
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
