import { Gate, Rows } from "./shared";
import { num, titleCase } from "../../lib/format";
import { seriesColor } from "../../lib/chartTheme";
import type { SessionDistribution } from "../../lib/dashboard";
import type { WidgetProps } from "./types";

/**
 * How much actually comes out of one focus session, by kind of work.
 *
 * Sessions are fixed-length (§36.1), so units-per-session already IS the
 * productivity rate and needs no division by time — which is most of the reason
 * the length was fixed in the first place.
 *
 * Drawn as a box: median with the interquartile range around it, and the full
 * observed span behind. A mean alone would hide the thing worth seeing, which
 * is how wide the spread is. Below five observations the box is labelled
 * provisional, matching the discipline §24.3 applies to the pace interval.
 */
export function OutputPerSession({ data }: WidgetProps) {
  return (
    <Gate
      value={data.throughput === undefined ? undefined : (data.throughput?.per_session ?? null)}
      empty="No Completed Sessions Yet"
      emptyHint="Log a session and its output rate shows up here."
    >
      {(rows: SessionDistribution[]) => {
        const scale = Math.max(...rows.map((r) => r.high ?? 0), 1);
        return (
          <Rows>
            {rows.map((row, i) => (
              <Box key={row.task_type} row={row} scale={scale} color={seriesColor(i)} />
            ))}
          </Rows>
        );
      }}
    </Gate>
  );
}

function Box({
  row,
  scale,
  color,
}: {
  row: SessionDistribution;
  scale: number;
  color: string;
}) {
  const provisional = row.n < 5;
  const at = (v: number | null) => ((v ?? 0) / scale) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-body-sm text-ink">{titleCase(row.task_type)}</span>
        <span className="shrink-0 font-mono text-footnote tabular-nums text-muted">
          {num(row.median)} <span className="text-faint">/ Session</span>
        </span>
      </div>

      <div className="relative h-4">
        {/* Full observed span, kept quiet: it is context, not the reading. */}
        <div
          className="absolute top-1/2 h-px -translate-y-1/2"
          style={{ left: `${at(row.low)}%`, width: `${at(row.high) - at(row.low)}%`, background: "var(--color-line)" }}
        />
        {/* Interquartile range. */}
        <div
          className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px]"
          style={{
            left: `${at(row.p25)}%`,
            width: `${Math.max(at(row.p75) - at(row.p25), 1)}%`,
            background: color,
            opacity: provisional ? 0.35 : 0.75,
          }}
        />
        {/* Median. */}
        <div
          className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink"
          style={{ left: `${at(row.median)}%` }}
        />
      </div>

      <div className="font-mono text-micro uppercase tracking-label text-faint">
        {row.n} Session{row.n === 1 ? "" : "s"} · {row.session_minutes}min
        {provisional && " · Provisional"}
      </div>
    </div>
  );
}
