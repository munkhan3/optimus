import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { api, ApiError } from "../lib/api";
import type { WorkSession } from "../lib/types";
import { Banner, Button, SectionLabel, TextArea } from "./Primitives";

export function SessionEdit({
  session,
  onSaved,
  onCancel,
}: {
  session: WorkSession;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [started, setStarted] = useState(isoLocal(session.started_at));
  const [ended, setEnded] = useState(session.ended_at ? isoLocal(session.ended_at) : "");
  const [planned, setPlanned] = useState(String(session.planned_minutes));
  const [expected, setExpected] = useState(session.expected_output ?? "");
  const [note, setNote] = useState(session.note ?? "");
  const [enteredRetro, setEnteredRetro] = useState(!!session.entered_retroactively);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    console.log("SessionEdit mounted for", session.id);
    document.addEventListener("keydown", esc);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = previous;
    };
  }, [onCancel]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        started_at: started ? new Date(started).toISOString() : undefined,
        planned_minutes: Number(planned),
        expected_output: expected === "" ? undefined : Number(expected),
        note: note.trim() || undefined,
        entered_retroactively: enteredRetro || undefined,
      };
      if (ended) body.ended_at = new Date(ended).toISOString();
      await api.patch(`/api/sessions/${session.id}`, body);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button aria-label="Close" onClick={onCancel} className="absolute inset-0 cursor-default bg-void/75 backdrop-blur-sm" />

      <div className="relative flex max-h-[85dvh] w-[min(28rem,100%)] flex-col rounded-card border border-line bg-surface shadow-2xl p-5">
        {error && (
          <div className="mb-3">
            <Banner>{error}</Banner>
          </div>
        )}

        <SectionLabel>Edit Session</SectionLabel>

        <div className="mt-3 space-y-3">
          <label className="block text-body-sm text-muted">
            Started
            <input type="datetime-local" value={started} onChange={(e) => setStarted(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-abyss px-3 text-body-sm text-ink" />
          </label>

          <label className="block text-body-sm text-muted">
            Ended
            <input type="datetime-local" value={ended} onChange={(e) => setEnded(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-abyss px-3 text-body-sm text-ink" />
          </label>

          <label className="block text-body-sm text-muted">
            Planned minutes
            <input type="number" value={planned} onChange={(e) => setPlanned(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-abyss px-3 text-body-sm text-ink" />
          </label>

          <label className="block text-body-sm text-muted">
            Expected output
            <input type="number" value={String(expected)} onChange={(e) => setExpected(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-abyss px-3 text-body-sm text-ink" />
          </label>

          <label className="block text-body-sm text-muted">
            Note
            <TextArea value={note} onChange={setNote} rows={3} />
          </label>

          <label className="flex items-center gap-2 text-caption text-muted">
            <input type="checkbox" checked={enteredRetro} onChange={(e) => setEnteredRetro(e.target.checked)} className="size-4 accent-[var(--color-iris)]" />
            Entered retroactively
          </label>
        </div>

        <div className="mt-4 flex gap-2">
          <Button className="flex-1" pending={busy} disabled={busy} onClick={save}>Save</Button>
          <Button variant="ghost" className="flex-1" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function isoLocal(iso: string) {
  try {
    const d = new Date(iso);
    // yyyy-mm-ddThh:mm
    return d.toISOString().slice(0, 16);
  } catch {
    return "";
  }
}
