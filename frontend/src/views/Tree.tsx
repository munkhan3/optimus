import { useEffect, useMemo, useState } from "react";
import { ViewHint } from "../components/ViewChrome";
import { api, ApiError } from "../lib/api";
import { GoalGraph } from "../components/GoalGraph";
import { Banner, Button, Empty, SectionLabel, Skeleton, Stat, Tag } from "../components/Primitives";
import { type Cluster, type Focus, type GraphNode, RATIO_CEILING } from "../lib/graphLayout";
import { type Area, areaColors, UNASSIGNED_COLOR } from "../lib/areas";
import type { TrackableView } from "../lib/types";
import {
  basisLabel,
  pct,
  goalTiming,
  intervalText,
  num,
  paceText,
  projectionText,
} from "../lib/format";

/** Shape of GET /api/tree — structure plus what already sits on the rows. */
interface ApiTrackable {
  id: number; kind: "trackable"; title: string; unit: string;
  total_units: number; completed_units: number; fraction: number | null;
  total_units_source: string; task_type: string; exploratory: boolean;
  status: string; target_date: string | null;
}
interface ApiMilestone {
  id: number; kind: "milestone"; title: string; definition_of_done: string;
  dod_source: string; exploratory: boolean; planned_sessions: number | null;
  status: string; deadline: string | null; children: ApiTrackable[];
}
interface ApiGoal {
  id: number; kind: "goal"; title: string; definition_of_done: string;
  dod_source: string; activation: string; deadline: string | null;
  stakes: number; status: string; pace_mode: string;
  reset_period_days: number | null; area_id: number | null;
  parent_id: number | null; children: (ApiMilestone | ApiGoal)[];
}
interface ApiTree {
  areas: { id: number; name: string; color: string | null }[];
  goals: ApiGoal[];
}
interface WeekCommitment {
  trackable_id: number | null;
  milestone_id: number | null;
  committed_sessions: number;
}

/**
 * Average of the values that exist, or null when none do.
 *
 * Rolling up must never invent a number: a goal whose trackables all have
 * unknown health has unknown health, not zero and not "fine". The graph renders
 * that as a hollow ring (P2).
 */
function rollup(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

function sum(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/**
 * How fast the work is actually going against how fast it has to go.
 *
 * Computed here rather than read off the wire: the server exposes both operands
 * on /api/trackables but never their ratio. The three null cases below are real
 * states, not defensive padding, and each one means "no signal" rather than
 * "fine" — the Pace view gives them their own lane instead of quietly folding
 * them into on-pace.
 */
function paceRatio(m: TrackableView | undefined): number | null {
  if (!m) return null;
  // required_pace is null as an object when there is neither a weekly
  // commitment nor a baseline: there is no denominator to divide by.
  if (!m.required_pace || m.required_pace.point == null) return null;
  // pace.point is null when the basis is "unavailable" — nothing observed and
  // no prior to fall back on.
  if (m.pace.point == null) return null;
  // A required pace of zero means remaining_units is zero: the work is
  // finished, not infinitely fast. It is comfortably ahead, and dividing by it
  // would produce an infinity that then poisons every roll-up above it.
  if (m.required_pace.point === 0) return RATIO_CEILING;
  return m.pace.point / m.required_pace.point;
}

/**
 * Builds the clusters the graph draws.
 *
 * Health and session counts come from two other endpoints and are joined here
 * rather than server-side: /api/tree is deliberately metric-free so it stays a
 * fixed number of queries, and /api/trackables already returns the full metric
 * view for every trackable in one call.
 */
function buildClusters(
  tree: ApiTree,
  metrics: Map<number, TrackableView>,
  sessions: { byTrackable: Map<number, number>; byMilestone: Map<number, number> },
): Cluster[] {
  function trackableNode(t: ApiTrackable): GraphNode {
    const m = metrics.get(t.id);
    return {
      key: `t${t.id}`,
      kind: "trackable",
      title: t.title,
      subtitle: `${num(t.completed_units, 0)} / ${num(t.total_units, 0)} ${t.unit}`,
      health: m?.health.score ?? null,
      paceRatio: paceRatio(m),
      sessions: sessions.byTrackable.get(t.id) ?? null,
      fraction: t.fraction,
      flags: { estimated: t.total_units_source === "model_estimated", exploratory: t.exploratory },
      children: [],
    };
  }

  function milestoneNode(m: ApiMilestone): GraphNode {
    const kids = m.children.map(trackableNode);
    return {
      key: `m${m.id}`,
      kind: "milestone",
      title: m.title,
      subtitle: m.exploratory
        ? `${m.planned_sessions ?? "?"} sessions budgeted`
        : m.definition_of_done,
      // A milestone with no trackables has no derivable health -- milestone_view
      // exists in the engine but has no HTTP route, so this stays honestly null.
      health: rollup(kids.map((k) => k.health)),
      // A milestone has no pace of its own either, so it inherits the mean of
      // the children that do have one — and stays null when none of them do.
      paceRatio: rollup(kids.map((k) => k.paceRatio)),
      sessions: sessions.byMilestone.get(m.id) ?? sum(kids.map((k) => k.sessions)),
      flags: { estimated: m.dod_source === "model_estimated", exploratory: m.exploratory },
      children: kids,
    };
  }

  function goalNode(g: ApiGoal): GraphNode {
    // A nested goal arrives in the same children array as milestones.
    const kids = g.children.map((c) =>
      c.kind === "milestone" ? milestoneNode(c as ApiMilestone) : goalNode(c as ApiGoal),
    );
    return {
      key: `g${g.id}`,
      kind: "goal",
      title: g.title,
      subtitle: goalTiming(g),
      health: rollup(kids.map((k) => k.health)),
      paceRatio: rollup(kids.map((k) => k.paceRatio)),
      sessions: sum(kids.map((k) => k.sessions)),
      flags: {
        estimated: g.dod_source === "model_estimated",
        parked: g.activation === "parked",
      },
      children: kids,
    };
  }

  // Colour reaches the region an area owns, never the dots inside it.
  const colors = areaColors(tree.areas as Area[]);
  const clusters: Cluster[] = tree.areas.map((a) => ({
    areaId: a.id,
    name: a.name,
    color: colors.get(a.id) ?? UNASSIGNED_COLOR,
    goals: tree.goals.filter((g) => g.area_id === a.id).map(goalNode),
  }));

  const unfiled = tree.goals.filter((g) => g.area_id === null);
  if (unfiled.length > 0) {
    // Unfiled work is shown, never hidden -- otherwise it quietly stops existing.
    clusters.push({
      areaId: null,
      name: "Unassigned",
      color: UNASSIGNED_COLOR,
      goals: unfiled.map(goalNode),
    });
  }
  return clusters.filter((c) => c.goals.length > 0);
}

export function Tree({ onStarted, sessionOpen }: { onStarted: () => void; sessionOpen: boolean }) {
  const [tree, setTree] = useState<ApiTree | null>(null);
  const [metrics, setMetrics] = useState<TrackableView[]>([]);
  const [week, setWeek] = useState<WeekCommitment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  async function load() {
    try {
      const [t, m, w] = await Promise.all([
        api.get<ApiTree>("/api/tree"),
        api.get<TrackableView[]>("/api/trackables"),
        // A missing week is normal (nothing committed), not an error.
        api
          .get<{ commitments: WeekCommitment[] }>("/api/planning/week")
          .catch(() => ({ commitments: [] })),
      ]);
      setTree(t);
      setMetrics(m);
      setWeek(w.commitments ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const clusters = useMemo(() => {
    if (!tree) return [];
    const byId = new Map(metrics.map((m) => [m.trackable_id, m]));
    const byTrackable = new Map<number, number>();
    const byMilestone = new Map<number, number>();
    week.forEach((c) => {
      if (c.trackable_id != null) byTrackable.set(c.trackable_id, c.committed_sessions);
      if (c.milestone_id != null) byMilestone.set(c.milestone_id, c.committed_sessions);
    });
    return buildClusters(tree, byId, { byTrackable, byMilestone });
  }, [tree, metrics, week]);

  if (error) return <div className="p-4"><Banner>{error}</Banner></div>;
  if (!tree) return <Skeleton className="h-full w-full rounded-none" />;
  if (clusters.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty
          title="Nothing to Draw Yet"
          hint="Create a goal — or run the intake conversation — and the map appears here."
        />
      </div>
    );
  }

  const trackableId = selected?.key.startsWith("t") ? Number(selected.key.slice(1)) : null;
  const metric = trackableId != null ? metrics.find((m) => m.trackable_id === trackableId) : undefined;

  return (
    /* Full bleed. On a wide screen the detail panel is a rail and the map
       reflows into what is left -- floating it over the canvas covered the very
       branch you had just selected. On a phone there is no room for a rail, so
       it becomes a sheet along the bottom instead. */
    <div className="relative flex h-full w-full">
      <GoalGraph
        clusters={clusters}
        focus={focus}
        onFocus={setFocus}
        selectedKey={selected?.key ?? null}
        onSelect={setSelected}
        className="h-full min-w-0 flex-1"
      />

      {selected && (
        <aside
          className="absolute inset-x-0 bottom-0 z-10 max-h-[55%] overflow-y-auto border-t border-line bg-surface/95 p-4 backdrop-blur
                     lg:static lg:z-auto lg:max-h-none lg:w-[340px] lg:shrink-0 lg:border-l lg:border-t-0 lg:bg-surface lg:p-5 lg:backdrop-blur-none"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel>{selected.kind}</SectionLabel>
              <div className="display mt-1.5 text-subheading">{selected.title}</div>
              {selected.subtitle && (
                <div className="mt-1 text-[13px] leading-relaxed text-muted">{selected.subtitle}</div>
              )}
            </div>
            <button
              onClick={() => setSelected(null)}
              aria-label="Close details"
              className="shrink-0 rounded-control px-2 py-1 text-[13px] text-faint transition hover:text-ink"
            >
              Close
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {/* D3: an inferred value is flagged wherever it is shown. */}
            {selected.flags?.estimated && <Tag tone="warn">Inferred, Not Measured</Tag>}
            {selected.flags?.exploratory && <Tag tone="accent">No Honest Counter</Tag>}
            {selected.flags?.parked && <Tag>Parked — Competes for Nothing</Tag>}
            {selected.health == null && <Tag>Health Undetermined</Tag>}
          </div>

          {metric && (
            <>
              <div className="mt-5 grid grid-cols-2 gap-4">
                <Stat
                  label="Pace"
                  value={paceText(metric.pace, metric.unit)}
                  hint={
                    intervalText(metric.pace, metric.unit) ??
                    basisLabel(metric.pace.basis, metric.pace.n_sessions)
                  }
                />
                <Stat label="Projected" value={projectionText(metric.projection)} />
                <Stat
                  label="Committed"
                  value={selected.sessions == null ? "—" : `${num(selected.sessions, 0)} sessions`}
                  hint="This Week"
                />
                <Stat
                  label="Progress"
                  value={
                    metric.progress.fraction == null ? "—" : pct(metric.progress.fraction)
                  }
                  hint={`${num(metric.progress.completed_units, 0)} of ${num(metric.progress.total_units, 0)} ${metric.unit}`}
                />
              </div>
              <Button
                className="mt-5 w-full"
                onClick={async () => {
                  await api.post("/api/sessions/start", { trackable_id: metric.trackable_id });
                  onStarted();
                }}
                disabled={sessionOpen}
              >
                Start
              </Button>
            </>
          )}
        </aside>
      )}

      {!selected && (
        <ViewHint>
          Hover to trace a branch, click to keep it lit. Drag to pan, scroll to zoom.
        </ViewHint>
      )}
    </div>
  );
}
