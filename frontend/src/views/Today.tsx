import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { PlanItem, TrackableView } from "../lib/types";
import { localDate, num } from "../lib/format";
import { Banner, Button, Empty, InvertedCard, SectionLabel, Tag } from "../components/Primitives";

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
  sessionOpen,
}: {
  items: PlanItem[];
  trackables: TrackableView[];
  capBinding: boolean;
  onChanged: () => void;
  onGenerate: () => void;
  busy: boolean;
  /** Only one session may be open at a time, so Start has to know (§ sessions 409). */
  sessionOpen: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      /* Pass the date explicitly: the endpoint otherwise defaults to the
         SERVER's today, and a server in UTC generates tomorrow's plan all
         evening -- which the client then cannot find. */
      await api.post(`/api/planning/day?plan_date=${localDate()}`);
      onGenerate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <Empty
          title="No Plan for Today"
          hint="Declare this week's capacity, commit sessions to what matters, then generate the day."
        />
        <Button className="w-full" onClick={generate} pending={generating} disabled={busy}>
          Generate Today's Plan
        </Button>
        {error && <Banner>{error}</Banner>}
      </div>
    );
  }

  const [lead, ...rest] = items;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <SectionLabel>Focus Queue</SectionLabel>
          <div className="mt-1.5 text-body-sm text-muted">
            Start at the top. The order is fixed for this week.
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="display text-heading">{String(items.length).padStart(2, "0")}</div>
          <div className="section-label mt-1">Scheduled</div>
        </div>
      </div>

      {error && <Banner>{error}</Banner>}

      {/* D9: a binding cap means the week does not fit. That is a rebaseline
          signal, and saying so is the whole point -- the alternative is issuing
          a day the user will not complete and calling it a plan. */}
      {capBinding && (
        <Banner tone="warn" title="This Week Does Not Fit">
          The catch-up cap is binding, so today's numbers are capped rather than honest.
          Spreading the shortfall further would just produce a day you will not finish.
          Rebaseline instead: add sessions from another goal, cut scope, move the date, or
          declare it infeasible.
        </Banner>
      )}

      {/* The one thing you are meant to start is the one light object on the
          screen. design.md rations the inverted card to one or two per page, and
          that scarcity is exactly what makes it mean "this one". */}
      <LeadItem
        item={lead}
        trackables={trackables}
        onChanged={onChanged}
        sessionOpen={sessionOpen}
        onError={setError}
      />

      {rest.length > 0 && (
        <div className="divide-y divide-line overflow-hidden rounded-card bg-surface">
          {rest.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              trackables={trackables}
              onChanged={onChanged}
              sessionOpen={sessionOpen}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const TIER_TONE = { A: "bad", B: "accent", C: "neutral", D: "neutral" } as const;
const TIER_LABEL = {
  A: "Deadline Risk",
  B: "Above Threshold",
  C: "Quick",
  D: "The Rest",
} as const;
const TIER_DOT = {
  A: "bg-bad",
  B: "bg-iris",
  C: "bg-faint",
  D: "bg-faint",
} as const;

const ACTIONS = ["accepted", "deferred", "rejected"] as const;
const ACTION_LABEL = { accepted: "Accept", deferred: "Defer", rejected: "Reject" } as const;

/**
 * The shared behaviour behind both row shapes.
 *
 * `start` and `act` used to have no try/catch at all -- unlike `generate` in the
 * same file -- so a failure was an unhandled rejection and a button that simply
 * did nothing. The two highest-traffic actions on the screen were the two that
 * could fail invisibly.
 */
function usePlanItemActions(
  item: PlanItem,
  onChanged: () => void,
  onError: (m: string | null) => void,
) {
  const [pending, setPending] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    onError(null);
    setPending(key);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  const act = (action: string) =>
    run(action, () =>
      api.patch(`/api/planning/plan-items/${item.id}`, { user_action: action }),
    );

  const start = () =>
    run("start", () =>
      api.post(
        "/api/sessions/start",
        item.trackable_id
          ? { trackable_id: item.trackable_id }
          : { milestone_id: item.milestone_id },
      ),
    );

  return { pending, act, start };
}

/** Accept / modify / reject / defer, recorded (§18). Revealed preference is the
    only real signal about what the user actually values -- so the control has to
    show what was recorded, immediately, not after a four-request refresh. */
function ActionGroup({
  item,
  pending,
  act,
  inverted = false,
}: {
  item: PlanItem;
  pending: string | null;
  act: (a: string) => void;
  inverted?: boolean;
}) {
  return (
    <div
      className={`inline-flex rounded-control border ${inverted ? "border-void/20" : "border-line"}`}
      role="group"
      aria-label="Record what you did with this recommendation"
    >
      {ACTIONS.map((action, i) => {
        const on = item.user_action === action;
        return (
          <button
            key={action}
            onClick={() => act(action)}
            disabled={pending !== null}
            aria-pressed={on}
            className={`min-h-9 px-3 font-mono text-[10px] uppercase tracking-[0.12em] transition duration-200 ease-out disabled:opacity-40 ${
              i > 0 ? (inverted ? "border-l border-void/20" : "border-l border-line") : ""
            } ${i === 0 ? "rounded-l-[7px]" : ""} ${i === ACTIONS.length - 1 ? "rounded-r-[7px]" : ""} ${
              on
                ? inverted
                  ? "bg-void text-silver"
                  : "bg-pure text-void"
                : inverted
                  ? "text-void/60 hover:text-void"
                  : "text-faint hover:text-ink"
            }`}
          >
            {pending === action ? "…" : ACTION_LABEL[action]}
          </button>
        );
      })}
    </div>
  );
}

function LeadItem({
  item,
  trackables,
  onChanged,
  sessionOpen,
  onError,
}: {
  item: PlanItem;
  trackables: TrackableView[];
  onChanged: () => void;
  sessionOpen: boolean;
  onError: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { pending, act, start } = usePlanItemActions(item, onChanged, onError);
  const trackable = trackables.find((t) => t.trackable_id === item.trackable_id);
  const alloc = item.score_breakdown.daily_allocation;

  return (
    <InvertedCard>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-medium text-void/50">
          #{String(item.rank).padStart(2, "0")}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-void/70">
          {item.tier} · {TIER_LABEL[item.tier]}
        </span>
      </div>

      <div className="display mt-2 text-heading">
        {item.label ?? trackable?.title ?? `Item ${item.rank}`}
      </div>

      {alloc && (
        <div className="mt-1.5 text-body-sm text-void/70">
          Today: {num(alloc.per_day)} {alloc.unit}
          {alloc.capped && <span className="font-medium text-void"> · capped</span>}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={start}
          disabled={pending !== null || sessionOpen}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-void px-5 text-body-sm font-medium text-pure transition duration-200 ease-out hover:opacity-90 disabled:opacity-40"
        >
          {pending === "start" ? "Starting…" : "Start"}
          <span aria-hidden="true">→</span>
        </button>
        <ActionGroup item={item} pending={pending} act={act} inverted />
      </div>

      {sessionOpen && (
        <div className="mt-3 text-[13px] text-void/60">
          Finish the session you have running first.
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-4 text-[13px] text-void/60 underline underline-offset-4 hover:text-void"
      >
        {open ? "Hide Reasoning" : "Why This?"}
      </button>

      {open && <Breakdown item={item} />}
    </InvertedCard>
  );
}

/** Ranks 2..n: one quiet line each, expanding on demand. The lead card carries
    the weight, so everything below it recedes to a scannable texture. */
function QueueRow({
  item,
  trackables,
  onChanged,
  sessionOpen,
  onError,
}: {
  item: PlanItem;
  trackables: TrackableView[];
  onChanged: () => void;
  sessionOpen: boolean;
  onError: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { pending, act, start } = usePlanItemActions(item, onChanged, onError);
  const trackable = trackables.find((t) => t.trackable_id === item.trackable_id);
  const alloc = item.score_breakdown.daily_allocation;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition duration-200 ease-out hover:bg-raised"
      >
        <span className="font-mono text-[11px] text-faint">
          {String(item.rank).padStart(2, "0")}
        </span>
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${TIER_DOT[item.tier]}`}
        />
        <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
          {item.label ?? trackable?.title ?? `Item ${item.rank}`}
        </span>
        {alloc && (
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {num(alloc.per_day)} {alloc.unit}
          </span>
        )}
        {item.user_action && <Tag>{item.user_action}</Tag>}
        <span
          aria-hidden="true"
          className={`shrink-0 text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>

      {open && (
        <div className="space-y-4 px-5 pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={start} pending={pending === "start"} disabled={sessionOpen}>
              Start
            </Button>
            <ActionGroup item={item} pending={pending} act={act} />
          </div>
          <div>
            <Tag tone={TIER_TONE[item.tier]}>
              {item.tier} · {TIER_LABEL[item.tier]}
            </Tag>
          </div>
          <Breakdown item={item} />
        </div>
      )}
    </div>
  );
}

/**
 * P3: the score decomposed into the components that produced it.
 *
 * Widths are scaled against the largest term in THIS item rather than against
 * an absolute constant. Several components are legitimately zero — an item with
 * no deadline earns no urgency — and on a fixed scale those render as empty
 * full-width tracks that read as *full* bars. Relative scaling makes the
 * dominant term obvious and an absent one unmistakably absent.
 */
function Breakdown({ item }: { item: PlanItem }) {
  const components = item.score_breakdown.components;
  const peak = Math.max(...components.map((c) => Math.abs(c.contribution)), 1e-9);

  /* Always dark, even inside the Silver lead card. The series colours are
     design.md's data-signal set and they are drawn for a dark ground -- pale
     iris on #cacaca is very nearly invisible. A dark well inside the light card
     also keeps the breakdown reading as an instrument panel rather than as more
     of the card. */
  const dim = "text-faint";
  const mid = "text-muted";
  const strong = "text-ink";
  const track = "bg-raised";

  return (
    <div className="mt-4 space-y-2.5 rounded-card bg-abyss p-4">
      {components.map((c, i) => {
        const share = Math.abs(c.contribution) / peak;
        const zero = Math.abs(c.contribution) < 1e-9;
        return (
          <div key={c.name} className="flex items-center gap-3">
            <span
              className={`w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] ${zero ? dim : mid}`}
            >
              {c.name.replace(/_/g, " ")}
            </span>
            <div className={`h-1.5 flex-1 overflow-hidden rounded-full ${track}`}>
              {!zero && (
                <div
                  className="h-1.5 rounded-full"
                  style={{
                    width: `${Math.max(share * 100, 3)}%`,
                    background:
                      c.contribution < 0 ? "var(--color-bad)" : `var(--series-${(i % 6) + 1})`,
                  }}
                />
              )}
            </div>
            <span
              className={`w-14 shrink-0 text-right font-mono text-[11px] ${
                zero ? dim : c.contribution < 0 ? "text-bad" : strong
              }`}
            >
              {c.contribution >= 0 ? "+" : ""}
              {c.contribution.toFixed(3)}
            </span>
          </div>
        );
      })}

      <div className={`flex justify-between border-t border-line pt-2.5 font-mono text-[11px] ${strong}`}>
        <span className="uppercase tracking-[0.12em]">Score</span>
        <span>{item.score.toFixed(4)}</span>
      </div>
      <p className={`text-[11px] leading-relaxed ${dim}`}>
        Scored once for the week and reused today — logging a session does not reshuffle this list.
      </p>
    </div>
  );
}
