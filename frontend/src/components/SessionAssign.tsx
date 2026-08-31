/**
 * Saying what a running session is for, after it has already started.
 *
 * The counterpart to StartSession, which asks the same question before the
 * clock starts. A session begun as Untracked is attached to nothing, which is a
 * deliberate state and not an error: it shapes no pace and moves no projection
 * until it is assigned, so nothing is corrupted by leaving it that way for
 * twenty-five minutes — or permanently.
 *
 * Assigning while the session is still running also gives it the expectation it
 * would have had at the start (see attach_session), so ending it stays the
 * one-tap confirm §23.2 asks for rather than an empty box.
 */

import { useState } from "react";

import { api, ApiError } from "../lib/api";
import type { TrackableView } from "../lib/types";
import { Banner, Button } from "./Primitives";
import { startable, TrackablePicker } from "./TrackablePicker";

export function SessionAssign({
  sessionId,
  trackables,
  onAssigned,
  onCancel,
}: {
  sessionId: number;
  trackables: TrackableView[];
  onAssigned: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = startable(trackables);

  async function assign(trackableId: number | null) {
    // Untracked is already the state; picking it is just a way out.
    if (trackableId === null) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/sessions/${sessionId}/attach`, { trackable_id: trackableId });
      onAssigned();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner>{error}</Banner>}

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body-sm font-medium">What are you working on?</span>
        <button
          className="shrink-0 text-caption text-faint underline underline-offset-2 hover:text-muted"
          onClick={onCancel}
        >
          Keep Untracked
        </button>
      </div>

      {open.length === 0 ? (
        <p className="text-body-sm text-muted">
          Nothing to attach to yet. Leave it untracked — at the end you can describe
          what you did and the interview will build the goal from it.
        </p>
      ) : (
        /* Picking here assigns immediately: unlike the start panel there is no
           Start button to confirm against, and a second tap to commit a choice
           that is instantly reversible would be ceremony. */
        <TrackablePicker
          trackables={trackables}
          selectedId={null}
          onSelect={assign}
          includeUntracked={false}
          disabled={busy}
        />
      )}

      <Button variant="ghost" className="w-full" onClick={onCancel} arrow={false}>
        Not Now
      </Button>
    </div>
  );
}
