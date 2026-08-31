import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { TrackableView, WorkSession } from "../lib/types";
import { countdown } from "../lib/format";
import { onDesktop } from "../lib/desktop";
import { Button } from "./Primitives";
import { SessionAssign } from "./SessionAssign";
import { SessionCancel } from "./SessionCancel";
import { SessionEnd } from "./SessionEnd";
import { SessionEdit } from "./SessionEdit";
import { MOBILE_NAV_H } from "./Shell";

/**
 * The running-session bar: the collapsed form of the countdown.
 *
 * FocusSession takes the whole screen, which is right at the moment you start
 * and wrong the moment you need to look something up -- so this is what it
 * collapses to, and the app stays navigable underneath. It docks ABOVE the tab
 * bar; sitting on top of it made the app unusable on a phone at exactly the
 * moment the app is most likely to be on one.
 *
 * Timer state lives in the open work_session row on the server, not here. Close
 * the tab, switch to the phone, come back tomorrow -- the session is still
 * there. If losing the tab lost the session, the honest response would be to
 * stop trusting the log, and every derived number depends on that log.
 */
export function SessionBar({
  session,
  trackable,
  trackables,
  onEnded,
  onChanged,
  onExpand,
  onFloat,
}: {
  session: WorkSession;
  trackable: TrackableView | undefined;
  /** Everything a still-running untagged session could be assigned to. */
  trackables: TrackableView[];
  onEnded: () => void;
  onChanged: () => void;
  onExpand: () => void;
  onFloat: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const clock = countdown(session.started_at, session.planned_minutes);
  // Started from the floating button and not yet said to be for anything.
  const untagged = session.trackable_id === null && session.milestone_id === null;

  return (
    <div
      className="fixed inset-x-0 bottom-[var(--dock)] z-40 border-t border-line bg-surface/95 backdrop-blur lg:bottom-0"
      style={{ "--dock": `calc(${MOBILE_NAV_H}px + env(safe-area-inset-bottom))` } as CSSProperties}
    >
      <div className="mx-auto max-w-3xl px-4 py-3 sm:px-6 lg:pl-[264px]">
        {cancelling ? (
          <SessionCancel
            sessionId={session.id}
            startedAt={session.started_at}
            onCancelled={onEnded}
            onKeep={() => setCancelling(false)}
          />
        ) : assigning ? (
          <SessionAssign
            sessionId={session.id}
            trackables={trackables}
            onAssigned={() => {
              setAssigning(false);
              onChanged();
            }}
            onCancel={() => setAssigning(false)}
          />
        ) : !confirming ? (
          <div className="flex items-center gap-3">
            <button
              onClick={onExpand}
              className="min-w-0 flex-1 text-left"
              aria-label="Expand the session"
            >
              <div className="truncate text-body-sm font-semibold">
                {trackable?.title ?? (untagged ? "Untracked session" : "Session in progress")}
              </div>
              <div className="text-caption text-faint">
                <span
                  className={`font-mono ${clock.overtime ? "text-iris" : "text-ink"}`}
                >
                  {clock.text}
                </span>
                {clock.overtime ? (
                  <> · in flow</>
                ) : (
                  <>
                    {" left of "}
                    {session.planned_minutes}m
                  </>
                )}
              </div>
            </button>
            {/* Offered only while it is still unassigned: saying what a session
                is for is a one-time act, and after that the title says it. */}
            {untagged && (
              <button
                onClick={() => setAssigning(true)}
                className="shrink-0 rounded-control px-2 py-1 text-footnote text-iris transition hover:bg-raised"
              >
                Assign
              </button>
            )}
            <button
              onClick={() => setCancelling(true)}
              className="shrink-0 rounded-control px-2 py-1 text-footnote text-faint transition hover:bg-raised hover:text-bad"
            >
              Cancel
            </button>
            {onDesktop() && (
              <button
                onClick={onFloat}
                className="shrink-0 rounded-control px-2 py-1 text-footnote text-faint transition hover:bg-raised hover:text-ink"
              >
                Float
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="shrink-0 rounded-control px-2 py-1 text-footnote text-faint transition hover:bg-raised hover:text-ink"
            >
              Edit
            </button>
            <Button onClick={() => setConfirming(true)}>Done</Button>
          </div>
        ) : (
          <SessionEnd
            session={session}
            trackable={trackable}
            flowMinutes={Math.max(0, -clock.seconds) / 60}
            onEnded={onEnded}
            onCancel={() => setConfirming(false)}
          />
        )}
        {editing && (
          <SessionEdit
            session={session}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}
