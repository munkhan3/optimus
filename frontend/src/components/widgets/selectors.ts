/**
 * Pure readers over the portfolio payload.
 *
 * Kept out of shared.tsx because a module that exports both components and
 * plain functions breaks fast refresh -- every helper edit remounts the widgets
 * instead of hot-swapping them.
 */

import type { Portfolio, PortfolioGoal, PortfolioTrackable } from "../../lib/dashboard";

/** Every trackable in the portfolio, tagged with the goal it belongs to. */
export function flattenTrackables(
  portfolio: Portfolio,
): { goal: PortfolioGoal; trackable: PortfolioTrackable }[] {
  return portfolio.goals.flatMap((goal) =>
    goal.trackables.map((trackable) => ({ goal, trackable })),
  );
}

/** Active goals only. Parked work competes for nothing (§12) and would
    otherwise crowd out the goals that are actually at risk. */
export function activeGoals(portfolio: Portfolio): PortfolioGoal[] {
  return portfolio.goals.filter((g) => g.activation === "active" && g.kind !== "vision");
}


/**
 * Work that can still go wrong.
 *
 * "What is about to break" and "what is due next" are questions about the
 * future, so finished and abandoned work is noise in them -- a filed tax return
 * listed under Feasibility with no slack left is technically true and useless.
 * Progress and history widgets deliberately keep showing it.
 */
export function isOpen(node: { status: string }): boolean {
  return node.status !== "done" && node.status !== "abandoned";
}
