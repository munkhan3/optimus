import { useCallback, useMemo, useState } from "react";
import {
  putAllocations,
  targetKey,
  type Allocation,
  type AllocationCommitment,
  type Allocations,
  type RoadmapMarker,
} from "../../lib/dashboard";
import { ApiError } from "../../lib/api";
import { Banner, Tag } from "../Primitives";
import { seriesColor } from "../../lib/chartTheme";
import { useNarrow } from "../../lib/useNarrow";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One draggable block = one session. */
interface Block {
  id: string;
  key: string;
  label: string;
  color: string;
  /** null = still in the tray, not yet placed on a day. */
  date: string | null;
}

/**
 * Shape the week by hand: drag session blocks onto days.
 *
 * §25.5 redistributes a week arithmetically. This is the user overriding that
 * result, which D11 says they are entitled to do — so the board writes
 * allocations and the day generator honours them, falling back to the
 * arithmetic on any day left unplaced.
 *
 * Laid out as seven stacked rows rather than seven columns. A week has seven
 * days and a screen is wider than it is tall, so columns gave each day a narrow
 * strip that ran out of room after three blocks; a row gives a day the full
 * width to lay its sessions out in, and the list scrolls if the week is heavy.
 * The right third holds what is NOT yet on a day, which is the question this
 * view exists to answer.
 *
 * What this is not is a calendar. There is no hour grid and no clock time:
 * sessions are fixed-length and their order within a day carries no meaning
 * (§36.1), so a time axis would invent precision the model does not have and
 * make Optimus a second calendar disagreeing with the real one (§7).
 */
export function WeekBoard({
  allocations,
  markers,
  onSaved,
}: {
  allocations: Allocations;
  markers: RoadmapMarker[];
  onSaved: (next: Allocations) => void;
}) {
  const narrow = useNarrow();
  const [blocks, setBlocks] = useState<Block[]>(() => toBlocks(allocations));
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const days = useMemo(() => {
    const start = new Date(`${allocations.week_start}T00:00:00`);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    });
  }, [allocations.week_start]);

  const persist = useCallback(
    async (next: Block[]) => {
      const counts = new Map<string, number>();
      for (const b of next) {
        if (b.date) counts.set(`${b.key}|${b.date}`, (counts.get(`${b.key}|${b.date}`) ?? 0) + 1);
      }
      const payload: Allocation[] = [...counts.entries()].map(([composite, sessions]) => {
        const [key, plan_date] = composite.split("|");
        const id = Number(key.slice(1));
        return {
          trackable_id: key.startsWith("t") ? id : null,
          milestone_id: key.startsWith("m") ? id : null,
          plan_date,
          sessions,
        };
      });
      setSaving(true);
      try {
        onSaved(await putAllocations(allocations.week_start, payload));
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [allocations.week_start, onSaved],
  );

  const move = useCallback(
    (id: string, date: string | null) => {
      setBlocks((current) => {
        const next = current.map((b) => (b.id === id ? { ...b, date } : b));
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const tray = blocks.filter((b) => b.date === null);
  const placed = blocks.length - tray.length;
  const evenDay = blocks.length / 7;

  const dueByDate = new Map<string, RoadmapMarker[]>();
  for (const m of markers) {
    if (days.includes(m.date)) dueByDate.set(m.date, [...(dueByDate.get(m.date) ?? []), m]);
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-3">
      {error && <Banner>{error}</Banner>}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* ------------------------------------------------ days, two thirds */}
        <div className="flex min-h-0 flex-1 flex-col lg:w-2/3">
          <div className="mb-2 flex shrink-0 items-baseline justify-between gap-3">
            <div className="text-body-sm text-muted">
              <span className="font-mono tabular-nums text-ink">
                {placed} / {blocks.length}
              </span>{" "}
              Sessions Placed
              {saving && <span className="ml-2 text-faint">Saving…</span>}
            </div>
            <div className="font-mono text-micro uppercase tracking-label text-faint">
              {allocations.session_minutes}min Each
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {days.map((date, i) => (
              <DayRow
                key={date}
                date={date}
                weekday={WEEKDAYS[i]}
                blocks={blocks.filter((b) => b.date === date)}
                due={dueByDate.get(date) ?? []}
                evenDay={evenDay}
                narrow={narrow}
                onDrop={() => dragging && move(dragging, date)}
                onDragStart={setDragging}
              />
            ))}
          </div>
        </div>

        {/* ------------------------------------------------ status, one third */}
        <aside className="flex min-h-0 flex-col gap-3 lg:w-1/3">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dragging && move(dragging, null)}
            className="flex min-h-[96px] shrink-0 flex-col rounded-card bg-abyss p-3"
          >
            <div className="section-label mb-2 shrink-0">
              Unplaced{narrow && " — Open Wider to Rearrange"}
            </div>
            {tray.length === 0 ? (
              <div className="text-footnote text-faint">
                Every committed session has a day. The daily plan will follow this shape.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1 overflow-y-auto">
                {tray.map((b) => (
                  <BlockChip
                    key={b.id}
                    block={b}
                    draggable={!narrow}
                    onDragStart={() => setDragging(b.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-card bg-surface p-3">
            <div className="section-label mb-2">Committed</div>
            <Summary commitments={allocations.commitments} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function DayRow({
  date,
  weekday,
  blocks,
  due,
  evenDay,
  narrow,
  onDrop,
  onDragStart,
}: {
  date: string;
  weekday: string;
  blocks: Block[];
  due: RoadmapMarker[];
  evenDay: number;
  narrow: boolean;
  onDrop: () => void;
  onDragStart: (id: string) => void;
}) {
  // §25.5's catch-up cap, applied to the shape the user is building.
  const heavy = evenDay > 0 && blocks.length > evenDay * 1.25;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="rounded-card bg-surface p-2.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-micro uppercase tracking-label text-faint">
          {weekday} {date.slice(8)}
        </span>
        <div className="flex items-center gap-2">
          {due.map((m) => (
            <span
              key={m.key}
              title={`${m.title} due`}
              className="truncate rounded-[3px] bg-raised px-1.5 py-0.5 text-micro text-muted"
            >
              ◆ {m.title}
            </span>
          ))}
          <span
            className="font-mono text-micro tabular-nums"
            style={{ color: heavy ? "var(--color-warn)" : "var(--color-muted)" }}
          >
            {blocks.length}
          </span>
        </div>
      </div>

      <div className="mt-1.5 flex min-h-[24px] flex-wrap gap-1">
        {blocks.map((b) => (
          <BlockChip
            key={b.id}
            block={b}
            draggable={!narrow}
            onDragStart={() => onDragStart(b.id)}
          />
        ))}
      </div>

      {heavy && (
        <div className="mt-1.5 text-micro leading-tight text-warn">
          Above the catch-up cap. If the week only fits this way, it does not fit.
        </div>
      )}
    </div>
  );
}

function BlockChip({
  block,
  draggable,
  onDragStart,
}: {
  block: Block;
  draggable: boolean;
  onDragStart: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      title={block.label}
      className={`inline-block max-w-full truncate rounded-[4px] px-1.5 py-1 text-footnote text-ink ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      style={{ background: `color-mix(in oklab, ${block.color} 26%, var(--color-abyss))` }}
    >
      {block.label}
    </div>
  );
}

function Summary({ commitments }: { commitments: AllocationCommitment[] }) {
  if (commitments.length === 0) {
    return (
      <div className="text-body-sm text-muted">
        Nothing committed this week yet. Commit a week in Goals &amp; Capacity first.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {commitments.map((c) => (
        <div key={targetKey(c)} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-body-sm text-muted">{c.label}</span>
          <span className="flex shrink-0 items-center gap-2 font-mono text-footnote tabular-nums text-faint">
            {c.placed_sessions} / {c.committed_sessions}
            {c.placed_sessions !== c.committed_sessions && <Tag tone="warn">Unplaced</Tag>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Expand the stored counts into one draggable block per session. */
function toBlocks(a: Allocations): Block[] {
  const colorFor = new Map(a.commitments.map((c, i) => [targetKey(c), seriesColor(i)]));
  const labelFor = new Map(a.commitments.map((c) => [targetKey(c), c.label ?? "Untitled"]));
  const blocks: Block[] = [];

  for (const c of a.commitments) {
    const key = targetKey(c);
    const placed = a.allocations.filter((x) => targetKey(x) === key);
    for (const row of placed) {
      for (let n = 0; n < row.sessions; n++) {
        blocks.push({
          id: `${key}-${row.plan_date}-${n}`,
          key,
          label: labelFor.get(key)!,
          color: colorFor.get(key)!,
          date: row.plan_date,
        });
      }
    }
    // Anything committed but not yet placed starts in the tray.
    const remaining = c.committed_sessions - c.placed_sessions;
    for (let n = 0; n < remaining; n++) {
      blocks.push({
        id: `${key}-tray-${n}`,
        key,
        label: labelFor.get(key)!,
        color: colorFor.get(key)!,
        date: null,
      });
    }
  }
  return blocks;
}
