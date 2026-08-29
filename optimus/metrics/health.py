"""§24.8 goal health: a composite whose components are always shown (P3).

Two absences are deliberate and load-bearing.

  Pace ratio is not a term (D6). §11: pace ratio measures the quality of the
  original estimate, not the value of the work. A goal at 0.7 may simply have
  had an aggressive plan. Feasibility margin dominates instead, because "does
  the remaining work still fit before the deadline" means the same thing in
  every domain and is the only thing comparable across goals.

  self_assessed_pct is not a term (D12, test 14). A milestone the user sliders
  to 80% is not thereby healthy.

Every component is returned with its raw value, its normalization, and its
weight. A user who cannot interrogate the number will not calibrate their trust
in it, and will eventually discard the system (P3).
"""

from __future__ import annotations

from datetime import date

from .config import MetricsConfig
from .types import Drift, Feasibility, Health, HealthComponent


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def goal_health(
    feas: Feasibility,
    dr: Drift | None,
    days_to_nearest_deadline: int | None,
    days_since_last_session: int | None,
    config: MetricsConfig,
) -> Health:
    """Composite in [0, 1], where 1 is healthy. None when nothing is knowable.

    Components whose inputs are missing are reported with value=None and
    excluded from the weighted average, and the remaining weights are
    renormalized. This keeps a partially-known goal from being scored as
    unhealthy purely because data is absent -- absence is not evidence of
    trouble, and pretending otherwise would be a fabricated signal (P2).
    """
    h = config.health
    components: list[HealthComponent] = []

    # --- feasibility margin (dominant) ---------------------------------------
    # Infeasible (negative margin) floors at 0; a comfortable margin saturates at 1.
    note = feas.reason if feas.margin_sessions is None else (
        "INFEASIBLE" if feas.feasible is False else feas.reason
    )
    components.append(
        HealthComponent("feasibility_margin", feas.margin_sessions, h.w_feasibility, note)
    )

    # --- drift ---------------------------------------------------------------
    if dr is None or dr.sessions is None:
        components.append(HealthComponent("drift", None, h.w_drift, "no usable pace yet"))
    else:
        components.append(
            HealthComponent("drift", dr.sessions, h.w_drift, f"vs baseline v{dr.vs_version}")
        )

    # --- days to nearest deadline -------------------------------------------
    components.append(
        HealthComponent(
            "days_to_deadline",
            None if days_to_nearest_deadline is None else float(days_to_nearest_deadline),
            h.w_deadline,
            "" if days_to_nearest_deadline is not None else "no deadline set",
        )
    )

    # --- days since last session --------------------------------------------
    components.append(
        HealthComponent(
            "days_since_last_session",
            None if days_since_last_session is None else float(days_since_last_session),
            h.w_recency,
            "" if days_since_last_session is not None else "never worked",
        )
    )

    score = _composite(components, feas, dr, days_to_nearest_deadline,
                       days_since_last_session, config)
    return Health(score=score, components=tuple(components))


def _composite(
    components: list[HealthComponent],
    feas: Feasibility,
    dr: Drift | None,
    days_to_deadline: int | None,
    days_stale: int | None,
    config: MetricsConfig,
) -> float | None:
    """Weighted mean of the normalized components, renormalized over what is known."""
    h = config.health
    window = max(config.planning.feasibility_pressure_window_sessions, 1)

    normalized: list[tuple[float, float]] = []  # (value in [0,1], weight)

    if feas.margin_sessions is not None:
        normalized.append((_clamp(feas.margin_sessions / window), h.w_feasibility))

    if dr is not None and dr.sessions is not None:
        # Ahead of plan (negative drift) is fully healthy; slip degrades linearly.
        normalized.append(
            (_clamp(1.0 - dr.sessions / max(h.drift_tolerance_sessions, 1e-9)), h.w_drift)
        )

    if days_to_deadline is not None:
        normalized.append((_clamp(days_to_deadline / max(h.deadline_horizon_days, 1)), h.w_deadline))

    if days_stale is not None:
        normalized.append(
            (_clamp(1.0 - days_stale / max(h.staleness_cap_days, 1)), h.w_recency)
        )

    total_weight = sum(w for _v, w in normalized)
    if total_weight <= 0:
        return None
    return sum(v * w for v, w in normalized) / total_weight


def days_between(earlier: date, later: date) -> int:
    return (later - earlier).days
