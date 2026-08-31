"""§25.2 rebaseline triggers and the §25.4 gate.

This module proposes. It never applies. The four-option choice belongs to the
user (§17, D11), and the system's job is to refuse to pretend an impossible
plan is fine -- not to fix it unilaterally.

The gate exists because acting on noise destroys trust faster than acting late.
At n=2 the pace interval is wide, a bad week means nothing, and prompting a
rebaseline teaches the user that the prompts are worthless (test 9).

One interpretation worth stating. §25.4 says to rebaseline when drift exceeds
"the interval's upper bound", but drift is measured in sessions and the interval
is in units-per-session, so they cannot be compared directly. The reading
implemented here is the dimensionally sound one and matches the intent: recompute
the drift at the OPTIMISTIC end of the pace interval, and if the work is still
behind even assuming the user's best observed speed, the slip is real rather
than an artifact of estimate uncertainty.
"""

from __future__ import annotations

from .config import MetricsConfig
from .types import (
    Drift,
    PaceEstimate,
    RebaselineProposal,
    SessionProductivity,
    StallReport,
)

# §17. Order is meaningful and moving the deadline is never first. Silent
# deadline extension is how a goal drifts for months without formally failing,
# and preventing that is a core purpose of the system.
#
# STAYS AT FOUR. The `change_metric` resolution the baseline table also accepts
# is not a fifth way to absorb slip and must never be offered here -- see the
# migration b7e2a4c93f18 docstring.
FOUR_OPTIONS = ("add_sessions", "cut_scope", "move_deadline", "declare_infeasible")


def _drift_at_optimistic_pace(
    remaining_units: float,
    pace: PaceEstimate,
    planned_sessions_remaining: int,
) -> float | None:
    if pace.interval is None or pace.interval.high <= 0:
        return None
    return remaining_units / pace.interval.high - planned_sessions_remaining


def evaluate_metered(
    remaining_units: float,
    pace: PaceEstimate,
    dr: Drift,
    config: MetricsConfig,
    productivity: SessionProductivity | None = None,
) -> RebaselineProposal:
    """Should metered work prompt a rebaseline? (§25.2 first trigger)

    `productivity` may hold the prompt back. Drift is measured in the primary
    unit, and where that unit understates the work -- pages that happen to hold
    problems -- the drift is an artifact of the counter rather than evidence of
    slowness. Prompting there teaches the user the prompts are worthless, which
    is the same failure the §25.4 gate exists to prevent, arriving by a
    different route.

    Two bounds keep this from becoming the silent drift §17 exists to prevent.
    Suppression stops entirely once drift passes `suppression_max_drift_sessions`
    -- past that the work is behind regardless of why. And a held prompt is still
    reported: `should_prompt` is False but `trigger` retains "drift", so the
    weekly review can list it as deferred rather than losing it.
    """
    if dr.sessions is None:
        return RebaselineProposal(
            should_prompt=False,
            trigger="",
            gate_passed=False,
            gate_reason="No usable pace estimate yet.",
            options=FOUR_OPTIONS,
        )

    material = dr.sessions >= config.rebaseline.material_drift_sessions
    enough_data = pace.n_sessions >= config.pace.min_sessions_for_iqr

    optimistic = _drift_at_optimistic_pace(
        remaining_units, pace, dr.planned_sessions_remaining
    )
    survives_interval = optimistic is not None and optimistic > 0

    gate_passed = enough_data or survives_interval

    if not material:
        reason = (
            f"Drift {dr.sessions:.1f} sessions is below the material threshold "
            f"({config.rebaseline.material_drift_sessions})."
        )
    elif gate_passed:
        reason = (
            f"n={pace.n_sessions} sessions"
            if enough_data
            else "drift persists even at the optimistic end of the pace interval"
        )
    else:
        reason = (
            f"Interval still wide (n={pace.n_sessions} < "
            f"{config.pace.min_sessions_for_iqr}) and the drift does not survive it "
            "-- a bad week at this sample size is noise, not signal."
        )

    would_prompt = material and gate_passed
    held = _held_by_density(would_prompt, dr, productivity, config)
    if held:
        reason = held

    return RebaselineProposal(
        should_prompt=would_prompt and not held,
        # Retained when held, so the weekly review can surface a DEFERRED prompt
        # rather than one that silently vanished.
        trigger="drift" if would_prompt else "",
        gate_passed=gate_passed,
        gate_reason=reason,
        options=FOUR_OPTIONS,
        held_by_density=bool(held),
    )


def _held_by_density(
    would_prompt: bool,
    dr: Drift,
    productivity: SessionProductivity | None,
    config: MetricsConfig,
) -> str:
    """The reason a prompt is being held, or "" if it is not."""
    if not would_prompt or productivity is None:
        return ""
    if not productivity.fit.is_usable or productivity.productivity_index is None:
        return ""
    cfg = config.productivity
    if productivity.productivity_index < cfg.normal_index_low:
        return ""  # the sessions really were below par; nothing to explain it away
    if dr.sessions is not None and dr.sessions > cfg.suppression_max_drift_sessions:
        # Far enough behind that the cause stops mattering.
        return ""
    return (
        f"Held: drift is measured in the primary unit, but recent sessions ran at "
        f"{productivity.productivity_index:.2f}x the work your history predicts. "
        "The counter is understating the work, not the work falling behind."
    )


def evaluate_exploratory(stall: StallReport) -> RebaselineProposal:
    """Should exploratory work prompt a rebaseline? (§25.2 second trigger)

    No pace gate applies: exploratory work has no honest counter, so the stall
    itself is the evidence. A long plateau usually means the remaining work was
    underestimated, which is why the likely resolution is cutting scope or
    sharpening the definition of done rather than adding sessions.
    """
    if not stall.stalled:
        return RebaselineProposal(
            should_prompt=False,
            trigger="",
            gate_passed=True,
            gate_reason="Self-assessed progress is still moving.",
            options=FOUR_OPTIONS,
        )
    return RebaselineProposal(
        should_prompt=True,
        trigger="stall",
        gate_passed=True,
        gate_reason=(
            f"Self-assessment has not moved "
            f"{stall.sessions_since_movement} sessions running "
            f"(series: {' -> '.join(f'{p:g}' for p in stall.series)}). "
            "A plateau usually means the remaining work was underestimated."
        ),
        options=FOUR_OPTIONS,
    )
