/**
 * The spring integrator.
 *
 * Every node is a mass on a spring anchored to the home position the layout
 * computed. At rest it sits exactly on that position, so the graph is identical
 * on every visit; the pointer only ever displaces it temporarily.
 *
 * This is NOT a force-directed layout. There is no inter-node repulsion and no
 * solver: positions are already decided, so the loop is O(n) and its only job
 * is to make getting there feel physical.
 */

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  /** Drawn radius, so the collision pass knows how much room to keep. */
  r: number;
}

export interface PointerState {
  /** Graph coordinates, or null when the pointer is away. */
  x: number | null;
  y: number | null;
  /** The captured node is exempt from the field -- see FIELD below. */
  exemptKey: string | null;
}

const STIFFNESS = 0.055;
const DAMPING = 0.86;
/** Beyond this the cursor does nothing. */
const FIELD_RADIUS = 145;
const FIELD_STRENGTH = 46;
/** Below this speed, with no pointer, the graph is considered settled. */
const SLEEP_SPEED = 0.02;

/**
 * Displacement from the cursor.
 *
 * The captured node is deliberately exempt. A field that pushes every nearby
 * node makes the one you are reaching for flee the cursor, so it can never be
 * hovered or clicked; parting the crowd *around* the target is what makes the
 * interaction feel intentional instead of slippery.
 */
function field(body: Body, key: string, pointer: PointerState): [number, number] {
  if (pointer.x === null || pointer.y === null) return [0, 0];
  if (pointer.exemptKey === key) return [0, 0];

  const dx = body.x - pointer.x;
  const dy = body.y - pointer.y;
  const dist = Math.hypot(dx, dy);
  if (dist > FIELD_RADIUS || dist < 1e-3) return [0, 0];

  // Smooth falloff to exactly zero at the edge, so nodes do not snap as the
  // cursor crosses the boundary.
  const falloff = 1 - dist / FIELD_RADIUS;
  const push = (FIELD_STRENGTH * falloff * falloff) / dist;
  return [dx * push, dy * push];
}

/**
 * Keep dots apart while they are in motion.
 *
 * The layout already guarantees the rest positions do not overlap, but the
 * pointer field displaces nodes, and a shove can push one dot straight through
 * another. This is a positional correction, not a force -- it never adds
 * energy, so it cannot stop the graph from settling.
 */
function separate(bodies: Map<string, Body>, gap: number): void {
  const list = [...bodies.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.r + b.r + gap;
      const d = Math.hypot(dx, dy);
      if (d >= min || d < 1e-6) continue;
      const push = (min - d) / 2;
      const ux = dx / d;
      const uy = dy / d;
      a.x -= ux * push;
      a.y -= uy * push;
      b.x += ux * push;
      b.y += uy * push;
    }
  }
}

/** One integration step. Returns the largest speed seen, for sleep detection. */
export function step(
  bodies: Map<string, Body>,
  pointer: PointerState,
  dt: number,
  gap = 7,
): number {
  let peak = 0;
  for (const [key, b] of bodies) {
    const [fx, fy] = field(b, key, pointer);
    b.vx = (b.vx + ((b.homeX - b.x) * STIFFNESS + fx * 0.02) * dt) * DAMPING;
    b.vy = (b.vy + ((b.homeY - b.y) * STIFFNESS + fy * 0.02) * dt) * DAMPING;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    peak = Math.max(peak, Math.abs(b.vx) + Math.abs(b.vy));
  }
  separate(bodies, gap);
  return peak;
}

/** True when the graph may stop rendering entirely. */
export function settled(peak: number, pointer: PointerState): boolean {
  return peak < SLEEP_SPEED && pointer.x === null;
}

/** Park every body exactly on its home, so the resting frame is the layout. */
export function snapHome(bodies: Map<string, Body>): void {
  for (const b of bodies.values()) {
    b.x = b.homeX;
    b.y = b.homeY;
    b.vx = 0;
    b.vy = 0;
  }
}

/**
 * Reconcile bodies with a new layout.
 *
 * Existing nodes keep their current position and merely get a new home, so a
 * focus change is a settle rather than a jump. New nodes start at their parent's
 * position when there is one -- they grow outward from where they belong
 * instead of flying in from the origin.
 */
export function reconcile(
  bodies: Map<string, Body>,
  homes: { key: string; x: number; y: number; r: number; parentKey?: string }[],
): void {
  const wanted = new Set(homes.map((h) => h.key));
  for (const key of [...bodies.keys()]) {
    if (!wanted.has(key)) bodies.delete(key);
  }
  for (const h of homes) {
    const existing = bodies.get(h.key);
    if (existing) {
      existing.homeX = h.x;
      existing.homeY = h.y;
      existing.r = h.r;
      continue;
    }
    const parent = h.parentKey ? bodies.get(h.parentKey) : undefined;
    bodies.set(h.key, {
      x: parent ? parent.x : h.x,
      y: parent ? parent.y : h.y,
      vx: 0,
      vy: 0,
      homeX: h.x,
      homeY: h.y,
      r: h.r,
    });
  }
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
