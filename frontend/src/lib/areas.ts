/** Areas of life: the taxonomy the goal graph is read through. */

export interface Area {
  id: number;
  name: string;
  /** Null means "derive it" — see areaColor. Only set if the user overrides. */
  color: string | null;
  goal_count?: number;
}

/**
 * design.md reserves exactly six chromatic tokens for data signals, and an area
 * is a data signal: it is what the eye groups by. They are already declared as
 * --series-1..6 in index.css, so this reuses those rather than minting a
 * seventh palette that would drift from the system.
 *
 * The index comes from the area's position in id order, never from its name.
 * Keying off the name would repaint the whole map the moment an area is
 * renamed, and the point of a map is that things stay where you left them.
 */
export const AREA_SERIES = 6;

export function areaColor(area: Area, indexInIdOrder: number): string {
  return area.color ?? `var(--series-${(indexInIdOrder % AREA_SERIES) + 1})`;
}

/** Colour lookup by area id, built once from the id-ordered list. */
export function areaColors(areas: Area[]): Map<number, string> {
  const ordered = [...areas].sort((a, b) => a.id - b.id);
  return new Map(ordered.map((a, i) => [a.id, areaColor(a, i)]));
}

/** Unfiled work is visible and neutral — never hidden, never coloured. */
export const UNASSIGNED_COLOR = "var(--color-faint)";
