import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api, ApiError } from "../lib/api";
import type { TrackableView, WorkSession } from "../lib/types";
import { DASH, elapsed } from "../lib/format";
import { Banner, Button, Tag } from "./Primitives";
import { MOBILE_NAV_H } from "./Shell";

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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

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

  async function end(payload: Record<string, unknown>, which = "end") {
    setPending(which);
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/sessions/${session.id}/end`, payload);
      onEnded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div
      className="fixed inset-x-0 bottom-[var(--dock)] z-40 border-t border-line bg-surface/95 backdrop-blur lg:bottom-0"
      /* Docks ABOVE the tab bar. Before this it sat on top of it at a higher
         z-index, so starting a session made the app unnavigable on a phone --
         at exactly the moment the app is most likely to be on a phone. */
      style={{ "--dock": `calc(${MOBILE_NAV_H}px + env(safe-area-inset-bottom))` } as CSSProperties}
    >
      <div className="mx-auto max-w-3xl px-4 py-3 sm:px-6 lg:pl-[264px]">
        {error && (
          <div className="mb-3">
            <Banner>{error}</Banner>
          </div>
        )}

        {!confirming ? (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {trackable?.title ?? "Session in progress"}
              </div>
              <div className="text-xs text-faint">
                <span className="font-mono text-ink">{elapsed(session.started_at)}</span>
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
                pending={pending === "yes"}
                disabled={busy}
                arrow={false}
                onClick={() => end({ intent_met: true, interrupted }, "yes")}
              >
                Yes
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                pending={pending === "no"}
                disabled={busy}
                onClick={() => end({ intent_met: false, interrupted }, "no")}
              >
                No
              </Button>
            </div>
            <button
              className="text-xs text-faint underline underline-offset-2 hover:text-muted"
              onClick={() => setConfirming(false)}
            >
              Keep Working
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
                className="mt-2 w-full rounded-control border border-line bg-abyss px-3 py-3 text-subheading font-medium text-ink outline-none focus:border-muted"
              />
            </label>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={interrupted}
                  onChange={(e) => setInterrupted(e.target.checked)}
                  className="size-4 accent-[var(--color-iris)]"
                />
                Interrupted
                <Tag>Excluded From Pace</Tag>
              </label>
              <button
                className="text-xs text-faint underline underline-offset-2 hover:text-muted"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
            <Button
              className="w-full"
              pending={busy}
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
