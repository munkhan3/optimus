import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./lib/api";
import type { PlanItem, TrackableView, WorkSession } from "./lib/types";
import { SessionBar } from "./components/SessionBar";
import { Button, Card, Field } from "./components/Primitives";
import { Shell, type Tab } from "./components/Shell";
import { Trackables } from "./views/Trackables";
import { Today } from "./views/Today";
import { Plan } from "./views/Plan";
import { Review } from "./views/Review";
import { Assistant } from "./views/Assistant";

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>("today");
  const [trackables, setTrackables] = useState<TrackableView[]>([]);
  const [session, setSession] = useState<WorkSession | null>(null);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [capBinding, setCapBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!authed) return;
    setBusy(true);
    try {
      const [t, s] = await Promise.all([
        api.get<TrackableView[]>("/api/trackables"),
        api.get<WorkSession | null>("/api/sessions/open"),
      ]);
      setTrackables(t);
      setSession(s);
      setError(null);

      // A missing plan is normal (nothing committed yet), not an error.
      try {
        const today = new Date().toISOString().slice(0, 10);
        const day = await api.get<{ items: PlanItem[] }>(`/api/planning/day/${today}`);
        setPlan(day.items);
        setCapBinding(
          day.items.some((i) => i.score_breakdown.daily_allocation?.capped ?? false),
        );
      } catch {
        setPlan([]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [authed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;

  return (
    <>
      <Shell tab={tab} setTab={setTab}>
        {error && (
          <div className="mb-4 rounded-xl bg-bad/10 px-4 py-3 text-xs text-bad">{error}</div>
        )}

        {tab === "today" && (
          <Today
            items={plan}
            trackables={trackables}
            capBinding={capBinding}
            onChanged={refresh}
            onGenerate={refresh}
            busy={busy}
          />
        )}
        {tab === "work" && (
          <Trackables trackables={trackables} onStarted={refresh} busy={busy || !!session} />
        )}
        {tab === "plan" && <Plan trackables={trackables} onChanged={refresh} />}
        {tab === "review" && <Review />}
        {tab === "ask" && <Assistant />}
      </Shell>

      {session && (
        <SessionBar
          session={session}
          trackable={trackables.find((t) => t.trackable_id === session.trackable_id)}
          onEnded={refresh}
        />
      )}
    </>
  );
}

/** §19: one token, pasted once. There is no login because there is one user. */
function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-5">
      <Card className="w-full">
        <div className="text-lg font-semibold tracking-tight">Optimus</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          Paste your access token. Single user, so this is the only credential — it is stored on
          this device.
        </p>
        <Field
          label="Token"
          type="password"
          value={value}
          onChange={setValue}
          placeholder="••••••••"
          className="mt-4"
        />
        <Button
          className="mt-4 w-full"
          disabled={!value.trim()}
          onClick={() => {
            setToken(value);
            onSaved();
          }}
        >
          Continue
        </Button>
      </Card>
    </div>
  );
}
