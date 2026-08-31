import { useEffect, useRef, useState } from "react";
import type { TrackableView, WorkSession } from "../lib/types";
import { countdown } from "../lib/format";
import { announceComplete, onDesktop } from "../lib/desktop";
import { Button } from "./Primitives";
import { SessionCancel } from "./SessionCancel";
import { SessionEnd } from "./SessionEnd";

/**
 * The session, full screen.
 *
 * Starting work is the one moment in this app that deserves the whole display.
 * Everything else here is a view onto a plan; this is the plan happening, and
 * a 40px strip at the bottom of a dashboard was asking the user to hold that in
 * their head while looking at something else.
 *
 * At zero it does not stop. The notification fires, the count turns around, and
 * the time past the boundary is named and kept -- because a timer you ignore is
 * the clearest signal in the log about which work you actually want to be
 * doing. See end_session for what happens to that number.
 *
 * Nothing here owns the clock. `countdown` re-derives from started_at on every
 * render, so a tab that was throttled or asleep comes back correct rather than
 * however many ticks behind it was.
 */
export function FocusSession({
  session,
  trackable,
  onEnded,
  onCollapse,
  onFloat,
}: {
  session: WorkSession;
  trackable: TrackableView | undefined;
  onEnded: () => void;
  /** Shrink to the docked bar, still inside the app. */
  onCollapse: () => void;
  /** Hand the countdown to the floating pill and get out of the way. */
  onFloat: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const clock = countdown(session.started_at, session.planned_minutes);
  const title = trackable?.title ?? "Session in progress";

  /* Once per session, on the crossing itself. A ref rather than state because
     announcing must not schedule a render -- and because a session reopened
     after the boundary has already passed should not fire an alert about a
     moment that is minutes old. */
  const announced = useRef(false);
  useEffect(() => {
    announced.current = false;
  }, [session.id]);
  useEffect(() => {
    if (announced.current || !clock.overtime) return;
    announced.current = true;
    // Only a fresh crossing is worth an alert; anything older is history.
    if (clock.seconds > -5) announceComplete(title);
  }, [clock.overtime, clock.seconds, title]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-abyss">
      <div className="flex items-center justify-between px-5 py-4 sm:px-8">
        <div className="section-label">
          {clock.overtime ? "Time In Flow State" : "In Session"}
        </div>
        <div className="flex items-center gap-1">
          {/* The default way out, where the shell provides one: the countdown
              leaves with you rather than staying behind in a window you are no
              longer looking at. Absent in a browser tab, which cannot float
              anything above other applications. */}
          {onDesktop() && (
            <button
              onClick={onFloat}
              className="rounded-control px-2 py-1 text-footnote text-ink transition hover:bg-surface"
            >
              Float
            </button>
          )}
          <button
            onClick={onCollapse}
            className="rounded-control px-2 py-1 text-footnote text-faint transition hover:bg-surface hover:text-ink"
          >
            Collapse
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <div
          className={`font-mono text-timer font-medium tabular-nums transition-colors duration-500 ${
            clock.overtime ? "text-iris" : "text-ink"
          }`}
        >
          {clock.text}
        </div>

        <div className="display mt-6 max-w-xl text-heading">{title}</div>

        <div className="mt-3 text-body-sm text-muted">
          {clock.overtime ? (
            /* Named, not apologised for. The countdown ran out and the user
               kept going, which is the thing worth measuring. */
            <>Past your {session.planned_minutes} minutes — this is counting as flow.</>
          ) : (
            <>
              {session.planned_minutes} minutes
              {session.expected_output !== null && (
                <> · expecting {session.expected_output} {trackable?.unit ?? "units"}</>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-5 pb-10 sm:px-8">
        {cancelling ? (
          <SessionCancel
            sessionId={session.id}
            startedAt={session.started_at}
            onCancelled={onEnded}
            onKeep={() => setCancelling(false)}
          />
        ) : !confirming ? (
          <>
            <Button className="w-full" onClick={() => setConfirming(true)}>
              Done
            </Button>
            {/* Well below the primary and unweighted: discarding is the rare
                path, and on the surface you stare at for 25 minutes it should
                not read as an equal option to finishing. */}
            <button
              onClick={() => setCancelling(true)}
              className="mx-auto mt-4 block text-caption text-faint underline underline-offset-2 transition hover:text-muted"
            >
              Cancel this session
            </button>
          </>
        ) : (
          <SessionEnd
            session={session}
            trackable={trackable}
            flowMinutes={Math.max(0, -clock.seconds) / 60}
            onEnded={onEnded}
            onCancel={() => setConfirming(false)}
            tone="bare"
          />
        )}
      </div>
    </div>
  );
}
