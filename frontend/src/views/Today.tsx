import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { PlanItem, TrackableView } from "../lib/types";
import { num } from "../lib/format";
import { Button, Card, Empty, Tag } from "../components/Primitives";

/**
 * Today's plan (§25.5).
 *
 * The order here is the WEEK's order -- the day redistributes, it does not
 * re-rank (D9). Logging a session must not reshuffle this list, because a plan
 * that reshuffles every time you touch it is one you stop believing.
 *
 * Every item can be interrogated: the "why this?" line is generated from the
 * stored score breakdown, never by the model (§25.6, P3).
 */
export function Today({
  items,
  trackables,
  capBinding,
  onChanged,
  onGenerate,
  busy,
}: {
  items: PlanItem[];
  trackables: TrackableView[];
  capBinding: boolean;
  onChanged: () => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    try {
      await api.post("/api/planning/day");
      onGenerate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (items.length === 0) {
    return (
      <div className="space-y-3">
        <Empty
          title="No plan for today"
          hint="Declare this week's capacity, commit sessions to what matters, then generate the day."
        />
        <Button className="w-full" onClick={generate} disabled={busy}>
          Generate today's plan
        </Button>
        {error && <div className="rounded-xl bg-bad/8 px-3 py-2 text-xs text-bad">{error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* D9: a binding cap means the week does not fit. That is a rebaseline
          signal, and saying so is the whole point -- the alternative is issuing
          a day the user will not complete and calling it a plan. */}
      {capBinding && (
        <Card className="border-warn/40 bg-warn/8">
          <div className="text-sm font-semibold text-warn">This week does not fit</div>
          <p className="mt-1 text-xs text-muted">
            The catch-up cap is binding, so today's numbers are capped rather than honest. Spreading
            the shortfall further would just produce a day you will not finish. Rebaseline instead:
            add sessions from another goal, cut scope, move the date, or declare it infeasible.
          </p>
        </Card>
      )}

      {items.map((item) => (
        <PlanRow key={item.id} item={item} trackables={trackables} onChanged={onChanged} />
      ))}
    </div>
  );
}

const TIER_TONE = { A: "bad", B: "accent", C: "neutral", D: "neutral" } as const;
const TIER_LABEL = {
  A: "deadline risk",
  B: "above threshold",
  C: "quick",
  D: "the rest",
} as const;

function PlanRow({
  item,
  trackables,
  onChanged,
}: {
  item: PlanItem;
  trackables: TrackableView[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trackable = trackables.find((t) => t.trackable_id === item.trackable_id);
  const alloc = item.score_breakdown.daily_allocation;

  async function act(action: string) {
    await api.patch(`/api/planning/plan-items/${item.id}`, { user_action: action });
    onChanged();
  }

  async function start() {
    if (item.trackable_id) {
      await api.post("/api/sessions/start", { trackable_id: item.trackable_id });
    } else {
      await api.post("/api/sessions/start", { milestone_id: item.milestone_id });
    }
    onChanged();
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Tag tone={TIER_TONE[item.tier]}>
              {item.tier} · {TIER_LABEL[item.tier]}
            </Tag>
            {item.user_action && <Tag>{item.user_action}</Tag>}
          </div>
          <div className="mt-1 truncate font-semibold">
            {item.label ?? trackable?.title ?? `Item ${item.rank}`}
          </div>
          {alloc && (
            <div className="text-xs text-muted">
              today: {num(alloc.per_day)} {alloc.unit}
              {alloc.capped && <span className="text-warn"> · capped</span>}
            </div>
          )}
        </div>
        <Button onClick={start} className="shrink-0">
          Start
        </Button>
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-3 text-xs font-medium text-accent underline underline-offset-2"
      >
        {open ? "hide reasoning" : "why this?"}
      </button>

      {/* P3: decomposed into the components that produced it. If the user
          cannot interrogate a recommendation, they cannot calibrate trust in
          it, and they will eventually discard the whole system. */}
      {open && (
        <div className="mt-2 space-y-1.5 rounded-xl bg-surface p-3">
          {item.score_breakdown.components.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-xs">
              <span className="w-36 shrink-0 text-muted">{c.name.replace(/_/g, " ")}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                <div
                  className={`h-1.5 rounded-full ${c.contribution < 0 ? "bg-bad" : "bg-accent"}`}
                  style={{ width: `${Math.min(100, Math.abs(c.contribution) * 250)}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-[11px]">
                {c.contribution >= 0 ? "+" : ""}
                {c.contribution.toFixed(3)}
              </span>
            </div>
          ))}
          <div className="flex justify-between border-t border-line pt-1.5 text-xs font-semibold">
            <span>score</span>
            <span className="font-mono">{item.score.toFixed(4)}</span>
          </div>
          <p className="pt-1 text-[11px] text-muted">
            Scored once for the week and reused today — logging a session does not reshuffle this
            list.
          </p>
        </div>
      )}

      {/* §18: accept / modify / reject / defer, recorded. Revealed preference
          is the only real signal about what the user actually values. */}
      <div className="mt-3 flex gap-2">
        {(["accepted", "deferred", "rejected"] as const).map((action) => (
          <Button
            key={action}
            variant="ghost"
            className="flex-1 text-xs"
            onClick={() => act(action)}
          >
            {action === "accepted" ? "Accept" : action === "deferred" ? "Defer" : "Reject"}
          </Button>
        ))}
      </div>
    </Card>
  );
}
