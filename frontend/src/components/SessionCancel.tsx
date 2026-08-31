/**
 * Discarding a session that is still running.
 *
 * Distinct from `interrupted`, and the difference carries the reasoning. An
 * interrupted session HAPPENED — the work is real, it is retained, and it is
 * kept out of pace because it measures the interruption rather than the user
 * (§23.6). A cancelled session contains nothing: the timer was started by
 * mistake, or on the wrong thing.
 *
 * Two taps, not one. Deleting a running timer cannot be undone, and the elapsed
 * time is shown in the confirmation because thirty seconds and forty minutes
 * are very different things to throw away — a bare "are you sure?" makes the
 * user recall that number themselves.
 */

import { useState } from "react";

import { api, ApiError } from "../lib/api";
import { elapsed } from "../lib/format";
import { Banner, Button } from "./Primitives";

export function SessionCancel({
  sessionId,
  startedAt,
  onCancelled,
  onKeep,
}: {
  sessionId: number;
  startedAt: string;
  onCancelled: () => void;
  onKeep: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/sessions/${sessionId}`);
      onCancelled();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner>{error}</Banner>}
      <div className="text-body-sm font-medium">Discard this session?</div>
      <p className="text-caption text-muted">
        {elapsed(startedAt)} elapsed. Nothing will be logged and it will not count
        toward pace — this is for a timer started by mistake. If the work happened
        but went badly, end it and mark it interrupted instead.
      </p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1"
          pending={busy}
          disabled={busy}
          arrow={false}
          onClick={discard}
        >
          Discard
        </Button>
        <Button
          variant="ghost"
          className="flex-1"
          disabled={busy}
          arrow={false}
          onClick={onKeep}
        >
          Keep It
        </Button>
      </div>
    </div>
  );
}
