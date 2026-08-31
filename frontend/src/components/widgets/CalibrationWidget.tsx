import { Gate, Rows } from "./shared";
import { num, titleCase } from "../../lib/format";
import { chart, toneColor } from "../../lib/chartTheme";
import type { WidgetProps } from "./types";

/**
 * How close expectation lands to reality, per kind of work.
 *
 * §24.5 requires the timed and retroactive distributions to be exposed
 * separately, and D13 explains why: a timed session holds a measured number,
 * a reconstructed one holds a remembered number that tends to be anchored to
 * the prediction. The 0.5 weight applied to retroactive sessions is a
 * placeholder the document expects to be replaced by a measured value — which
 * is impossible if the two are ever shown folded together.
 */
export function CalibrationWidget({ data }: WidgetProps) {
  return (
    <Gate
      value={
        data.calibration === undefined
          ? undefined
          : data.calibration === null
            ? null
            : Object.entries(data.calibration.by_task_type)
      }
      empty="Nothing to Calibrate Yet"
      emptyHint="Calibration needs sessions with both an expected and an actual output."
    >
      {(entries) => (
        <Rows>
          {entries.map(([taskType, report]) => {
            const ratio = report.median_ratio;
            // 1.0 is perfect calibration. Both directions are informative:
            // consistently over-delivering means the estimates are too timid.
            const off = ratio === null ? null : Math.abs(ratio - 1);
            const tone = off === null ? "neutral" : off < 0.15 ? "good" : off < 0.4 ? "warn" : "bad";
            return (
              <div key={taskType} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-body-sm text-ink">{titleCase(taskType)}</span>
                  <span
                    className="shrink-0 font-mono text-footnote tabular-nums"
                    style={{ color: toneColor[tone] }}
                  >
                    {ratio === null ? "—" : `${num(ratio, 2)}×`}
                  </span>
                </div>

                <div className="relative h-3">
                  <span
                    className="absolute inset-y-0 left-1/2 w-px"
                    style={{ background: chart.line() }}
                    aria-hidden="true"
                  />
                  {report.timed_ratios.map((r, i) => (
                    <Dot key={`t${i}`} ratio={r} color={chart.ink()} />
                  ))}
                  {report.retroactive_ratios.map((r, i) => (
                    <Dot key={`r${i}`} ratio={r} color={chart.faint()} />
                  ))}
                </div>

                <div className="font-mono text-micro uppercase tracking-label text-faint">
                  {report.n_timed} Timed · {report.n_retroactive} Retroactive
                </div>
              </div>
            );
          })}
        </Rows>
      )}
    </Gate>
  );
}

/** A ratio placed on a 0–2 axis with 1.0 dead centre. */
function Dot({ ratio, color }: { ratio: number; color: string }) {
  const pos = Math.max(0, Math.min(ratio / 2, 1)) * 100;
  return (
    <span
      className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{ left: `${pos}%`, background: color, opacity: 0.8 }}
      title={`${ratio.toFixed(2)}× expected`}
    />
  );
}
