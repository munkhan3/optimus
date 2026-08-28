import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Goal, TrackableView } from "../lib/types";
import { num } from "../lib/format";
import { Button, Card, Tag } from "../components/Primitives";

/**
 * Setup and weekly planning: the goal graph, capacity, and the commitment.
 *
 * §16 makes the weekly commitment the load-bearing unit, and §11 makes capacity
 * a declaration rather than an inference. Both live here because they are the
 * same decision seen twice: how many sessions exist, and what they are spent on.
 */

interface CapacitySummary {
  capacity: { id: number; week_start: string; available_hours: number };
  sessions_available: number;
  sessions_allocated: number;
  sessions_unallocated: number;
  over_committed: boolean;
  budgets: {
    goal_id: number;
    goal_title: string | null;
    stakes: number | null;
    budgeted_sessions: number;
    share: number | null;
  }[];
}

interface RankRow {
  rank: number;
  trackable_id: number | null;
  milestone_id: number | null;
  label: string;
  score: number;
  explanation: string;
}

export function Plan({
  trackables,
  onChanged,
}: {
  trackables: TrackableView[];
  onChanged: () => void;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [capacity, setCapacity] = useState<CapacitySummary | null>(null);
  const [ranking, setRanking] = useState<RankRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setGoals(await api.get<Goal[]>("/api/goals"));
      setCapacity(await api.get<CapacitySummary | null>("/api/capacity/current"));
      setRanking(await api.get<RankRow[]>("/api/planning/ranking"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function refreshAll() {
    void load();
    onChanged();
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-bad/8 px-3 py-2 text-xs text-bad">{error}</div>}

      <CapacitySection capacity={capacity} goals={goals} onChanged={refreshAll} />
      <RankingSection ranking={ranking} onChanged={refreshAll} />
      <GoalsSection goals={goals} onChanged={refreshAll} />
      <RebaselineSection trackables={trackables} onChanged={refreshAll} />
    </div>
  );
}

/* ------------------------------------------------------------------ capacity */

function CapacitySection({
  capacity,
  goals,
  onChanged,
}: {
  capacity: CapacitySummary | null;
  goals: Goal[];
  onChanged: () => void;
}) {
  const [hours, setHours] = useState("10");
  const [error, setError] = useState<string | null>(null);

  function mondayOf(d: Date): string {
    const copy = new Date(d);
    copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
    return copy.toISOString().slice(0, 10);
  }

  async function declare() {
    setError(null);
    try {
      await api.post("/api/capacity", {
        week_start: mondayOf(new Date()),
        available_hours: Number(hours),
      });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function setBudget(goalId: number, sessions: number) {
    setError(null);
    try {
      await api.put(`/api/capacity/${capacity!.capacity.id}/budgets`, {
        goal_id: goalId,
        budgeted_sessions: Math.max(0, sessions),
      });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!capacity) {
    return (
      <Card>
        <SectionTitle>This week's capacity</SectionTitle>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          How many focus hours actually exist this week — after coursework, work, sleep, and life.
          Declared, not guessed: everything downstream divides this number.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="min-h-11 w-24 rounded-xl border border-line bg-raised px-3 text-sm"
          />
          <Button onClick={declare}>Declare hours</Button>
        </div>
        {error && <div className="mt-2 text-xs text-bad">{error}</div>}
      </Card>
    );
  }

  const activeGoals = goals.filter((g) => g.activation === "active" && g.kind !== "vision");

  return (
    <Card>
      <SectionTitle>This week</SectionTitle>
      <div className="mt-2 flex items-baseline gap-3 text-sm">
        <span className="text-2xl font-bold">{capacity.sessions_available}</span>
        <span className="text-muted">sessions available</span>
        {capacity.over_committed && <Tag tone="bad">over-committed</Tag>}
      </div>

      {/* §11: the portfolio is explicit. Every increase is visibly taken from
          somewhere else, so there is no free reallocation on offer. */}
      <div className="mt-3 space-y-2">
        {activeGoals.map((goal) => {
          const budget = capacity.budgets.find((b) => b.goal_id === goal.id);
          const value = budget?.budgeted_sessions ?? 0;
          return (
            <div key={goal.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{goal.title}</div>
                <div className="text-[11px] text-muted">
                  stakes {goal.stakes}
                  {budget?.share != null && ` · ${Math.round(budget.share * 100)}% of the week`}
                </div>
              </div>
              <button
                onClick={() => setBudget(goal.id, value - 1)}
                className="size-9 rounded-lg border border-line text-lg leading-none"
              >
                −
              </button>
              <span className="w-8 text-center font-mono text-sm">{value}</span>
              <button
                onClick={() => setBudget(goal.id, value + 1)}
                className="size-9 rounded-lg border border-line text-lg leading-none"
              >
                +
              </button>
            </div>
          );
        })}
      </div>

      <div
        className={`mt-3 text-xs ${capacity.over_committed ? "text-bad" : "text-muted"}`}
      >
        {capacity.sessions_allocated} allocated ·{" "}
        {capacity.sessions_unallocated >= 0
          ? `${capacity.sessions_unallocated} unspent`
          : `${-capacity.sessions_unallocated} more than you have`}
      </div>
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}
    </Card>
  );
}

/* ------------------------------------------------------------------- ranking */

function RankingSection({
  ranking,
  onChanged,
}: {
  ranking: RankRow[];
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function key(r: RankRow) {
    return r.trackable_id ? `t${r.trackable_id}` : `m${r.milestone_id}`;
  }

  async function commit() {
    setError(null);
    const items = ranking
      .map((r) => ({
        trackable_id: r.trackable_id ?? undefined,
        milestone_id: r.milestone_id ?? undefined,
        committed_sessions: Number(sessions[key(r)] ?? 0),
      }))
      .filter((i) => i.committed_sessions > 0);
    if (items.length === 0) return;
    try {
      await api.post("/api/planning/commit", items);
      await api.post("/api/planning/day");
      setDone(true);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (ranking.length === 0) return null;

  return (
    <Card>
      <SectionTitle>Commit the week</SectionTitle>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        Ranked once, now. The daily plan redistributes these without re-scoring — that stability is
        what keeps the plan believable.
      </p>

      <div className="mt-3 space-y-3">
        {ranking.map((r) => (
          <div key={key(r)} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {r.rank}. {r.label}
              </div>
              {/* §25.6: this line comes from the stored breakdown, not the model. */}
              <div className="text-[11px] text-muted">{r.explanation}</div>
            </div>
            <input
              type="number"
              min={0}
              placeholder="0"
              value={sessions[key(r)] ?? ""}
              onChange={(e) => setSessions((s) => ({ ...s, [key(r)]: e.target.value }))}
              className="min-h-11 w-16 rounded-xl border border-line bg-raised px-2 text-center text-sm"
            />
          </div>
        ))}
      </div>

      <Button className="mt-3 w-full" onClick={commit}>
        Commit and generate today
      </Button>
      {done && <div className="mt-2 text-xs text-good">Committed. Today's plan is ready.</div>}
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}
    </Card>
  );
}

/* --------------------------------------------------------------------- goals */

function GoalsSection({ goals, onChanged }: { goals: Goal[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <SectionTitle>Goals</SectionTitle>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-accent underline underline-offset-2"
        >
          {open ? "close" : "add"}
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {goals.map((g) => (
          <GoalRow key={g.id} goal={g} onChanged={onChanged} />
        ))}
        {goals.length === 0 && <div className="text-xs text-muted">No goals yet.</div>}
      </div>

      {open && <NewGoalForm onCreated={onChanged} />}
    </Card>
  );
}

function NewGoalForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [dod, setDod] = useState("");
  const [deadline, setDeadline] = useState("");
  const [stakes, setStakes] = useState("3");
  const [error, setError] = useState<string | null>(null);

  async function create(activation: "active" | "parked") {
    setError(null);
    try {
      await api.post("/api/goals", {
        title,
        kind: "goal",
        definition_of_done: dod,
        dod_source: "user_supplied",
        activation,
        deadline: deadline || null,
        stakes: Number(stakes),
      });
      setTitle("");
      setDod("");
      setDeadline("");
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <Field label="Title" value={title} onChange={setTitle} placeholder="Q1 quant offer" />
      {/* §10: the requirement is verifiability, not numeracy. The placeholder
          shows a checkable condition rather than a number, because forcing a
          number where none exists is the most damaging thing this can do. */}
      <Field
        label="What must be true for this to be done?"
        value={dod}
        onChange={setDod}
        placeholder="A signed offer in Chicago"
      />
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-muted">
          Deadline
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          />
        </label>
        <label className="w-24 text-xs text-muted">
          Stakes 1–5
          <input
            type="number"
            min={1}
            max={5}
            value={stakes}
            onChange={(e) => setStakes(e.target.value)}
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!title || !dod} onClick={() => create("active")}>
          Activate
        </Button>
        <Button
          variant="ghost"
          className="flex-1"
          disabled={!title || !dod}
          onClick={() => create("parked")}
        >
          Park it
        </Button>
      </div>
      <p className="text-[11px] text-muted">
        Activating needs a deadline. A goal without one is an intention, not work in progress —
        park it instead.
      </p>
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- rebaseline */

function RebaselineSection({
  trackables,
  onChanged,
}: {
  trackables: TrackableView[];
  onChanged: () => void;
}) {
  const [target, setTarget] = useState<TrackableView | null>(null);
  if (trackables.length === 0) return null;

  return (
    <Card>
      <SectionTitle>Rebaseline</SectionTitle>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        When reality diverges from the plan, choose explicitly. Version 1 is kept forever so the
        drift stays visible.
      </p>
      <div className="mt-2 space-y-1.5">
        {trackables.map((t) => (
          <button
            key={t.trackable_id}
            onClick={() => setTarget(t)}
            className="flex w-full items-center justify-between rounded-xl bg-raised px-3 py-2.5 text-left text-sm"
          >
            <span className="truncate">{t.title}</span>
            <span className="text-xs text-muted">
              drift {t.drift?.sessions != null ? num(t.drift.sessions) : "—"}
            </span>
          </button>
        ))}
      </div>
      {target && (
        <RebaselineForm
          trackable={target}
          onDone={() => {
            setTarget(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

/* §17: exactly four options, and move_deadline is never preselected. Silent
   deadline extension is how a goal drifts for months without formally failing. */
const OPTIONS = [
  { id: "add_sessions", label: "Add sessions", hint: "taken from another goal's budget" },
  { id: "cut_scope", label: "Cut scope", hint: "record what was dropped" },
  { id: "move_deadline", label: "Move the deadline", hint: "only if it fits after the move" },
  { id: "declare_infeasible", label: "Declare infeasible", hint: "abandon, park, or escalate" },
] as const;

function RebaselineForm({
  trackable,
  onDone,
}: {
  trackable: TrackableView;
  onDone: () => void;
}) {
  const [resolution, setResolution] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [sessions, setSessions] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await api.post(`/api/baselines/rebaseline?trackable_id=${trackable.trackable_id}`, {
        resolution,
        rationale,
        planned_sessions: Number(sessions || 0),
        target_date: date,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="text-sm font-medium">{trackable.title}</div>
      <div className="space-y-1.5">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => setResolution(o.id)}
            className={`w-full rounded-xl border px-3 py-2 text-left ${
              resolution === o.id ? "border-accent bg-accent/8" : "border-line"
            }`}
          >
            <div className="text-sm font-medium">{o.label}</div>
            <div className="text-[11px] text-muted">{o.hint}</div>
          </button>
        ))}
      </div>
      {resolution && (
        <>
          <Field
            label="Why? (recorded permanently)"
            value={rationale}
            onChange={setRationale}
            placeholder="The last 80 pages are reference material"
          />
          <div className="flex gap-2">
            <label className="w-28 text-xs text-muted">
              Sessions
              <input
                type="number"
                value={sessions}
                onChange={(e) => setSessions(e.target.value)}
                className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
              />
            </label>
            <label className="flex-1 text-xs text-muted">
              Target date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
              />
            </label>
          </div>
          <Button
            className="w-full"
            disabled={!rationale.trim() || !date}
            onClick={submit}
          >
            Record rebaseline
          </Button>
        </>
      )}
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}

/* ---------------------------------------------------- goal -> milestone -> work */

interface MilestoneRow {
  id: number;
  goal_id: number;
  title: string;
  definition_of_done: string;
  planned_sessions: number | null;
  exploratory: boolean;
}

function GoalRow({ goal, onChanged }: { goal: Goal; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [adding, setAdding] = useState(false);

  async function load() {
    setMilestones(await api.get<MilestoneRow[]>(`/api/milestones?goal_id=${goal.id}`));
  }
  useEffect(() => {
    if (open) void load();
  }, [open]);

  return (
    <div className="rounded-xl border border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{goal.title}</span>
        {goal.kind === "vision" && <Tag tone="accent">vision</Tag>}
        {/* §12: parked goals are visible but compete for nothing. */}
        {goal.activation === "parked" && <Tag>parked</Tag>}
        {goal.dod_source === "model_estimated" && <Tag tone="warn">DoD inferred</Tag>}
        {goal.deadline && <span className="text-[11px] text-muted">{goal.deadline}</span>}
      </button>

      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          <div className="text-[11px] text-muted">
            Done when: {goal.definition_of_done}
          </div>
          {milestones.map((m) => (
            <MilestoneRowView key={m.id} milestone={m} onChanged={onChanged} />
          ))}
          {milestones.length === 0 && (
            <div className="text-xs text-muted">No milestones yet.</div>
          )}
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-xs font-medium text-accent underline underline-offset-2"
          >
            {adding ? "cancel" : "add milestone"}
          </button>
          {adding && (
            <NewMilestoneForm
              goalId={goal.id}
              onCreated={() => {
                setAdding(false);
                void load();
                onChanged();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MilestoneRowView({
  milestone,
  onChanged,
}: {
  milestone: MilestoneRow;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="rounded-lg bg-raised px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{milestone.title}</span>
        {/* §10: work with no natural counter is budgeted in sessions, not
            given invented units. Both are first-class here. */}
        {milestone.exploratory && <Tag tone="accent">exploratory</Tag>}
        {milestone.planned_sessions != null && <Tag>{milestone.planned_sessions} sessions</Tag>}
      </div>
      <button
        onClick={() => setAdding((v) => !v)}
        className="mt-1 text-[11px] font-medium text-accent underline underline-offset-2"
      >
        {adding ? "cancel" : "add trackable"}
      </button>
      {adding && (
        <NewTrackableForm
          milestoneId={milestone.id}
          onCreated={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function NewMilestoneForm({ goalId, onCreated }: { goalId: number; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [dod, setDod] = useState("");
  const [exploratory, setExploratory] = useState(false);
  const [sessions, setSessions] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await api.post("/api/milestones", {
        goal_id: goalId,
        title,
        definition_of_done: dod,
        dod_source: "user_supplied",
        exploratory,
        planned_sessions: sessions ? Number(sessions) : null,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <Field label="Milestone" value={title} onChange={setTitle} placeholder="Finish the Green Book" />
      <Field
        label="What must be true for this to be done?"
        value={dod}
        onChange={setDod}
        placeholder="All 380 pages read"
      />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={exploratory}
          onChange={(e) => setExploratory(e.target.checked)}
          className="size-4 accent-[var(--color-accent)]"
        />
        No honest way to count this
      </label>
      {exploratory && (
        <>
          <Field
            label="Sessions to budget for it"
            value={sessions}
            onChange={setSessions}
            placeholder="6"
          />
          <p className="text-[11px] text-muted">
            Budgeted in sessions rather than invented units. Forcing a number where none exists
            makes every projection downstream rest on a figure nobody believes.
          </p>
        </>
      )}
      <Button className="w-full" disabled={!title || !dod} onClick={create}>
        Create milestone
      </Button>
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}

const TASK_TYPES = ["reading", "problems", "writing", "exploratory", "admin"] as const;

function NewTrackableForm({
  milestoneId,
  onCreated,
}: {
  milestoneId: number;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("pages");
  const [total, setTotal] = useState("");
  const [taskType, setTaskType] = useState<string>("reading");
  const [pace, setPace] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      const res = await api.post<{ trackable: { id: number } }>("/api/trackables", {
        milestone_id: milestoneId,
        title,
        unit,
        total_units: Number(total),
        total_units_source: "user_supplied",
        task_type: taskType,
        prior_pace: pace ? Number(pace) : null,
        target_date: date || null,
      });
      // §24.2's denominator and §24.4's drift both need a baseline to exist, and
      // v1 is retained forever, so it is created with the trackable rather than
      // left for later.
      if (date) {
        await api.post("/api/baselines", {
          trackable_id: res.trackable.id,
          planned_sessions: pace ? Math.ceil(Number(total) / Number(pace)) : 10,
          target_date: date,
          scope_units: Number(total),
        });
      }
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <Field label="Trackable" value={title} onChange={setTitle} placeholder="Green Book" />
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-muted">
          Unit
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          />
        </label>
        <label className="flex-1 text-xs text-muted">
          How many
          <input
            type="number"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-muted">
          Kind of work
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-xs text-muted">
          Per session?
          <input
            type="number"
            value={pace}
            onChange={(e) => setPace(e.target.value)}
            placeholder="your guess"
            className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
          />
        </label>
      </div>
      <label className="block text-xs text-muted">
        Target date
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-2 text-sm text-ink"
        />
      </label>
      {/* §13: the estimate is the starting point the system will correct. Saying
          so up front is what makes being wrong feel like data rather than failure. */}
      <p className="text-[11px] text-muted">
        Your per-session guess is only a starting point — it gets replaced by what you actually do.
      </p>
      <Button className="w-full" disabled={!title || !total} onClick={create}>
        Create trackable
      </Button>
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- primitives */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 min-h-11 w-full rounded-xl border border-line bg-raised px-3 text-sm text-ink"
      />
    </label>
  );
}
