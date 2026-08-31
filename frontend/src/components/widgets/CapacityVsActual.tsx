import { AxisBottom } from "@visx/axis";
import { Group } from "@visx/group";
import { Bar } from "@visx/shape";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Gate } from "./shared";
import { axisProps, chart } from "../../lib/chartTheme";
import type { CapacityWeek } from "../../lib/dashboard";
import type { WidgetProps } from "./types";

const H = 150;
const MARGIN = { top: 8, right: 4, bottom: 22, left: 4 };

/**
 * Declared capacity, what was committed against it, and what was actually used.
 *
 * §11 makes capacity a declaration rather than an inference, which only means
 * something if the declaration is checked against reality now and then. Three
 * bars per week, because collapsing them to a percentage would hide which of
 * the three moved.
 */
export function CapacityVsActual({ data }: WidgetProps) {
  return (
    <Gate
      value={data.throughput === undefined ? undefined : (data.throughput?.capacity ?? null)}
      empty="No Capacity Declared Yet"
      emptyHint="Declare a week's hours in Goals & Capacity and it appears here."
    >
      {(weeks: CapacityWeek[]) => <Chart weeks={weeks} />}
    </Gate>
  );
}

function Chart({ weeks }: { weeks: CapacityWeek[] }) {
  const width = Math.max(weeks.length * 54, 240);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = H - MARGIN.top - MARGIN.bottom;

  const x = scaleBand<string>({
    domain: weeks.map((w) => w.week_start),
    range: [0, innerW],
    padding: 0.3,
  });
  const y = scaleLinear<number>({
    domain: [
      0,
      Math.max(...weeks.flatMap((w) => [w.declared_sessions, w.committed_sessions, w.used_sessions]), 1),
    ],
    range: [innerH, 0],
    nice: true,
  });
  const bw = x.bandwidth() / 3;

  const series: { key: keyof CapacityWeek; color: string; label: string }[] = [
    { key: "declared_sessions", color: chart.line(), label: "Declared" },
    { key: "committed_sessions", color: chart.iris(), label: "Committed" },
    { key: "used_sessions", color: chart.cyan(), label: "Used" },
  ];

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg width={width} height={H} role="img" aria-label="Declared, committed and used sessions per week">
          <Group left={MARGIN.left} top={MARGIN.top}>
            {weeks.map((w) =>
              series.map((s, i) => {
                const value = w[s.key] as number;
                return (
                  <Bar
                    key={`${w.week_start}-${s.key}`}
                    x={(x(w.week_start) ?? 0) + i * bw}
                    y={y(value)}
                    width={Math.max(bw - 1, 1)}
                    height={Math.max(innerH - y(value), 0)}
                    rx={1.5}
                    fill={s.color}
                  >
                    <title>{`${w.week_start} — ${s.label}: ${value}`}</title>
                  </Bar>
                );
              }),
            )}
            <AxisBottom
              top={innerH}
              scale={x}
              {...axisProps}
              tickFormat={(d) => String(d).slice(5)}
              numTicks={Math.min(weeks.length, 6)}
            />
          </Group>
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-micro uppercase tracking-label text-faint">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
