/**
 * Turning a session you just did into a goal you are tracking.
 *
 * An untagged session is inert: no trackable means no expected output, so it
 * shapes no pace and moves no projection. It stays that way until this runs.
 *
 * Nothing here is new machinery. The description goes to the same parser the
 * intake interview uses, comes back as the same proposal shape, and is written
 * by the same POST /api/intake/approve in one transaction — a description of
 * work just finished is a brain dump with a session attached. What is new is
 * only the last step: attaching the session to what the tree created, so the
 * work that prompted the goal counts toward it.
 *
 * The proposal renders as a nested list rather than the graph the intake screen
 * shows. This surface is a docked bar or a phone-width overlay, where a pan and
 * zoom canvas is not legible; the shape of three nodes reads perfectly well as
 * an indented list.
 */

import { useState } from "react";

import { api, ApiError } from "../lib/api";
import { Banner, Button, SectionLabel, Tag, TextArea } from "./Primitives";

interface ProposedTrackable {
  key: string;
  title: string;
  unit: string;
  total_units: number;
  total_units_source: string;
}
interface ProposedMilestone {
  key: string;
  title: string;
  exploratory: boolean;
  trackables: ProposedTrackable[];
}
interface ProposedGoal {
  key: string;
  title: string;
  deadline: string | null;
  milestones: ProposedMilestone[];
}
interface Proposal {
  goals: ProposedGoal[];
  gaps: { key: string; question: string }[];
  notes: string;
}

interface Created {
  detail: {
    trackables: { key: string; id: number; title: string }[];
    milestones: { key: string; id: number; title: string }[];
  };
}

export function SessionToGoal({
  sessionId,
  tone = "dark",
  onDone,
}: {
  sessionId: number;
  tone?: "dark" | "bare";
  onDone: () => void;
}) {
  const [description, setDescription] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setPending(key);
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const propose = () =>
    run("propose", async () => {
      // Saved first, so the description survives a model failure.
      await api.patch(`/api/sessions/${sessionId}/reflection`, {
        note: description.trim(),
      });
      const result = await api.post<{ proposal: Proposal }>(
        `/api/sessions/${sessionId}/propose-tree`,
      );
      setProposal(result.proposal);
    });

  const approve = () =>
    run("approve", async () => {
      const written = await api.post<Created>("/api/intake/approve", { proposal });
      // Attach to the first trackable the tree produced, falling back to a
      // milestone for work with no honest counter (§10). Both are returned
      // keyed by the proposal's own slugs.
      const trackable = written.detail.trackables[0];
      const milestone = written.detail.milestones[0];
      if (trackable || milestone) {
        await api.post(`/api/sessions/${sessionId}/attach`, {
          trackable_id: trackable?.id ?? null,
          milestone_id: trackable ? null : (milestone?.id ?? null),
        });
      }
      onDone();
    });

  if (proposal) {
    return (
      <div className="space-y-3">
        {error && <Banner>{error}</Banner>}
        <SectionLabel>Proposed</SectionLabel>

        <div className="max-h-56 space-y-3 overflow-y-auto rounded-control border border-line bg-abyss px-3.5 py-3">
          {proposal.goals.map((goal) => (
            <div key={goal.key}>
              <div className="text-body-sm font-medium text-ink">{goal.title}</div>
              {goal.deadline && (
                <div className="mt-0.5 text-footnote text-faint">by {goal.deadline}</div>
              )}
              {goal.milestones.map((m) => (
                <div key={m.key} className="mt-2 border-l border-line pl-3">
                  <div className="text-body-sm text-muted">{m.title}</div>
                  {m.exploratory && (
                    <div className="mt-1">
                      <Tag tone="accent">No Honest Counter</Tag>
                    </div>
                  )}
                  {m.trackables.map((t) => (
                    <div key={t.key} className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-footnote text-faint">
                        {t.title} · {t.total_units} {t.unit}
                      </span>
                      {/* D3: an inferred total is flagged wherever it appears. */}
                      {t.total_units_source === "model_estimated" && (
                        <Tag tone="warn">Estimated</Tag>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>

        {proposal.gaps.length > 0 && (
          <div className="text-footnote text-faint">
            {proposal.gaps.length} question{proposal.gaps.length === 1 ? "" : "s"} saved
            for the weekly review rather than guessed at.
          </div>
        )}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            pending={pending === "approve"}
            disabled={busy}
            onClick={approve}
          >
            Create &amp; Attach
          </Button>
          <Button variant="ghost" className="flex-1" disabled={busy} onClick={onDone}>
            Not Now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <Banner>{error}</Banner>}
      <div className="text-body-sm font-medium">What did you work on?</div>
      <TextArea
        value={description}
        onChange={setDescription}
        tone={tone}
        rows={3}
        autoFocus
        placeholder="What you did, why it matters, and when it needs to be done."
      />
      <div className="flex gap-2">
        <Button
          className="flex-1"
          pending={pending === "propose"}
          disabled={busy || !description.trim()}
          onClick={propose}
        >
          Build a Goal
        </Button>
        <Button
          variant="ghost"
          className="flex-1"
          disabled={busy}
          arrow={false}
          onClick={onDone}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
