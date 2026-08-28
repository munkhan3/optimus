import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackableView, WorkSession } from "../lib/types";
import { DASH, elapsed } from "../lib/format";
import { Button, Tag } from "./Primitives";

/**
 * The running-session bar.
 *
 * §23 gives this a hard interaction budget: ending a metered session takes ONE
 * input, prefilled with the expected value, so confirming is one tap. The
 * prefilled number comes from pace_hat, never a fixed guess (§23.4).
 *
 * Timer state lives in the open work_session row on the server, not here. Close
 * the tab, switch to the phone, come back tomorrow -- the session is still
 * there. If losing the tab lost the session, the honest response would be to
 * stop trusting the log, and every derived number depends on that log.
 */
export function SessionBar({
  session,
  trackable,
  onEnded,
}: {
  session: WorkSession;
  trackable: TrackableView | undefined;
  onEnded: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [output, setOutput] = useState<string>("");
  const [interrupted, setInterrupted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  useEffect(() => {
    if (confirming && output === "") {
      setOutput(session.expected_output !== null ? String(session.expected_output) : "");
    }
  }, [confirming, session.expected_output, output]);

  const unit = trackable?.unit ?? "units";
  const isExploratory = trackable?.exploratory ?? session.trackable_id === null;

  async function end(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      await api.post(`/api/sessions/${session.id}/end`, payload);
      onEnded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-raised/95 backdrop-blur">
      <div className="mx-auto max-w-2xl px-4 py-3">
        {!confirming ? (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {trackable?.title ?? "Session in progress"}
              </div>
              <div className="text-xs text-muted">
                <span className="font-mono">{elapsed(session.started_at)}</span>
                {" / "}
                {session.planned_minutes}m
                {session.expected_output !== null && (
                  <> · expecting {session.expected_output} {unit}</>
                )}
              </div>
            </div>
            <Button onClick={() => setConfirming(true)}>Done</Button>
          </div>
        ) : isExploratory ? (
          /* §23.3: an exploratory session ends on one toggle -- intent met.
             There is no count to report, and inventing one would be worse. */
          <div className="space-y-3">
            <div className="text-sm font-medium">Did you do what you set out to do?</div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy}
                onClick={() => end({ intent_met: true, interrupted })}
              >
                Yes
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                disabled={busy}
                onClick={() => end({ intent_met: false, interrupted })}
              >
                No
              </Button>
            </div>
            <button
              className="text-xs text-muted underline underline-offset-2"
              onClick={() => setConfirming(false)}
            >
              keep working
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm font-medium">
              How many {unit}?
              <input
                type="number"
                inputMode="decimal"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-3 text-lg font-semibold outline-none focus:border-accent"
              />
            </label>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={interrupted}
                  onChange={(e) => setInterrupted(e.target.checked)}
                  className="size-4 accent-[var(--color-accent)]"
                />
                Interrupted
                <Tag>excluded from pace</Tag>
              </label>
              <button
                className="text-xs text-muted underline underline-offset-2"
                onClick={() => setConfirming(false)}
              >
                cancel
              </button>
            </div>
            <Button
              className="w-full"
              disabled={busy}
              /* Sending no actual_output means "the expectation was right", so
                 confirming the prefill really is one tap (§23.2). */
              onClick={() =>
                end({
                  actual_output: output === "" ? undefined : Number(output),
                  interrupted,
                })
              }
            >
              {output === "" || Number(output) === session.expected_output
                ? `Confirm ${session.expected_output ?? DASH} ${unit}`
                : `Log ${output} ${unit}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
