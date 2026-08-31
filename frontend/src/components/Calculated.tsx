/**
 * "How this is calculated", rendered from the engine's own decomposition.
 *
 * P3 requires every recommendation to interrogate. The terms come from the
 * metrics engine as data rather than being restated here, so this component
 * cannot drift out of agreement with the code that produced the number -- which
 * is the failure mode a hand-written formula in JSX eventually reaches.
 */

import { DASH, num } from "../lib/format";
import type { Calculation } from "../lib/types";

export function Calculated({ calculation }: { calculation: Calculation }) {
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none font-mono text-micro uppercase tracking-label text-faint hover:text-muted">
        How this is calculated
      </summary>
      <div className="mt-2 rounded-control border border-line bg-abyss px-3 py-2.5">
        <div className="font-mono text-micro text-muted">{calculation.formula}</div>
        <dl className="mt-2 space-y-1">
          {calculation.terms.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="text-body-sm text-faint">{label}</dt>
              {/* P2: an absent term is a dash, never a zero. */}
              <dd className="font-mono text-body-sm text-ink">
                {value == null ? DASH : num(value, 2)}
              </dd>
            </div>
          ))}
        </dl>
        {calculation.note && (
          <p className="mt-2 text-body-sm text-faint">{calculation.note}</p>
        )}
      </div>
    </details>
  );
}
