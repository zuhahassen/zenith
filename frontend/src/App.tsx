import { Suspense, lazy, useState } from "react";
import { format } from "date-fns";

import { SeeingForecast } from "./components/SeeingForecast";
import { SetupForm } from "./components/SetupForm";
import { TargetCard } from "./components/TargetCard";
import { usePlan } from "./hooks/usePlan";
import { getUserId, submitFeedback } from "./lib/feedback";
import type { PlanRequest, PlanResponse, ScoredTarget } from "./types/zenith";

// Lazy-loaded: neither is needed until a plan exists, so keep them out of the
// initial bundle. Both are named exports, so adapt them to default exports.
const SessionTimeline = lazy(() =>
  import("./components/SessionTimeline").then((m) => ({ default: m.SessionTimeline })),
);
const ChatPane = lazy(() =>
  import("./components/ChatPane").then((m) => ({ default: m.ChatPane })),
);

export default function App() {
  const plan = usePlan();
  const [selectedTarget, setSelectedTarget] = useState<ScoredTarget | null>(null);
  // Per-session target ratings keyed by target name (1 up, -1 down).
  const [ratings, setRatings] = useState<Record<string, number>>({});

  function submit(req: PlanRequest) {
    setSelectedTarget(null);
    plan.mutate({ ...req, user_id: getUserId() });
  }

  function rate(name: string, rating: number) {
    setRatings((r) => ({ ...r, [name]: rating }));
    submitFeedback(name, rating);
  }

  const data: PlanResponse | undefined = plan.data;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__title">ZENITH</div>
        <div className="app-header__meta">
          {format(new Date(), "yyyy-MM-dd HH:mm")} UTC
        </div>
      </header>

      <main className="app-main">
        {!data ? (
          <SetupForm onSubmit={submit} loading={plan.isPending} />
        ) : (
          <PlanView
            data={data}
            onReset={() => {
              setSelectedTarget(null);
              plan.reset();
            }}
            onSelect={setSelectedTarget}
            selectedName={selectedTarget?.name ?? null}
          />
        )}

        {plan.isError && (
          <div className="mono" style={{ padding: "0 32px", color: "var(--negative)" }}>
            {(plan.error as Error)?.message ?? "Plan request failed."}
          </div>
        )}

        <TargetCard
          target={selectedTarget}
          aiPlan={data?.ai_plan}
          predictedSeeing={seeingForTarget(data, selectedTarget)}
          mode={data?.request.mode}
          rating={selectedTarget ? ratings[selectedTarget.name] ?? 0 : 0}
          onRate={rate}
          onClose={() => setSelectedTarget(null)}
        />

        {data && (
          <Suspense fallback={null}>
            <ChatPane planContext={planContextFor(data)} />
          </Suspense>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan view (post-setup)
// ---------------------------------------------------------------------------

interface PlanViewProps {
  data: PlanResponse;
  onReset: () => void;
  onSelect: (t: ScoredTarget) => void;
  selectedName: string | null;
}

function PlanView({ data, onReset, onSelect, selectedName }: PlanViewProps) {
  const summary = data.ai_plan?.session_summary;
  const notes = data.ai_plan?.session_notes;
  const apiError = data.ai_plan?.error;
  const isEmpty = data.targets.length === 0;

  return (
    <div className="plan-view">
      <div className="plan-view__header">
        <div>
          <div className="plan-view__title">
            Tonight from{" "}
            <span className="mono">
              {data.request.lat.toFixed(2)}, {data.request.lon.toFixed(2)}
            </span>
          </div>
          {summary && <div className="plan-view__summary">{summary}</div>}
          {apiError && (
            <div className="plan-view__summary" style={{ color: "var(--negative)" }}>
              AI plan unavailable: {apiError} — deterministic ordering shown below.
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <SeeingForecast slots={data.seeing_forecast} />
          <button onClick={onReset}>New plan</button>
        </div>
      </div>

      {isEmpty ? (
        <div
          style={{
            margin: "0 32px 48px",
            padding: "20px 24px",
            maxWidth: 820,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--accent-glow)",
            color: "var(--text-secondary)",
            fontSize: 14,
            lineHeight: 1.7,
          }}
        >
          <div className="setup__label" style={{ marginBottom: 8 }}>
            No targets for this plan
          </div>
          {data.notice ??
            "No targets matched. Try a different date, location, or gear."}
        </div>
      ) : (
        <Suspense fallback={<div className="muted" style={{ padding: 32 }}>Loading timeline…</div>}>
          <SessionTimeline
            targets={data.targets}
            seeingForecast={data.seeing_forecast}
            onSelectTarget={onSelect}
            moonIllumination={data.moon_illumination}
            bortleClass={data.bortle_class}
            selectedName={selectedName}
          />
        </Suspense>
      )}

      {notes && (
        <section
          style={{
            padding: "0 32px 96px",
            color: "var(--text-secondary)",
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            maxWidth: 820,
          }}
        >
          <div className="setup__label" style={{ marginBottom: 8 }}>
            Session notes
          </div>
          {notes}
        </section>
      )}
    </div>
  );
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
