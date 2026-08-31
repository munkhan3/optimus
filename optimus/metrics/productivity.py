"""The second measurement axis: work done, as distinct from progress made.

`unit` measures PROGRESS and is chosen because its denominator is knowable -- a
book has 380 pages. It is a poor measure of WORK: a page holding an hour-long
problem is not a page of prose, and today every bit of that difference lands in
pace variance, where §25.4 can mistake it for the user being slow. That is a
misreading with consequences, since it prompts a rebaseline against work that
was never behind.

The way out is that sessions carry a duration and two counts, so the minutes
spent are a linear combination of them:

    minutes ~= alpha * primary + beta * secondary

Fitting that recovers what a page and a problem each actually COST, which is
the quantity nobody can state up front and every plan silently assumes. From it:

    k                  = beta / alpha        primary units displaced by one secondary
    effective_output   = primary + k * secondary
    productivity_index = (alpha*primary + beta*secondary) / minutes
    density_factor     = (secondary/primary) / median(secondary_j/primary_j)

`productivity_index` is predicted minutes over actual minutes: 1.0 is a session
that went exactly as the fit expects. It is dimensionless, which is what makes
it comparable across incommensurable work (§11) when the raw counts are not.

Two rules govern this module, and they are the same two that govern the rest of
the engine.

  The fit is PER TRACKABLE, never pooled. A problem in one book is not a problem
  in another, so pooling by task_type -- right for §24.3, where a new trackable
  should inherit demonstrated speed -- would average away the only quantity of
  interest here.

  A fit the data does not support is UNAVAILABLE, not a weaker number (P2).
  There is no partial credit: a wrong cost-per-problem does not degrade
  gracefully, it flows into the index and out into weekly ranking.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence

from .config import MetricsConfig
from .pace import credible_minutes, normalized_output
from .types import (
    Basis,
    Calculation,
    DensityFit,
    SeriesStability,
    SessionObs,
    SessionProductivity,
)


def _fittable(
    sessions: Sequence[SessionObs], config: MetricsConfig
) -> list[tuple[float, float, float]]:
    """(primary, secondary, minutes) for sessions that can carry the fit.

    A session with no recorded secondary count is skipped rather than read as a
    zero. Those are different claims -- "I did not write down how many problems"
    is not "I solved none" -- and treating the first as the second would drag
    the fitted cost of a problem toward zero, which is the exact conclusion the
    missing data cannot support.

    A session whose duration was not actually MEASURED is skipped too, and this
    is stricter than pace.py, deliberately. Elsewhere an unbelievable clock
    falls back to the planned length, which is a fair stand-in when duration is
    only being used to scale an output. Here duration is the thing being
    regressed on: substituting the plan would teach the fit that this work costs
    exactly what was planned for it, which is the assumption the fit exists to
    test. One such row sets what every later session is judged against.
    """
    floor = config.session.min_session_minutes
    rows: list[tuple[float, float, float]] = []
    for s in sessions:
        if s.interrupted or s.actual_output is None or s.secondary_output is None:
            continue
        if s.actual_minutes is None or s.actual_minutes < floor:
            continue
        rows.append((s.actual_output, s.secondary_output, s.actual_minutes))
    return rows


def density_fit(sessions: Sequence[SessionObs], config: MetricsConfig) -> DensityFit:
    """Least squares for `minutes ~= alpha*primary + beta*secondary`.

    Two predictors, no intercept: a session of zero pages and zero problems took
    zero minutes, so forcing the line through the origin is not a convenience,
    it is the correct model. Solved in closed form from the normal equations --
    stdlib only, and two parameters do not need an iterative solver.
    """
    rows = _fittable(sessions, config)
    n = len(rows)
    cfg = config.productivity

    if n < cfg.min_sessions_for_fit:
        return DensityFit(
            None, None, None, None, n, Basis.UNAVAILABLE,
            f"Needs {cfg.min_sessions_for_fit} sessions recording both counts; has {n}.",
        )

    s_gg = sum(g * g for g, _p, _m in rows)
    s_pp = sum(p * p for _g, p, _m in rows)
    s_gp = sum(g * p for g, p, _m in rows)
    s_gm = sum(g * m for g, _p, m in rows)
    s_pm = sum(p * m for _g, p, m in rows)

    det = s_gg * s_pp - s_gp * s_gp
    # Vanishing determinant means the two counts move together across every
    # session -- always four problems per ten pages, say -- and no amount of
    # such data can separate what a page costs from what a problem costs.
    if abs(det) < 1e-9:
        return DensityFit(
            None, None, None, None, n, Basis.UNAVAILABLE,
            "The two counts never vary independently, so their costs cannot be told apart.",
        )

    alpha = (s_pp * s_gm - s_gp * s_pm) / det
    beta = (s_gg * s_pm - s_gp * s_gm) / det

    if alpha <= 0 or beta <= 0:
        # A negative cost means a page or a problem gives time back. The model
        # is wrong for this data; saying so is the only honest response.
        return DensityFit(
            None, None, None, None, n, Basis.UNAVAILABLE,
            "The fit implies a negative cost per unit, which the model cannot mean.",
        )

    ss_res = sum((m - alpha * g - beta * p) ** 2 for g, p, m in rows)
    # Uncentered total, because the model has no intercept: the baseline this is
    # scored against is "zero minutes", not "the mean session length".
    ss_tot = sum(m * m for _g, _p, m in rows)
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else None

    if r_squared is None or r_squared < cfg.min_r_squared:
        return DensityFit(
            None, None, None, r_squared, n, Basis.UNAVAILABLE,
            f"The fit explains too little of the time spent (R^2 {r_squared:.2f} < "
            f"{cfg.min_r_squared}).",
        )

    return DensityFit(
        alpha=alpha,
        beta=beta,
        k=beta / alpha,
        r_squared=r_squared,
        n_sessions=n,
        basis=Basis.OBSERVED,
        reason="",
    )


def _tukey_fence(
    values: Sequence[float], config: MetricsConfig
) -> tuple[float, float] | None:
    """The band outside which a value is unusual. None while n is too small.

    Gated on the same `min_sessions_for_iqr` §25.4 uses: below it the quartiles
    are not describing a distribution, and calling a session unusual against
    them would be inventing the standard it is measured by.
    """
    if len(values) < config.pace.min_sessions_for_iqr:
        return None
    q1, _median, q3 = statistics.quantiles(values, n=4, method="inclusive")
    span = config.productivity.outlier_fence * (q3 - q1)
    return q1 - span, q3 + span


def session_productivity(
    session: SessionObs,
    history: Sequence[SessionObs],
    fit: DensityFit,
    config: MetricsConfig,
) -> SessionProductivity:
    """How much work one session held, and whether a low page count is alarming.

    `history` is this trackable's own sessions, which may include `session`.
    """
    cfg = config.productivity
    primary = session.actual_output
    secondary = session.secondary_output
    minutes = credible_minutes(session, config)

    # --- is the PROGRESS unusual? measured on the primary axis alone ---------
    observations = [
        o for o in (normalized_output(s, config) for s in history) if o is not None
    ]
    fence = _tukey_fence(observations, config)
    own = normalized_output(session, config)
    progress_outlier = bool(
        fence is not None and own is not None and (own < fence[0] or own > fence[1])
    )

    # --- how much work did it hold? ------------------------------------------
    effective: float | None = None
    index: float | None = None
    if fit.is_usable and primary is not None and fit.k is not None:
        effective = primary + fit.k * (secondary or 0.0)
        if minutes and minutes > 0 and fit.alpha is not None and fit.beta is not None:
            predicted = fit.alpha * primary + fit.beta * (secondary or 0.0)
            index = predicted / minutes

    # --- how much denser than usual? -----------------------------------------
    ratios = [
        s.secondary_output / s.actual_output
        for s in history
        if s.actual_output and s.actual_output > 0 and s.secondary_output is not None
    ]
    density: float | None = None
    if ratios and primary and primary > 0 and secondary is not None:
        typical = statistics.median(ratios)
        if typical > 0:
            density = (secondary / primary) / typical

    explained = bool(
        progress_outlier
        and index is not None
        and cfg.normal_index_low <= index <= cfg.normal_index_high
    )

    return SessionProductivity(
        effective_output=effective,
        productivity_index=index,
        density_factor=density,
        progress_outlier=progress_outlier,
        explained_by_density=explained,
        fit=fit,
        calculation=Calculation(
            formula="(alpha*primary + beta*secondary) / minutes",
            terms=(
                ("primary units", primary),
                ("secondary units", secondary),
                ("minutes", minutes),
                ("minutes per primary unit (alpha)", fit.alpha),
                ("minutes per secondary unit (beta)", fit.beta),
                ("primary units per secondary unit (k)", fit.k),
                ("effective output", effective),
            ),
            result=index,
            note=(
                fit.reason
                if not fit.is_usable
                else "1.0 means the session went exactly as your history predicts."
            ),
        ),
    )


def _relative_iqr(values: Sequence[float]) -> float | None:
    """IQR over median. Dimensionless, so two different units can be compared."""
    if len(values) < 4:
        return None
    q1, median, q3 = statistics.quantiles(values, n=4, method="inclusive")
    if median <= 0:
        return None
    return (q3 - q1) / median


def series_stability(
    sessions: Sequence[SessionObs], config: MetricsConfig
) -> SeriesStability:
    """Which unit measures the work more faithfully, over the SAME sessions.

    This is what may propose changing the metric, and it is deliberately a
    measurement rather than a judgement. A unit whose observations scatter far
    less is tracking the work better; if the two scatter about equally, churning
    the unit buys nothing and the proposal is not made.

    Both series are compared over sessions carrying both counts, so the answer
    cannot come from the two being measured on different work.
    """
    rows = _fittable(sessions, config)
    n = len(rows)
    cfg = config.productivity

    if n < cfg.min_sessions_for_fit:
        return SeriesStability(
            None, None, n, False,
            f"Needs {cfg.min_sessions_for_fit} sessions recording both counts; has {n}.",
        )

    primary_rel = _relative_iqr([g for g, _p, _m in rows])
    secondary_rel = _relative_iqr([p for _g, p, _m in rows])

    if primary_rel is None or secondary_rel is None:
        return SeriesStability(
            primary_rel, secondary_rel, n, False,
            "One of the series has no usable spread to compare.",
        )

    tighter = secondary_rel <= primary_rel * (1.0 - cfg.stability_margin)
    return SeriesStability(
        primary_relative_iqr=primary_rel,
        secondary_relative_iqr=secondary_rel,
        n_sessions=n,
        secondary_is_tighter=tighter,
        reason=(
            f"Secondary spread {secondary_rel:.2f} vs primary {primary_rel:.2f}."
            if tighter
            else f"Secondary spread {secondary_rel:.2f} does not beat primary "
            f"{primary_rel:.2f} by {cfg.stability_margin:.0%}."
        ),
    )
