import { useState } from "react";
import { ApiError, stream } from "../lib/api";
import { Banner, Button, Card, Tag } from "../components/Primitives";
import { Markdown } from "../components/Markdown";

/**
 * §26: read-only chat over structured state.
 *
 * The assistant has no write tools. When it says it cannot change something,
 * that is the truth of the system rather than a refusal (D10).
 */
interface Turn {
  question: string;
  answer: string;
  tools: { name: string }[];
}

type Event =
  | { type: "tool"; name: string }
  | { type: "thinking"; text: string }
  | { type: "token"; text: string }
  | { type: "answer"; answer: string; tool_calls: { name: string }[] }
  | { type: "error"; message: string };

export function Assistant() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tools that have run on the question currently in flight. Shown live, which
  // is both the progress indicator and the sourcing disclosure (P3).
  const [running, setRunning] = useState<string[]>([]);
  // The answer as it arrives, before the terminal event completes the turn.
  const [draft, setDraft] = useState("");
  // The model's own account of what it is working out. Shown only while the
  // answer is still coming, to fill the seconds before the first real word.
  const [thinking, setThinking] = useState("");

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    setRunning([]);
    setDraft("");
    setThinking("");
    try {
      for await (const event of stream<Event>("/api/assistant/stream", { question: q })) {
        if (event.type === "tool") {
          setRunning((r) => [...r, event.name]);
          // Any text streamed before a lookup was the model thinking aloud.
          // The answer comes after the last tool, so clear the preamble.
          setDraft("");
        } else if (event.type === "thinking") {
          setThinking((t) => t + event.text);
        } else if (event.type === "token") {
          // The answer has started; the reasoning that led here has served its
          // purpose and would only compete with it for attention.
          setThinking("");
          setDraft((d) => d + event.text);
        } else if (event.type === "answer") {
          setTurns((t) => [...t, { question: q, answer: event.answer, tools: event.tool_calls }]);
        } else {
          setError(event.message);
        }
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setRunning([]);
      setDraft("");
      setThinking("");
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="text-caption leading-relaxed text-muted">
          Reads your data; cannot change it. There are no write tools in v0 — deadline changes and
          scope cuts stay yours.
        </div>
      </Card>

      {turns.map((turn, i) => (
        <div key={i} className="space-y-2">
          <div className="ml-auto max-w-[85%] rounded-card rounded-br-md bg-raised px-4 py-2.5 text-body-sm text-ink">
            {turn.question}
          </div>
          <Card>
            <div className="text-body-sm leading-relaxed">
              <Markdown>{turn.answer}</Markdown>
            </div>
            {turn.tools.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {/* Show what the answer was actually based on -- an assistant
                    whose sourcing is invisible is one more thing to take on faith. */}
                {turn.tools.map((t, j) => (
                  <Tag key={j}>{t.name}</Tag>
                ))}
              </div>
            )}
          </Card>
        </div>
      ))}

      {busy && (
        <Card>
          {draft ? (
            // Rendered while streaming too. Half-written markdown (an unclosed
            // **, a heading with no text yet) simply renders as the literal
            // characters until the rest arrives, so the text never disappears
            // mid-answer -- it just resolves.
            <div className="text-body-sm leading-relaxed">
              <Markdown>{draft}</Markdown>
            </div>
          ) : thinking ? (
            <div className="whitespace-pre-wrap text-caption leading-relaxed text-muted">
              {thinking}
            </div>
          ) : (
            <div className="text-caption text-muted">
              {running.length === 0 ? "Thinking…" : "Looking things up…"}
            </div>
          )}
          {running.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {running.map((name, i) => (
                <Tag key={i}>{name}</Tag>
              ))}
            </div>
          )}
        </Card>
      )}

      {error && <Banner>{error}</Banner>}

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Why is this first? Am I going to make December?"
          className="min-h-11 flex-1 rounded-control border border-line bg-abyss px-3.5 text-body-sm text-ink outline-none placeholder:text-faint focus:border-muted"
        />
        <Button onClick={ask} disabled={busy || !question.trim()}>
          {busy ? "…" : "Ask"}
        </Button>
      </div>
    </div>
  );
}
