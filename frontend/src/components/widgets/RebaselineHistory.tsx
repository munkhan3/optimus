import { Gate, Rows } from "./shared";
import { Tag } from "../Primitives";
import { dateShort, num } from "../../lib/format";
import type { RoadmapRow } from "../../lib/dashboard";
import type { WidgetProps } from "./types";

const RESOLUTION_LABEL: Record<string, string> = {
  add_sessions: "Added Sessions",
  cut_scope: "Cut Scope",
  move_deadline: "Moved the Deadline",
  declare_infeasible: "Declared Infeasible",
};

/**
 * What the plan was originally, and what it is now.
 *
 * §25.3 requires version 1 to stay on screen alongside current, always, and
 * §17 says why: "three rebaselines in, the user must be able to see that this
 * began as ten sessions targeting October." Silent deadline extension is how a
 * goal drifts for months without ever formally failing, and this widget is the
 * thing that makes it impossible to do quietly.
 */
export function RebaselineHistory({ data }: WidgetProps) {
  return (
    <Gate value={data.roadmap}>
      {(roadmap) => {
        const rows: { row: RoadmapRow; path: string }[] = [];
        const walk = (nodes: RoadmapRow[], path: string) => {
          for (const node of nodes) {
            if (node.baselines?.original) rows.push({ row: node, path });
            walk(node.children, path ? `${path} · ${node.title}` : node.title);
          }
        };
        walk(roadmap.rows, "");

        if (rows.length === 0) {
          return (
            <div className="text-body-sm text-muted">
              No baselines recorded yet. One is written when work is first planned.
            </div>
          );
        }

        return (
          <Rows>
            {rows.map(({ row, path }) => {
              const original = row.baselines!.original!;
              const current = row.baselines!.current!;
              const moved = current.target_date !== original.target_date;
              return (
                <div key={row.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body-sm text-ink">{row.title}</span>
                    <span className="shrink-0 font-mono text-micro uppercase tracking-label text-faint">
                      v{current.version}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-control bg-abyss p-2 text-footnote">
                    <div>
                      <div className="font-mono text-micro uppercase tracking-label text-faint">
                        Originally
                      </div>
                      <div className="text-muted">
                        {num(original.planned_sessions, 0)} sessions ·{" "}
                        {dateShort(original.target_date)}
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-micro uppercase tracking-label text-faint">
                        Now
                      </div>
                      <div className={moved ? "text-warn" : "text-muted"}>
                        {num(current.planned_sessions, 0)} sessions ·{" "}
                        {dateShort(current.target_date)}
                      </div>
                    </div>
                  </div>
                  {current.resolution && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-faint">
                      <Tag tone={current.resolution === "move_deadline" ? "warn" : "neutral"}>
                        {RESOLUTION_LABEL[current.resolution] ?? current.resolution}
                      </Tag>
                      {current.rationale && <span className="min-w-0">{current.rationale}</span>}
                    </div>
                  )}
                  {path && <div className="truncate text-footnote text-faint">{path}</div>}
                </div>
              );
            })}
          </Rows>
        );
      }}
    </Gate>
  );
}
