import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { GoalTree, type TreeNode } from "../components/GoalTree";
import { Card, Empty, SectionLabel, Tag } from "../components/Primitives";
import { num } from "../lib/format";

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
  stakes: number; status: string; children: ApiMilestone[];
}

/** Adapts persisted rows into the shared TreeNode shape. */
function toNodes(goals: ApiGoal[]): TreeNode[] {
  return goals.map((g) => ({
    key: `g${g.id}`,
    kind: "goal",
    title: g.title,
    subtitle: g.deadline ? `by ${g.deadline}` : "no deadline",
    flags: {
      estimated: g.dod_source === "model_estimated",
      parked: g.activation === "parked",
    },
    children: g.children.map((m) => ({
      key: `m${m.id}`,
      kind: "milestone" as const,
      title: m.title,
      subtitle: m.exploratory
        ? `${m.planned_sessions ?? "?"} sessions budgeted`
        : m.definition_of_done,
      flags: {
        estimated: m.dod_source === "model_estimated",
        exploratory: m.exploratory,
      },
      children: m.children.map((t) => ({
        key: `t${t.id}`,
        kind: "trackable" as const,
        title: t.title,
        subtitle: `${num(t.completed_units, 0)} / ${num(t.total_units, 0)} ${t.unit}`,
        fraction: t.fraction,
        flags: { estimated: t.total_units_source === "model_estimated" },
      })),
    })),
  }));
}

export function Tree() {
  const [goals, setGoals] = useState<ApiGoal[] | null>(null);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ goals: ApiGoal[] }>("/api/tree")
      .then((r) => setGoals(r.goals))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const nodes = useMemo(() => (goals ? toNodes(goals) : []), [goals]);

  if (error) return <div className="rounded-xl bg-bad/10 px-4 py-3 text-xs text-bad">{error}</div>;
  if (!goals) return <Empty title="Loading your tree…" />;
  if (goals.length === 0) {
    return (
      <Empty
        title="Nothing to draw yet"
        hint="Create a goal — or run the intake conversation — and the tree appears here."
      />
    );
  }

  return (
    <div className="space-y-3">
      <GoalTree
        roots={nodes}
        onSelect={setSelected}
        selectedKey={selected?.key ?? null}
        className="h-[62vh] min-h-[380px]"
      />

      {selected ? (
        <Card>
          <SectionLabel>{selected.kind}</SectionLabel>
          <div className="mt-1.5 text-sm font-semibold">{selected.title}</div>
          {selected.subtitle && (
            <div className="mt-0.5 text-xs text-muted">{selected.subtitle}</div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {/* D3: an inferred value is flagged wherever it is shown. */}
            {selected.flags?.estimated && <Tag tone="warn">inferred, not measured</Tag>}
            {selected.flags?.exploratory && <Tag tone="accent">no honest counter</Tag>}
            {selected.flags?.parked && <Tag>parked — competes for nothing</Tag>}
          </div>
        </Card>
      ) : (
        <div className="px-1 text-[11px] text-faint">
          Drag to pan, scroll to zoom, click a node for detail.
        </div>
      )}
    </div>
  );
}
