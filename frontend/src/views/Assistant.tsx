import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { Button, Card, Tag } from "../components/Primitives";

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

export function Assistant() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    try {
      const res = await api.post<{ answer: string; tool_calls: { name: string }[] }>(
        "/api/assistant",
        { question: q },
      );
      setTurns((t) => [...t, { question: q, answer: res.answer, tools: res.tool_calls }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card className="bg-surface">
        <div className="text-xs text-muted">
          Reads your data; cannot change it. There are no write tools in v0 — deadline changes and
          scope cuts stay yours.
        </div>
      </Card>

      {turns.map((turn, i) => (
        <div key={i} className="space-y-2">
          <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-white">
            {turn.question}
          </div>
          <Card>
            <div className="whitespace-pre-wrap text-sm">{turn.answer}</div>
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

      {error && <div className="rounded-xl bg-bad/8 px-3 py-2 text-xs text-bad">{error}</div>}

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Why is this first? Am I going to make December?"
          className="min-h-11 flex-1 rounded-xl border border-line bg-raised px-3 text-sm outline-none focus:border-accent"
        />
        <Button onClick={ask} disabled={busy || !question.trim()}>
          {busy ? "…" : "Ask"}
        </Button>
      </div>
    </div>
  );
}
