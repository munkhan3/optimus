import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { WorkSession } from "../lib/types";
import { Banner, Button } from "./Primitives";
import { SessionEdit } from "./SessionEdit";

export function SessionHistory({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkSession | null>(null);

  useEffect(() => {
    if (editing) console.log("SessionHistory editing state set", editing.id);
    else console.log("SessionHistory editing cleared");
  }, [editing]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<WorkSession[]>(`/api/sessions`);
      setSessions(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-void/75 backdrop-blur-sm" />
      <div className="relative max-h-[80dvh] w-[min(36rem,100%)] overflow-auto rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="section-label">Session Log</div>
          <div>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>

        {error && <Banner>{error}</Banner>}

        <div className="space-y-2">
                {busy ? (
            <div className="text-body-sm text-faint">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="text-body-sm text-faint">No sessions yet.</div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{s.trackable_id ? `Trackable ${s.trackable_id}` : "Untracked"}</div>
                  <div className="text-caption text-faint">{new Date(s.started_at).toLocaleString()} · {s.planned_minutes}m</div>
                </div>
                  <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => { console.log('SessionHistory edit click', s.id); setEditing(s); }}>Edit</Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {editing && (
        <SessionEdit
          session={editing}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
