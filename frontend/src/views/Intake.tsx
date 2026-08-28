import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { GoalTree, type TreeNode } from "../components/GoalTree";
import { PresenceOrb, type OrbState } from "../components/PresenceOrb";
import { Button, Card, SectionLabel, Tag } from "../components/Primitives";

/**
 * The front door: a conversation that compiles intent into a goal graph.
 *
 * §2.1 says the expensive part is compilation -- turning "get a quant offer"
 * into something executable -- and that people avoid it precisely because it is
 * expensive. Making the user do it through forms front-loads the exact work the
 * system exists to absorb.
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

function toNodes(p: Proposal): TreeNode[] {
  return p.goals.map((g) => ({
    key: g.key,
    kind: "goal",
    title: g.title,
    subtitle: g.deadline ? `by ${g.deadline}` : "no deadline — parked",
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
      flags: { estimated: m.dod_source === "model_estimated", exploratory: m.exploratory },
      children: m.trackables.map((t) => ({
        key: t.key,
        kind: "trackable" as const,
        title: t.title,
        subtitle: `${t.total_units} ${t.unit}`,
        flags: { estimated: t.total_units_source === "model_estimated" },
      })),
    })),
  }));
}

function allKeys(nodes: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode) => {
    out.add(n.key);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export function Intake({ onApproved }: { onApproved: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<{ role: string; content: string }[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [questions, setQuestions] = useState<TurnResponse["remaining_questions"]>([]);
  const [complete, setComplete] = useState(false);
  const [asked, setAsked] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, busy]);

  const nodes = useMemo(() => (proposal ? toNodes(proposal) : []), [proposal]);

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

      // Diff on key so only genuinely new nodes animate. Without stable keys
      // every node would look new each turn and the tree would strobe.
      const before = allKeys(nodes);
      const after = toNodes(res.proposal);
      setFresh(new Set([...allKeys(after)].filter((k) => !before.has(k))));

      setTurns(res.history);
      setProposal(res.proposal);
      setQuestions(res.remaining_questions);
      setComplete(res.interview_complete);
      setAsked((n) => n + 1);

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
      <Card>
        <SectionLabel>Intake is offline</SectionLabel>
        <div className="mt-1.5 text-sm font-semibold">No model key configured</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          The interview needs <code className="text-ink">OPTIMUS_GEMINI_API_KEY</code> in{" "}
          <code className="text-ink">.env.local</code>. Until then you can still build your
          goals by hand under <span className="text-ink">Goals &amp; capacity</span> — the
          interview is a faster path to the same rows, not a different system.
        </p>
      </Card>
    );
  }

  const started = turns.length > 0;
  const orbState: OrbState = busy ? "thinking" : started ? "idle" : "listening";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ------------------------------------------------------ conversation */}
      <div className="flex min-h-[62vh] flex-col">
        <div className="flex items-center gap-4 pb-4">
          <PresenceOrb state={orbState} level={busy ? 0.75 : 0.2} />
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {started ? "Let's get this straight" : "What are you trying to do?"}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">
              {started
                ? complete
                  ? "That's enough to work with. Review the tree, then create it."
                  : `${asked} answered · ${questions.length} worth asking`
                : "Everything on your mind — goals, deadlines, half-formed ideas. One pass, no structure needed."}
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white"
              >
                {t.content}
              </div>
            ) : (
              <div key={i} className="max-w-[90%] text-sm leading-relaxed text-ink">
                {t.content}
              </div>
            ),
          )}
          {busy && <div className="text-sm text-faint">thinking…</div>}
          <div ref={bottom} />
        </div>

        {error && (
          <div className="mt-3 rounded-xl bg-bad/10 px-3 py-2.5 text-xs text-bad">{error}</div>
        )}

        <div className="mt-3 flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(draft);
              }
            }}
            rows={started ? 1 : 4}
            placeholder={
              started ? "Answer, or tell me I've got something wrong" : "Start talking…"
            }
            className="flex-1 resize-none rounded-xl bg-surface px-3.5 py-3 text-sm text-ink outline-none placeholder:text-faint focus:ring-1 focus:ring-accent"
          />
          <Button onClick={() => submit(draft)} disabled={busy || !draft.trim()}>
            {busy ? "…" : "Send"}
          </Button>
        </div>
      </div>

      {/* -------------------------------------------------------- live tree */}
      <div className="flex min-h-[62vh] flex-col gap-3">
        <GoalTree roots={nodes} highlight={fresh} className="flex-1" />

        {proposal && proposal.goals.length > 0 && (
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <SectionLabel>Not saved yet</SectionLabel>
                <div className="mt-1 text-xs leading-relaxed text-muted">
                  Nothing is written until you say so. Anything I guessed is ringed and will
                  come back at review.
                </div>
              </div>
              <Button onClick={approve} disabled={busy} className="shrink-0">
                Create these goals
              </Button>
            </div>
            {!complete && questions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Tag tone="warn">{questions.length} still worth asking</Tag>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
