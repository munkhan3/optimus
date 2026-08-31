"""§25.1 weekly ranking.

    score = w_f * feasibility_pressure   -- how close to infeasible; 0 if comfortable
          + w_u * urgency                -- normalized inverse days-to-deadline
          + w_s * stakes                 -- parent goal stakes, normalized
          + w_b * unblocking             -- 1 if something is blocked_by this
          + w_n * neglect                -- days since last session, capped
          - w_e * effort_penalty         -- est_minutes normalized

Ranking happens WEEKLY, not daily (D9/§16). The daily plan redistributes what
remains without re-scoring. Re-scoring daily produces thrash: logging a session
drops that item's deficit, something else jumps to the top, the plan feels
arbitrary, and the user stops trusting it. Stability is worth more than daily
optimality.

Pace deficit is deliberately absent (D6). Feasibility pressure replaces it,
which also removes the structural bias against milestones with no natural
counter -- they arrive as the same ScoreInputs and are scored on identical
terms (test 6).

Every component, its raw value, its normalization, and its weight is persisted
to plan_item.score_breakdown. That is not telemetry (P3): it is the only way to
answer "why this?", and it is the training set for Part IV. Never empty
(test 13).
"""

from __future__ import annotations

from collections.abc import Sequence

from .config import MetricsConfig
from .types import ScoreComponent, ScoredItem, ScoreInputs


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def score_item(inputs: ScoreInputs, config: MetricsConfig) -> ScoredItem:
    """Rank one candidate. Returns the score and its full decomposition."""
    p = config.planning
    components: list[ScoreComponent] = []

    # --- feasibility pressure: 0 when comfortable, 1 at or past infeasible ---
    window = max(p.feasibility_pressure_window_sessions, 1)
    if inputs.feasibility_margin_sessions is None:
        # No evidence of pressure is not evidence of pressure. Contributing 0
        # here rather than a neutral 0.5 keeps the system from manufacturing
        # urgency for work it knows nothing about (P2).
        pressure = 0.0
    else:
        pressure = _clamp(1.0 - inputs.feasibility_margin_sessions / window)
    components.append(
        ScoreComponent(
            "feasibility_pressure", inputs.feasibility_margin_sessions, pressure, p.w_feasibility
        )
    )

    # --- urgency: inverse days to deadline, saturating past the deadline -----
    if inputs.days_to_deadline is None:
        urgency = 0.0  # no deadline -> parked or not being worked on (§12)
    else:
        urgency = _clamp(1.0 - inputs.days_to_deadline / max(p.urgency_horizon_days, 1))
    components.append(
        ScoreComponent("urgency", inputs.days_to_deadline, urgency, p.w_urgency)
    )

    # --- stakes: the parent goal's 1..5, normalized --------------------------
    span = max(p.stakes_max - p.stakes_min, 1)
    stakes = _clamp((inputs.stakes - p.stakes_min) / span)
    components.append(ScoreComponent("stakes", inputs.stakes, stakes, p.w_stakes))

    # --- unblocking ----------------------------------------------------------
    unblocking = 1.0 if inputs.unblocks_something else 0.0
    components.append(
        ScoreComponent("unblocking", inputs.unblocks_something, unblocking, p.w_unblocking)
    )

    # --- neglect: capped days since last session -----------------------------
    if inputs.days_since_last_session is None:
        neglect = 1.0  # never worked is genuinely maximal neglect
    else:
        neglect = _clamp(inputs.days_since_last_session / max(p.neglect_cap_days, 1))
    components.append(
        ScoreComponent("neglect", inputs.days_since_last_session, neglect, p.w_neglect)
    )

    # --- density: work whose unit understates its cost -----------------------
    # A trackable measured in pages, some of which hold hour-long problems, is
    # ranked on a counter that does not reflect what it takes. Without this term
    # it loses every week to work that is merely easier to count.
    #
    # An absent index contributes 0, not a neutral 0.5 -- the same restraint
    # feasibility_pressure shows above. No evidence that a unit understates the
    # work is not evidence that it does.
    if inputs.productivity_index is None:
        density = 0.0
    else:
        # The saturation point lives beside its siblings in [productivity]
        # rather than in [planning]: it is a fact about the density scale, and
        # splitting it from normal_index_low/high would let the two drift.
        density = _clamp(
            (inputs.productivity_index - 1.0)
            / max(config.productivity.density_reference, 1e-9)
        )
    components.append(
        ScoreComponent("density_underestimate", inputs.productivity_index, density, p.w_density)
    )

    # --- effort penalty: SUBTRACTED, so its weight is carried negative -------
    # Keeping the sign in the weight means sum(contributions) == score exactly,
    # which makes the stored breakdown self-checking.
    if inputs.est_minutes is None:
        effort = 0.0
    else:
        effort = _clamp(inputs.est_minutes / max(p.effort_reference_minutes, 1))
    components.append(
        ScoreComponent("effort_penalty", inputs.est_minutes, effort, -p.w_effort)
    )

    score = sum(c.contribution for c in components)
    return ScoredItem(
        score=score,
        components=tuple(components),
        trackable_id=inputs.trackable_id,
        milestone_id=inputs.milestone_id,
    )


def rank(items: Sequence[ScoreInputs], config: MetricsConfig) -> list[ScoredItem]:
    """Score and order a week's candidates, highest first.

    Ties break on the identity of the item so ordering is deterministic --
    two runs over unchanged inputs must produce the same plan (test 10).
    """
    scored = [score_item(i, config) for i in items]
    scored.sort(
        key=lambda s: (-s.score, s.trackable_id or 0, s.milestone_id or 0)
    )
    return scored
