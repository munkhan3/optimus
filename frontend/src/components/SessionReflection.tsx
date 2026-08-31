/**
 * What happened in a session the numbers found unusual.
 *
 * This appears AFTER the session is already saved. §23 gives ending a hard
 * one-tap budget, so the question cannot be asked before the log is written —
 * and it should not be, because until the count exists there is nothing to be
 * unusual about.
 *
 * The distinction it exists to draw: a page count can collapse because the work
 * was hard to get through, or because those pages held problems. The first is a
 * dip; the second is a dense session and not a problem at all. The engine
 * decides which from the fitted cost of each unit, and says so here rather than
 * leaving the user to guess from a red number.
 */

import { useState } from "react";

import { api, ApiError } from "../lib/api";
import { num } from "../lib/format";
import type { SessionInsight, SessionProductivity } from "../lib/types";
import { Markdown } from "./Markdown";
import { Banner, Button, Tag, TextArea } from "./Primitives";

export function SessionReflection({
  sessionId,
  productivity,
  unit,
  secondaryUnit,
  tone = "dark",
  onDone,
}: {
  sessionId: number;
  productivity: SessionProductivity;
  unit: string;
  secondaryUnit: string | null;
  tone?: "dark" | "bare";
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [insight, setInsight] = useState<SessionInsight | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const dense = productivity.explained_by_density;

  async function run(key: string, fn: () => Promise<unknown>) {
    setPending(key);
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const analyze = () =>
    run("analyze", async () => {
      // Saved first, so the note survives even if the model call fails.
      await api.patch(`/api/sessions/${sessionId}/reflection`, { note: note.trim() });
      const result = await api.post<{ insight: SessionInsight }>(
        `/api/sessions/${sessionId}/analyze`,
      );
      setInsight(result.insight);
    });

  const saveOnly = () =>
    run("save", async () => {
      await api.patch(`/api/sessions/${sessionId}/reflection`, { note: note.trim() });
      onDone();
    });

  // Nothing the model read is stored until this runs. That is what keeps an
  // inferred number out of the fit that ranks this work against everything else.
  const confirmCount = () =>
    run("confirm", async () => {
      await api.patch(`/api/sessions/${sessionId}/reflection`, {
        secondary_output: insight?.extracted_secondary_output,
        secondary_unit: insight?.extracted_secondary_unit ?? undefined,
      });
      setConfirmed(true);
    });

  return (
    <div className="space-y-3">
      {error && <Banner>{error}</Banner>}

      <div className="text-body-sm font-medium">
        {dense
          ? "That was a dense session, not a slow one."
          : `Well below your usual ${unit} for the time spent.`}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {dense && <Tag tone="good">Explained By Density</Tag>}
        {productivity.productivity_index !== null && (
          <Tag>{num(productivity.productivity_index, 2)}× work index</Tag>
        )}
        {productivity.density_factor !== null && (
          <Tag>{num(productivity.density_factor, 1)}× denser</Tag>
        )}
      </div>

      {!insight && (
        <>
          <TextArea
            value={note}
            onChange={setNote}
            tone={tone}
            rows={3}
            autoFocus
            placeholder={
              dense
                ? `Anything worth recording? Mentioning a count — "finished 8 problems" — teaches the ${secondaryUnit ?? "second"} measure.`
                : "Were you stuck on something? What made this one slow?"
            }
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              pending={pending === "analyze"}
              disabled={busy || !note.trim()}
              onClick={analyze}
            >
              Analyze
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              pending={pending === "save"}
              disabled={busy}
              arrow={false}
              onClick={note.trim() ? saveOnly : onDone}
            >
              {note.trim() ? "Just Save" : "Skip"}
            </Button>
          </div>
        </>
      )}

      {insight && (
        <>
          <div className="rounded-control border border-line bg-abyss px-3.5 py-3">
            <Markdown>{`${insight.observation}\n\n${insight.likely_cause}`}</Markdown>
          </div>

          {/* D10/D11: the model proposes, the user decides. This count is not
              stored until it is confirmed here. */}
          {insight.extracted_secondary_output !== null && !confirmed && (
            <div className="rounded-control border border-line bg-abyss px-3.5 py-3">
              <div className="text-body-sm text-ink">
                Record {insight.extracted_secondary_output}{" "}
                {insight.extracted_secondary_unit ?? "items"} for this session?
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Tag tone={insight.extraction_confidence === "explicit" ? "neutral" : "warn"}>
                  {insight.extraction_confidence === "explicit"
                    ? "You said so"
                    : "Inferred — check it"}
                </Tag>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  className="flex-1"
                  pending={pending === "confirm"}
                  disabled={busy}
                  arrow={false}
                  onClick={confirmCount}
                >
                  Record It
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => setConfirmed(true)}
                >
                  No
                </Button>
              </div>
            </div>
          )}

          {insight.metric_switch_worth_reviewing && (
            <div className="text-caption text-faint">
              Worth a look in the weekly review: {unit} may be the wrong measure
              for this work. The system will only propose switching once the
              other count is measurably steadier.
            </div>
          )}

          <Button className="w-full" onClick={onDone} disabled={busy}>
            Done
          </Button>
        </>
      )}
    </div>
  );
}
