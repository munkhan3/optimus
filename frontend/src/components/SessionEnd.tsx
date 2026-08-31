import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { SessionProductivity, TrackableView, WorkSession } from "../lib/types";
import { DASH } from "../lib/format";
import { Banner, Button, Tag, TextArea } from "./Primitives";
import { SessionReflection } from "./SessionReflection";
import { SessionToGoal } from "./SessionToGoal";

/**
 * Ending a session.
 *
 * Lifted out of SessionBar so the docked bar and the full-screen countdown ask
 * the identical question. §23 gives this a hard interaction budget -- ONE input
 * for metered work, prefilled from pace_hat, and ONE toggle for exploratory --
 * and a budget that is written down in two places is a budget that drifts.
 *
 * Flow time is passed in rather than derived here: the surface that was showing
 * the countdown is the only thing that knows how long it had been past zero.
 * The server has a fallback for callers that do not know (see end_session), but
 * the fallback counts a session someone walked away from, so anyone who does
 * know should say.
 */
export function SessionEnd({
  session,
  trackable,
  flowMinutes,
  onEnded,
  onCancel,
  tone = "dark",
}: {
  session: WorkSession;
  trackable: TrackableView | undefined;
  flowMinutes?: number;
  onEnded: () => void;
  onCancel: () => void;
  /** "dark" is the docked bar; "bare" drops the surface for the overlay. */
  tone?: "dark" | "bare";
}) {
  /* Prefilled at mount rather than in an effect: this component only exists
     once the user has asked to end, so "when confirming begins" and "when this
     mounts" are the same instant, and an effect would only add a render. */
  const [output, setOutput] = useState<string>(
    session.expected_output !== null ? String(session.expected_output) : "",
  );
  const [interrupted, setInterrupted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [secondary, setSecondary] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  /* Set when the session is already saved and the numbers warrant asking what
     happened. Holding this component mounted is what lets the question be asked
     without ever delaying the log. */
  const [reflecting, setReflecting] = useState<SessionProductivity | null>(null);
  /* An untagged session is inert until it is attached to something. Offering
     that at the end is the only moment the user still has the context to
     describe what they just did. */
  const [naming, setNaming] = useState(false);

  const unit = trackable?.unit ?? "units";
  const isExploratory = trackable?.exploratory ?? session.trackable_id === null;
  const untagged = session.trackable_id === null && session.milestone_id === null;

  async function end(payload: Record<string, unknown>, which = "end") {
    setPending(which);
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ productivity: SessionProductivity | null }>(
        `/api/sessions/${session.id}/end`,
        {
          ...payload,
          ...(flowMinutes !== undefined ? { flow_minutes: flowMinutes } : {}),
        },
      );
      /* The session is saved either way. An unusual one earns a question --
         but only when the user has not already explained it, and only when the
         engine can tell dense from slow. */
      if (result?.productivity?.progress_outlier && !note.trim()) {
        setReflecting(result.productivity);
        return;
      }
      if (untagged) {
        setNaming(true);
        return;
      }
      onEnded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const field =
    tone === "bare"
      ? "border-line bg-transparent"
      : "border-line bg-abyss";

  if (naming) {
    return <SessionToGoal sessionId={session.id} tone={tone} onDone={onEnded} />;
  }

  if (reflecting) {
    return (
      <SessionReflection
        sessionId={session.id}
        productivity={reflecting}
        unit={unit}
        secondaryUnit={trackable?.secondary_unit ?? null}
        tone={tone}
        onDone={onEnded}
      />
    );
  }

  return (
    <div className="space-y-3">
      {error && <Banner>{error}</Banner>}

      {isExploratory ? (
        /* §23.3: an exploratory session ends on one toggle -- intent met.
           There is no count to report, and inventing one would be worse. */
        <>
          <div className="text-body-sm font-medium">Did you do what you set out to do?</div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              pending={pending === "yes"}
              disabled={busy}
              arrow={false}
              onClick={() =>
                end(
                  { intent_met: true, interrupted, ...(note.trim() ? { note: note.trim() } : {}) },
                  "yes",
                )
              }
            >
              Yes
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              pending={pending === "no"}
              disabled={busy}
              onClick={() =>
                end(
                  { intent_met: false, interrupted, ...(note.trim() ? { note: note.trim() } : {}) },
                  "no",
                )
              }
            >
              No
            </Button>
          </div>
          {noteOpen ? (
            <TextArea
              value={note}
              onChange={setNote}
              tone={tone}
              rows={2}
              placeholder="What happened this session?"
            />
          ) : (
            <button
              className="text-caption text-faint underline underline-offset-2 hover:text-muted"
              onClick={() => setNoteOpen(true)}
            >
              Add a note
            </button>
          )}
          <button
            className="text-caption text-faint underline underline-offset-2 hover:text-muted"
            onClick={onCancel}
          >
            Keep Working
          </button>
        </>
      ) : (
        <>
          <label className="block text-body-sm font-medium">
            How many {unit}?
            <input
              type="number"
              inputMode="decimal"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              className={`mt-2 w-full rounded-control border px-3 py-3 text-subheading font-medium text-ink outline-none focus:border-muted ${field}`}
            />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-caption text-muted">
              <input
                type="checkbox"
                checked={interrupted}
                onChange={(e) => setInterrupted(e.target.checked)}
                className="size-4 accent-[var(--color-iris)]"
              />
              Interrupted
              <Tag>Excluded From Pace</Tag>
            </label>
            {/* "Back", not "Cancel": cancelling now means DISCARDING the
                session, and two controls a thumb apart meaning opposite things
                is how a session gets thrown away by accident. */}
            <button
              className="text-caption text-faint underline underline-offset-2 hover:text-muted"
              onClick={onCancel}
            >
              Back
            </button>
          </div>
          {/* The second axis, offered only where this work has one. It measures
              WORK where the primary unit measures progress. */}
          {trackable?.secondary_unit && (
            <label className="block text-body-sm text-muted">
              How many {trackable.secondary_unit}?
              <input
                type="number"
                inputMode="decimal"
                value={secondary}
                placeholder="optional"
                onChange={(e) => setSecondary(e.target.value)}
                className={`mt-1.5 w-full rounded-control border px-3 py-2.5 text-body-sm text-ink outline-none placeholder:text-faint focus:border-muted ${field}`}
              />
            </label>
          )}

          {/* §23 gives ending a hard interaction budget, so the note is one tap
              away rather than in the way. An unusual session asks for it
              afterwards without the user having to think of it. */}
          {noteOpen ? (
            <TextArea
              value={note}
              onChange={setNote}
              tone={tone}
              rows={2}
              autoFocus
              placeholder="What happened this session?"
            />
          ) : (
            <button
              className="text-caption text-faint underline underline-offset-2 hover:text-muted"
              onClick={() => setNoteOpen(true)}
            >
              Add a note
            </button>
          )}

          <Button
            className="w-full"
            pending={busy}
            /* Sending no actual_output means "the expectation was right", so
               confirming the prefill really is one tap (§23.2). */
            onClick={() =>
              end({
                actual_output: output === "" ? undefined : Number(output),
                interrupted,
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(secondary !== "" ? { secondary_output: Number(secondary) } : {}),
              })
            }
          >
            {output === "" || Number(output) === session.expected_output
              ? `Confirm ${session.expected_output ?? DASH} ${unit}`
              : `Log ${output} ${unit}`}
          </Button>
        </>
      )}
    </div>
  );
}
