/**
 * Choosing what a session is for.
 *
 * Shared by the start panel and by assigning a session that is already running,
 * because the two ask the identical question and the interesting part — what
 * each option will prefill at the end — is worth showing in both. Duplicating
 * this list would eventually leave one of them showing a bare title while the
 * other explained itself.
 *
 * "Untracked" is a real option, not a fallback. A session attached to nothing
 * shapes no pace and moves no projection (§24.3), so leaving it that way costs
 * nothing — and at the end its description can build the goal it belonged to.
 */

import { num } from "../lib/format";
import type { TrackableView } from "../lib/types";
import { Tag } from "./Primitives";

/** Done and abandoned work is not something you start a session on. */
export function startable(trackables: TrackableView[]): TrackableView[] {
  return trackables.filter((t) => t.status !== "done" && t.status !== "abandoned");
}

export function TrackablePicker({
  trackables,
  selectedId,
  onSelect,
  includeUntracked = true,
  disabled,
}: {
  trackables: TrackableView[];
  /** null means untracked. */
  selectedId: number | null;
  onSelect: (trackableId: number | null) => void;
  includeUntracked?: boolean;
  disabled?: boolean;
}) {
  const open = startable(trackables);

  return (
    <div className="space-y-0.5">
      {includeUntracked && (
        <Row
          title="Untracked"
          hint="Decide when you finish"
          selected={selectedId === null}
          disabled={disabled}
          onClick={() => onSelect(null)}
        />
      )}

      {open.length === 0 && !includeUntracked && (
        <p className="px-1 py-2 text-body-sm text-muted">Nothing to attach to yet.</p>
      )}

      {open.map((t) => (
        <Row
          key={t.trackable_id}
          title={t.title}
          /* Progress, not pace. Pace pools by task_type (§24.3), so every
             reading trackable reported the identical figure -- accurate, since
             that is what would prefill, but no help at all in telling four rows
             apart. What is left to do is the thing being chosen between. */
          hint={`${num(t.progress.completed_units, 0)} of ${num(
            t.progress.total_units,
            0,
          )} ${t.unit}`}
          tag={t.task_type}
          selected={selectedId === t.trackable_id}
          disabled={disabled}
          onClick={() => onSelect(t.trackable_id)}
        />
      ))}
    </div>
  );
}

function Row({
  title,
  hint,
  tag,
  selected,
  disabled,
  onClick,
}: {
  title: string;
  hint: string;
  tag?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center justify-between gap-2 rounded-control px-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
        selected ? "bg-raised ring-1 ring-iris/40" : "hover:bg-raised/60"
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate text-body-sm text-ink">{title}</span>
        <span className="block truncate text-footnote text-faint">{hint}</span>
      </span>
      {/* No separate selection mark: the row's own background carries it, and a
          dot cost the title 24px of width on rows that were already truncating. */}
      {tag && <span className="shrink-0">{<Tag>{tag}</Tag>}</span>}
    </button>
  );
}
