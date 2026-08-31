import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { GoalGraph } from "../components/GoalGraph";
import { PresenceOrb, type OrbState } from "../components/PresenceOrb";
import { Mark } from "../components/Icons";
import { Banner, Button, Card, SectionLabel } from "../components/Primitives";
import { type Cluster, type Focus, type GraphNode } from "../lib/graphLayout";
import { UNASSIGNED_COLOR } from "../lib/areas";
import { goalTiming } from "../lib/format";

/**
 * The front door: a conversation that compiles intent into a goal graph.
 *
 * §2.1 says the expensive part is compilation -- turning "get a quant offer"
 * into something executable -- and that people avoid it precisely because it is
 * expensive. Making the user do it through forms front-loads the exact work the
 * system exists to absorb.
 *
 * So this screen is the whole screen. A new account has no tabs worth showing
 * and no rail worth navigating, and the app it would advertise does not exist
 * yet. What exists is the conversation, and the graph being built out of it:
 * the map takes the top half, the transcript the bottom, and the composer the
 * full width of the bottom edge.
 *
 * Voice seam: everything routes through submit(text). A microphone calls the
 * same function a keypress does, and the orb already takes a level. Adding
 * voice means adding an input, not rewiring this view.
 */

interface ProposedTrackable {
  key: string; title: string; unit: string; total_units: number;
  total_units_source: string; task_type: string; prior_pace: number | null;
  target_date: string | null;
}
interface ProposedMilestone {
  key: string; title: string; definition_of_done: string; dod_source: string;
  deadline: string | null; exploratory: boolean; planned_sessions: number | null;
  trackables: ProposedTrackable[];
}
interface ProposedGoal {
  key: string; title: string; kind: string; definition_of_done: string;
  dod_source: string; deadline: string | null; activation: string;
  pace_mode: string; reset_period_days: number | null; stakes: number;
  milestones: ProposedMilestone[];
}
interface Proposal {
  goals: ProposedGoal[];
  gaps: { key: string; question: string; priority: number; subject: string }[];
  notes: string;
}
interface TurnResponse {
  reply: string;
  proposal: Proposal;
  interview_complete: boolean;
  remaining_questions: { key: string; question: string; priority: number }[];
  history: { role: string; content: string }[];
}

const DRAFT_KEY = "optimus.intake.draft";

/**
 * The proposal as the graph draws it.
 *
 * Every metric is null and stays null: nothing has been saved, so nothing has
 * been observed, and a zero here would read as "no progress" rather than "no
 * data" (P2). Areas do not exist during intake either, so the whole proposal is
 * one uncoloured region -- colour is what names a territory, and there are no
 * territories yet.
 */
function toClusters(p: Proposal): Cluster[] {
  const goals: GraphNode[] = p.goals.map((g) => ({
    key: g.key,
    kind: "goal",
    title: g.title,
    subtitle: goalTiming(g),
    health: null,
    paceRatio: null,
    sessions: null,
    flags: {
      estimated: g.dod_source === "model_estimated",
      parked: g.activation !== "active",
    },
    children: g.milestones.map((m) => ({
      key: m.key,
      kind: "milestone" as const,
      title: m.title,
      subtitle: m.exploratory
        ? `${m.planned_sessions ?? "?"} sessions budgeted`
        : m.definition_of_done,
      health: null,
      paceRatio: null,
      sessions: null,
      flags: { estimated: m.dod_source === "model_estimated", exploratory: m.exploratory },
      children: m.trackables.map((t) => ({
        key: t.key,
        kind: "trackable" as const,
        title: t.title,
        subtitle: `${t.total_units} ${t.unit}`,
        health: null,
        paceRatio: null,
        sessions: null,
        flags: { estimated: t.total_units_source === "model_estimated" },
        children: [],
      })),
    })),
  }));

  if (goals.length === 0) return [];
  return [{ areaId: null, name: "Your Goals", color: UNASSIGNED_COLOR, goals }];
}

function allKeys(clusters: Cluster[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: GraphNode) => {
    out.add(n.key);
    n.children.forEach(walk);
  };
  clusters.forEach((c) => c.goals.forEach(walk));
  return out;
}

export function Intake({
  onApproved,
  onAccount,
}: {
  onApproved: () => void;
  onAccount?: () => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<{ role: string; content: string }[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [questions, setQuestions] = useState<TurnResponse["remaining_questions"]>([]);
  const [complete, setComplete] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<Focus>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ available: boolean }>("/api/intake/status")
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false));

    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        const d = JSON.parse(saved);
        setTurns(d.turns ?? []);
        setProposal(d.proposal ?? null);
        setQuestions(d.questions ?? []);
        setComplete(d.complete ?? false);
      } catch {
        localStorage.removeItem(DRAFT_KEY);
      }
    }
  }, []);

  const hasProposal = (proposal?.goals.length ?? 0) > 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
    // hasProposal is in here because the strip appearing between the transcript
    // and the composer shortens the scroller under the message just added.
  }, [turns.length, busy, hasProposal]);

  const clusters = useMemo(() => (proposal ? toClusters(proposal) : []), [proposal]);
  // Derived, not counted: a restored draft has to report the same number the
  // session that wrote it did, and the transcript already knows.
  const asked = turns.filter((t) => t.role === "assistant").length;

  /** The one entry point. A microphone will call exactly this. */
  async function submit(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    setBusy(true);
    setError(null);
    setDraft("");
    setTurns((t) => [...t, { role: "user", content: message }]);

    try {
      const res = await api.post<TurnResponse>("/api/intake/turn", {
        message,
        history: turns,
        proposal,
      });

      // Diff on key so only genuinely new nodes ring. Without stable keys every
      // node would look new each turn and the whole graph would strobe.
      const before = allKeys(clusters);
      const after = toClusters(res.proposal);
      setFresh(new Set([...allKeys(after)].filter((k) => !before.has(k))));

      setTurns(res.history);
      setProposal(res.proposal);
      setQuestions(res.remaining_questions);
      setComplete(res.interview_complete);

      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          turns: res.history,
          proposal: res.proposal,
          questions: res.remaining_questions,
          complete: res.interview_complete,
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setTurns((t) => t.slice(0, -1)); // put the message back rather than lose it
      setDraft(message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/intake/approve", { proposal });
      localStorage.removeItem(DRAFT_KEY);
      onApproved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (available === false) {
    return (
      <div className="flex h-dvh items-center justify-center px-5">
        <Card className="max-w-md">
          <SectionLabel>Intake Is Offline</SectionLabel>
          <div className="display mt-2 text-subheading">No Model Key Configured</div>
          <p className="mt-2 text-caption leading-relaxed text-muted">
            The interview needs <code className="text-ink">OPTIMUS_GEMINI_API_KEY</code> in{" "}
            <code className="text-ink">.env.local</code>. Until then you can still build your
            goals by hand under <span className="text-ink">Goals &amp; Capacity</span> — the
            interview is a faster path to the same rows, not a different system.
          </p>
        </Card>
      </div>
    );
  }

  const started = turns.length > 0;
  const orbState: OrbState = busy ? "thinking" : started ? "idle" : "listening";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      {/* ------------------------------------------------------------- map */}
      <div className="relative h-1/2 shrink-0 border-b border-line">
        {clusters.length > 0 && (
        <GoalGraph
          clusters={clusters}
          /* Levels, not areas: there are no areas yet, and pace would file
             every dot under no-signal. How the work nests is the only question
             a proposal can honestly answer. */
          mode="hierarchy"
          highlight={fresh}
          /* Half a viewport with a handful of dots in it: fitting the whole
             canvas would shrink the titles past reading. */
          fitTo="nodes"

          focus={focus}
          onFocus={setFocus}
          selectedKey={selected?.key ?? null}
          onSelect={setSelected}
          className="h-full w-full"
        />
        )}

        {/* Deliberately quiet: the conversation below is the hero, and this
            half is a caption for the space the map will occupy. */}
        {clusters.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <Mark className="size-7 text-line" />
            <p className="max-w-sm text-caption leading-relaxed text-faint">
              Here&rsquo;s where your path takes shape. The map draws itself as we talk —
              goals, the milestones under them, then what actually gets counted.
            </p>
          </div>
        )}

        {/* The only affordance on the screen that is not the conversation.
            Someone who registers with a typo still needs a way out. */}
        {onAccount && (
          <button
            onClick={onAccount}
            aria-label="Account"
            className="absolute left-4 top-4 rounded-control p-1.5 text-faint transition hover:text-ink"
          >
            <Mark className="size-[18px]" />
          </button>
        )}
      </div>

      {/* ---------------------------------------------------- conversation */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-10">
          <div className="mx-auto w-full max-w-[820px] space-y-3">
            {!started && (
              <div className="flex flex-col items-center pb-2 pt-6 text-center">
                <PresenceOrb state={orbState} level={0.2} />
                <div className="display mt-5 text-heading">What Are You Trying to Do?</div>
                <p className="mt-3 max-w-md text-caption leading-relaxed text-muted">
                  Everything on your mind — goals, deadlines, half-formed ideas. One pass,
                  no structure needed.
                </p>
              </div>
            )}

            {turns.map((t, i) =>
              t.role === "user" ? (
                <div
                  key={i}
                  className="ml-auto max-w-[85%] rounded-card rounded-br-md bg-raised px-4 py-2.5 text-body-sm text-ink"
                >
                  {t.content}
                </div>
              ) : (
                <div key={i} className="max-w-[90%] text-body-sm leading-relaxed text-ink">
                  {t.content}
                </div>
              ),
            )}
            {busy && <div className="text-body-sm text-faint">Thinking…</div>}
            <div ref={bottom} />
          </div>
        </div>

        {error && (
          <div className="px-4 pb-3 sm:px-6 lg:px-10">
            <div className="mx-auto w-full max-w-[820px]">
              <Banner>{error}</Banner>
            </div>
          </div>
        )}

        {/* Nothing is written until this is pressed, so the line that says so
            sits with the button rather than in a panel of its own. */}
        {hasProposal && (
          <div className="border-t border-line px-4 py-2.5 sm:px-6 lg:px-10">
            <div className="mx-auto flex w-full max-w-[820px] items-center justify-between gap-4">
              <div className="min-w-0 text-caption leading-relaxed text-muted">
                {complete
                  ? "That's enough to work with. Nothing is saved yet."
                  : `Nothing saved yet · ${asked} answered · ${questions.length} worth asking`}
              </div>
              <Button onClick={approve} disabled={busy} className="shrink-0">
                Create These Goals
              </Button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------- composer */}
        <div
          className="border-t border-line px-4 pt-3.5 sm:px-6 lg:px-10"
          /* Not .safe-bottom: that class sets padding-bottom outright and wins
             over a py- utility, which left the box flush against the edge of
             the screen. The inset is added to the padding instead. */
          style={{ paddingBottom: "calc(0.875rem + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto flex w-full max-w-[820px] items-end gap-3">
            <div className="pb-1.5">
              <PresenceOrb state={orbState} level={busy ? 0.75 : 0.2} size={28} />
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit(draft);
                }
              }}
              rows={started ? 1 : 2}
              placeholder={
                /* Short enough to sit on one line in a one-row box at phone
                   width, where a wrapped placeholder gets clipped. */
                started ? "Answer, or correct me" : "Start talking…"
              }
              className="flex-1 resize-none rounded-control border border-line bg-abyss px-3.5 py-3 text-body-sm text-ink outline-none placeholder:text-faint focus:border-muted"
            />
            <Button onClick={() => submit(draft)} disabled={busy || !draft.trim()}>
              {busy ? "…" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
