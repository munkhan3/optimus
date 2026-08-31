"""Time-bucketed rollups for the dashboard and the roadmap.

Every GROUP BY in the application lives here. It is deliberately not in
optimus/metrics/: that package is pure by contract (tests/metrics/test_purity.py
enforces it), and a rollup needs a Session. Where a rollup needs real
statistics, the statistics live in optimus/metrics/summary.py and this module
only feeds them rows.

The other rule this module follows: it never recomputes a number that
metrics_service already produces. Pace, feasibility, drift and health come from
trackable_view()/milestone_view() unchanged, so the dashboard, the trackable
list and the assistant cannot disagree about the same trackable. Two sources of
truth for pace is the specific failure the whole architecture is arranged to
prevent.

On time zones: work_session.started_at is timestamptz, so bucketing it by day
requires the user's zone or every session after ~17:00 US-Pacific lands on
tomorrow. Callers pass an IANA name and the SQL buckets with
timezone(:tz, started_at), which is the function spelling of AT TIME ZONE and
takes the zone as a bind parameter rather than string interpolation.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Float, cast, func
from sqlmodel import Session, select

from optimus.metrics.summary import describe

from ..models import (
    Area,
    Baseline,
    Capacity,
    Goal,
    GoalBudget,
    Milestone,
    Trackable,
    WeeklyCommitment,
    WorkSession,
)
from ..settings import get_metrics_config
from . import loader, metrics_service

MAX_GOAL_DEPTH = 6      # matches tree.py; guards a cycle from becoming a hang
MAX_WEEKS = 104         # two years of history is plenty and bounds the payload


# ------------------------------------------------------------------ utilities


def validate_tz(tz: str) -> str:
    """Fail loudly on a bad zone rather than letting Postgres reject it later.

    A ValueError here becomes a 422 with the offending name in it. Falling back
    to UTC instead would silently put every cell on the wrong day, which is the
    kind of bug that gets reported as "the grid is just wrong sometimes".
    """
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown time zone: {tz!r}") from exc
    return tz


def _local_day(tz: str):
    """The session's date in the user's zone, as a SQL expression."""
    return func.date(func.timezone(tz, WorkSession.started_at))


def goal_subtree_ids(db: Session, goal_id: int) -> list[int]:
    """A goal and every goal beneath it. Goals nest (§9), so a widget scoped to
    a parent must include the work that actually hangs off its children."""
    found = [goal_id]
    frontier = [goal_id]
    for _ in range(MAX_GOAL_DEPTH):
        if not frontier:
            break
        children = db.exec(select(Goal.id).where(Goal.parent_id.in_(frontier))).all()
        frontier = [c for c in children if c not in found]
        found.extend(frontier)
    return found


def resolve_scope(
    db: Session, goal_id: int | None, trackable_id: int | None
) -> tuple[list[int] | None, list[int] | None]:
    """(trackable_ids, milestone_ids) a widget is asking about.

    (None, None) means "everything" and is left unfiltered rather than expanded
    into an IN clause over every row the account owns.
    """
    if trackable_id is not None:
        return [trackable_id], []
    if goal_id is not None:
        goals = goal_subtree_ids(db, goal_id)
        milestones = db.exec(select(Milestone.id).where(Milestone.goal_id.in_(goals))).all()
        milestone_ids = list(milestones)
        trackables = (
            db.exec(
                select(Trackable.id).where(Trackable.milestone_id.in_(milestone_ids))
            ).all()
            if milestone_ids
            else []
        )
        return list(trackables), milestone_ids
    return None, None


def _apply_scope(stmt, trackable_ids: list[int] | None, milestone_ids: list[int] | None):
    if trackable_ids is None and milestone_ids is None:
        return stmt
    # A session attaches to a trackable OR a milestone, so scoping has to admit
    # both sides or milestone-only work vanishes from every goal-scoped widget.
    clauses = []
    if trackable_ids:
        clauses.append(WorkSession.trackable_id.in_(trackable_ids))
    if milestone_ids:
        clauses.append(WorkSession.milestone_id.in_(milestone_ids))
    if not clauses:
        return stmt.where(False)
    if len(clauses) == 1:
        return stmt.where(clauses[0])
    return stmt.where(clauses[0] | clauses[1])


# -------------------------------------------------------------- activity grid


def activity(
    db: Session,
    *,
    today: date,
    tz: str,
    weeks: int,
    goal_id: int | None = None,
    trackable_id: int | None = None,
) -> dict[str, Any]:
    """The commitment grid: what was produced, on which local day.

    This is evidence, not a streak (§7 rules streaks out explicitly, and §3
    explains why: "a day of checked boxes and a day of real progress look
    identical"). So a cell carries the units produced that day, and a recurring
    commitment additionally gets a period row saying whether the window's target
    was actually met. Neither a streak length nor a longest-streak is computed
    anywhere in this function, and that is deliberate.
    """
    weeks = max(1, min(weeks, MAX_WEEKS))
    end = today
    start = loader.week_start(today) - timedelta(weeks=weeks - 1)

    trackable_ids, milestone_ids = resolve_scope(db, goal_id, trackable_id)

    day = _local_day(tz).label("day")
    stmt = (
        select(
            WorkSession.trackable_id,
            day,
            func.count(WorkSession.id),
            func.coalesce(func.sum(WorkSession.actual_output), 0.0),
            func.coalesce(func.sum(cast(WorkSession.actual_minutes, Float)), 0.0),
        )
        .where(day >= start)
        .where(day <= end)
        .group_by(WorkSession.trackable_id, day)
    )
    rows = db.exec(_apply_scope(stmt, trackable_ids, milestone_ids)).all()

    per_day: dict[date, dict[str, float]] = defaultdict(
        lambda: {"sessions": 0, "units": 0.0, "minutes": 0.0}
    )
    per_trackable_day: dict[int, dict[date, float]] = defaultdict(dict)
    for t_id, d, n, units, minutes in rows:
        cell = per_day[d]
        cell["sessions"] += int(n)
        cell["units"] += float(units or 0.0)
        cell["minutes"] += float(minutes or 0.0)
        if t_id is not None:
            per_trackable_day[t_id][d] = per_trackable_day[t_id].get(d, 0.0) + float(
                units or 0.0
            )

    scoped_trackables = _scoped_trackables(db, trackable_ids)
    units_seen = {t.unit for t in scoped_trackables}
    # Intensity can only mean "units produced" when every cell counts the same
    # thing. Pages and gym sessions summed into one number would be a shape with
    # no referent, so a mixed scope falls back to minutes worked and says so.
    basis = "units" if len(units_seen) == 1 else "minutes"

    days = []
    cursor = start
    while cursor <= end:
        cell = per_day.get(cursor)
        days.append(
            {
                "date": cursor.isoformat(),
                "sessions": int(cell["sessions"]) if cell else 0,
                "units": round(cell["units"], 4) if cell else 0.0,
                "minutes": round(cell["minutes"], 2) if cell else 0.0,
            }
        )
        cursor += timedelta(days=1)

    peak = max((d[basis] for d in days), default=0.0)

    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "tz": tz,
        "basis": basis,
        "unit": next(iter(units_seen)) if basis == "units" else "minutes",
        # The scale the UI ramps intensity against. Zero means an empty grid,
        # which must render as empty rather than as every cell at full strength.
        "peak": peak,
        "days": days,
        "periods": _period_rows(db, scoped_trackables, per_trackable_day, start, end),
    }


def _scoped_trackables(db: Session, trackable_ids: list[int] | None) -> list[Trackable]:
    stmt = select(Trackable)
    if trackable_ids is not None:
        if not trackable_ids:
            return []
        stmt = stmt.where(Trackable.id.in_(trackable_ids))
    return list(db.exec(stmt).all())


def _period_rows(
    db: Session,
    trackables: list[Trackable],
    per_trackable_day: dict[int, dict[date, float]],
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    """Met-or-missed per reset window, which is the honest measure for recurring
    work (§12: the window closes and the shortfall is discarded).

    Carry-forward work produces no rows here. Slicing a terminating goal into
    weekly pass/fail invents a deadline it does not have.
    """
    rows: list[dict[str, Any]] = []
    for trackable in trackables:
        goal = loader.goal_for_trackable(db, trackable)
        if goal is None or goal.pace_mode != "reset_period" or not goal.reset_period_days:
            continue
        span = goal.reset_period_days
        by_day = per_trackable_day.get(trackable.id or 0, {})

        cursor = loader.current_period_start(goal, start) or start
        while cursor <= end:
            stop = cursor + timedelta(days=span)
            done = sum(v for d, v in by_day.items() if cursor <= d < stop)
            target = trackable.total_units
            rows.append(
                {
                    "trackable_id": trackable.id,
                    "title": trackable.title,
                    "unit": trackable.unit,
                    "start": cursor.isoformat(),
                    "end": (stop - timedelta(days=1)).isoformat(),
                    "done": round(done, 4),
                    "target": target,
                    # None, not False, for a window still open: a Wednesday that
                    # has not reached its target has not missed it yet.
                    "met": (done >= target) if stop <= end + timedelta(days=1) else None,
                }
            )
            cursor = stop
    return rows


# ------------------------------------------------------------------ throughput


def throughput(
    db: Session, *, today: date, tz: str, weeks: int, task_type: str | None = None
) -> dict[str, Any]:
    """Sessions, minutes and output per week, plus output-per-session by type.

    Output per session is the productivity number: sessions are fixed-length
    (§36.1), so units-per-session is already normalized and needs no division by
    time. That is exactly why the session length is fixed.
    """
    weeks = max(1, min(weeks, MAX_WEEKS))
    start = loader.week_start(today) - timedelta(weeks=weeks - 1)

    day = _local_day(tz).label("day")
    stmt = (
        select(
            day,
            WorkSession.task_type,
            func.count(WorkSession.id),
            func.coalesce(func.sum(WorkSession.actual_output), 0.0),
            func.coalesce(func.sum(cast(WorkSession.actual_minutes, Float)), 0.0),
        )
        .where(day >= start)
        .where(day <= today)
        .group_by(day, WorkSession.task_type)
    )
    if task_type:
        stmt = stmt.where(WorkSession.task_type == task_type)
    rows = db.exec(stmt).all()

    buckets: dict[date, dict[str, float]] = defaultdict(
        lambda: {"sessions": 0, "units": 0.0, "minutes": 0.0}
    )
    for d, _tt, n, units, minutes in rows:
        b = buckets[loader.week_start(d)]
        b["sessions"] += int(n)
        b["units"] += float(units or 0.0)
        b["minutes"] += float(minutes or 0.0)

    series = []
    cursor = start
    while cursor <= today:
        b = buckets.get(cursor)
        series.append(
            {
                "week_start": cursor.isoformat(),
                "sessions": int(b["sessions"]) if b else 0,
                "units": round(b["units"], 4) if b else 0.0,
                "minutes": round(b["minutes"], 2) if b else 0.0,
            }
        )
        cursor += timedelta(days=7)

    return {
        "from": start.isoformat(),
        "to": today.isoformat(),
        "tz": tz,
        "weeks": series,
        "per_session": _output_per_session(db, start, today, tz, task_type),
        "capacity": _capacity_series(db, start, today),
    }


def _output_per_session(
    db: Session, start: date, end: date, tz: str, task_type: str | None
) -> list[dict[str, Any]]:
    """Distribution of actual_output per session, pooled by task_type (§24.3).

    Interrupted sessions are excluded, for the same reason pace excludes them:
    they measure an interruption, not a rate. They stay in the database.
    """
    day = _local_day(tz)
    stmt = (
        select(WorkSession.task_type, WorkSession.actual_output)
        .where(day >= start)
        .where(day <= end)
        .where(WorkSession.ended_at.is_not(None))
        .where(WorkSession.actual_output.is_not(None))
        .where(WorkSession.interrupted.is_(False))
    )
    if task_type:
        stmt = stmt.where(WorkSession.task_type == task_type)

    grouped: dict[str, list[float]] = defaultdict(list)
    for tt, output in db.exec(stmt).all():
        grouped[tt].append(float(output))

    minutes = get_metrics_config().session.minutes
    out = []
    for tt, values in sorted(grouped.items()):
        d = describe(values)
        out.append(
            {
                "task_type": tt,
                "session_minutes": minutes,
                "n": d.n,
                "mean": d.mean,
                "median": d.median,
                "p25": d.p25,
                "p75": d.p75,
                "low": d.low,
                "high": d.high,
            }
        )
    return out


def _capacity_series(db: Session, start: date, end: date) -> list[dict[str, Any]]:
    """Committed sessions against sessions actually used, per week."""
    rows = db.exec(
        select(Capacity)
        .where(Capacity.week_start >= start)
        .where(Capacity.week_start <= end)
        .order_by(Capacity.week_start)
    ).all()

    series = []
    for capacity in rows:
        committed = db.exec(
            select(func.coalesce(func.sum(WeeklyCommitment.committed_sessions), 0)).where(
                WeeklyCommitment.capacity_id == capacity.id
            )
        ).one()
        week_end = capacity.week_start + timedelta(days=7)
        used = db.exec(
            select(func.count(WorkSession.id))
            .where(func.date(WorkSession.started_at) >= capacity.week_start)
            .where(func.date(WorkSession.started_at) < week_end)
        ).one()
        minutes = capacity.session_minutes or get_metrics_config().session.minutes
        series.append(
            {
                "week_start": capacity.week_start.isoformat(),
                "declared_sessions": int(capacity.available_hours * 60 // minutes),
                "committed_sessions": int(committed or 0),
                "used_sessions": int(used or 0),
            }
        )
    return series


# ------------------------------------------------------------------ flow state


def flow(db: Session, *, today: date, tz: str, weeks: int) -> dict[str, Any]:
    """Time worked past the planned end of a session, by week and by goal.

    A session that runs out and gets ignored is the one thing in the log the
    user did not plan, schedule or commit to -- they simply did not want to
    stop. That makes it the closest measure the system has of which work is
    actually rewarding, as opposed to which work is on the list.

    Two figures, because minutes alone mislead. A goal with forty sessions and
    one long overrun is not the same as a goal with four sessions that all ran
    over, and the totals cannot tell them apart -- so `flow_rate`, the share of
    sessions that crossed at all, is reported beside the minutes.

    NULL flow_minutes means "ended before this was recorded", which is unknown
    and not zero. Those sessions are excluded from BOTH sides of the rate, so a
    long history of pre-existing rows cannot drag it towards zero and invent a
    finding about work the user has not done yet.
    """
    weeks = max(1, min(weeks, MAX_WEEKS))
    start = loader.week_start(today) - timedelta(weeks=weeks - 1)

    day = _local_day(tz).label("day")
    rows = db.exec(
        select(
            day,
            WorkSession.trackable_id,
            WorkSession.milestone_id,
            cast(WorkSession.flow_minutes, Float),
        )
        .where(day >= start)
        .where(day <= today)
        .where(WorkSession.flow_minutes.is_not(None))
    ).all()

    by_week: dict[date, dict[str, float]] = defaultdict(
        lambda: {"flow_minutes": 0.0, "sessions": 0, "sessions_in_flow": 0}
    )
    by_goal: dict[int, dict[str, float]] = defaultdict(
        lambda: {"flow_minutes": 0.0, "sessions": 0, "sessions_in_flow": 0}
    )

    for d, trackable_id, milestone_id, minutes in rows:
        minutes = float(minutes or 0.0)
        crossed = 1 if minutes > 0 else 0

        bucket = by_week[loader.week_start(d)]
        bucket["flow_minutes"] += minutes
        bucket["sessions"] += 1
        bucket["sessions_in_flow"] += crossed

        # Same walk up to the owning goal that the time portfolio uses: a
        # session hangs off a trackable or a milestone, never off a goal.
        milestone = None
        if trackable_id is not None:
            trackable = db.get(Trackable, trackable_id)
            milestone = db.get(Milestone, trackable.milestone_id) if trackable else None
        elif milestone_id is not None:
            milestone = db.get(Milestone, milestone_id)
        if milestone is None:
            continue
        goal = by_goal[milestone.goal_id]
        goal["flow_minutes"] += minutes
        goal["sessions"] += 1
        goal["sessions_in_flow"] += crossed

    def rate(bucket: dict[str, float]) -> float | None:
        n = int(bucket["sessions"])
        return round(int(bucket["sessions_in_flow"]) / n, 4) if n else None

    series = []
    cursor = start
    while cursor <= today:
        bucket = by_week.get(cursor)
        series.append(
            {
                "week_start": cursor.isoformat(),
                "flow_minutes": round(bucket["flow_minutes"], 2) if bucket else 0.0,
                "sessions": int(bucket["sessions"]) if bucket else 0,
                "sessions_in_flow": int(bucket["sessions_in_flow"]) if bucket else 0,
            }
        )
        cursor += timedelta(days=7)

    goals = [
        {
            "goal_id": gid,
            "title": (g.title if (g := db.get(Goal, gid)) else None),
            "area_id": g.area_id if g else None,
            "flow_minutes": round(bucket["flow_minutes"], 2),
            "sessions": int(bucket["sessions"]),
            "sessions_in_flow": int(bucket["sessions_in_flow"]),
            "flow_rate": rate(bucket),
        }
        for gid, bucket in by_goal.items()
    ]
    # Most flow first: the question is which work pulls you in, so the answer
    # belongs at the top rather than in goal-id order.
    goals.sort(key=lambda row: (-row["flow_minutes"], row["goal_id"]))

    totals = {
        "flow_minutes": round(sum(b["flow_minutes"] for b in by_week.values()), 2),
        "sessions": sum(int(b["sessions"]) for b in by_week.values()),
        "sessions_in_flow": sum(int(b["sessions_in_flow"]) for b in by_week.values()),
    }
    return {
        "from": start.isoformat(),
        "to": today.isoformat(),
        "tz": tz,
        "weeks": series,
        "goals": goals,
        "total_flow_minutes": totals["flow_minutes"],
        "sessions": totals["sessions"],
        "sessions_in_flow": totals["sessions_in_flow"],
        "flow_rate": rate(totals),
    }


# ------------------------------------------------------------------- portfolio


def portfolio(db: Session, *, today: date) -> dict[str, Any]:
    """Every active claim on the user's time, with the numbers already agreed.

    Progress, pace, feasibility, drift and health are taken verbatim from
    metrics_service. Nothing is recomputed here, so a goal cannot read as
    at-risk on the dashboard and comfortable on the trackable list.
    """
    areas = [
        {"id": a.id, "name": a.name, "color": a.color}
        for a in db.exec(select(Area).order_by(Area.id)).all()
    ]

    goals = db.exec(select(Goal).order_by(Goal.created_at, Goal.id)).all()
    milestones_by_goal: dict[int, list[Milestone]] = defaultdict(list)
    for m in db.exec(select(Milestone).order_by(Milestone.created_at, Milestone.id)).all():
        milestones_by_goal[m.goal_id].append(m)

    trackables_by_milestone: dict[int, list[Trackable]] = defaultdict(list)
    for t in db.exec(select(Trackable).order_by(Trackable.created_at, Trackable.id)).all():
        trackables_by_milestone[t.milestone_id].append(t)

    rows = []
    for goal in goals:
        goal_trackables = []
        goal_milestones = []
        for milestone in milestones_by_goal.get(goal.id or 0, []):
            goal_milestones.append(metrics_service.milestone_view(db, milestone, today))
            for trackable in trackables_by_milestone.get(milestone.id or 0, []):
                goal_trackables.append(metrics_service.trackable_view(db, trackable, today))

        rows.append(
            {
                "goal_id": goal.id,
                "title": goal.title,
                "area_id": goal.area_id,
                "kind": goal.kind,
                "stakes": goal.stakes,
                "activation": goal.activation,
                "pace_mode": goal.pace_mode,
                "reset_period_days": goal.reset_period_days,
                "deadline": goal.deadline.isoformat() if goal.deadline else None,
                "status": goal.status,
                "completed_at": goal.completed_at.isoformat() if goal.completed_at else None,
                "definition_of_done": goal.definition_of_done,
                "dod_source": goal.dod_source,
                "budgeted_sessions": loader.budgeted_sessions_per_week(db, goal.id or 0, today),
                "trackables": goal_trackables,
                "milestones": goal_milestones,
            }
        )

    return {
        "as_of": today.isoformat(),
        "areas": areas,
        "goals": rows,
        "time_portfolio": _time_portfolio(db, today),
    }


def _time_portfolio(db: Session, today: date) -> dict[str, Any]:
    """Where sessions actually went this week, against where they were budgeted.

    §11's whole argument is that time is a portfolio and every budget increase
    is visibly taken from somewhere else. Budgeted-versus-actual is the only
    view that shows whether the declared portfolio is the one being lived.
    """
    start = loader.week_start(today)
    end = start + timedelta(days=7)

    used_by_goal: dict[int, int] = defaultdict(int)
    rows = db.exec(
        select(WorkSession.trackable_id, WorkSession.milestone_id)
        .where(func.date(WorkSession.started_at) >= start)
        .where(func.date(WorkSession.started_at) < end)
    ).all()
    for trackable_id, milestone_id in rows:
        milestone = None
        if trackable_id is not None:
            trackable = db.get(Trackable, trackable_id)
            milestone = db.get(Milestone, trackable.milestone_id) if trackable else None
        elif milestone_id is not None:
            milestone = db.get(Milestone, milestone_id)
        if milestone is not None:
            used_by_goal[milestone.goal_id] += 1

    capacity = db.exec(select(Capacity).where(Capacity.week_start == start)).first()
    budgets = (
        db.exec(select(GoalBudget).where(GoalBudget.capacity_id == capacity.id)).all()
        if capacity
        else []
    )
    budgeted = {b.goal_id: b.budgeted_sessions for b in budgets}

    goal_ids = set(budgeted) | set(used_by_goal)
    return {
        "week_start": start.isoformat(),
        # Null, not zero: capacity that was never declared is unknown, and a
        # zero here would read as "you gave yourself no time this week".
        "declared_sessions": (
            int(capacity.available_hours * 60 // (capacity.session_minutes or 25))
            if capacity
            else None
        ),
        "goals": [
            {
                "goal_id": gid,
                "title": (g.title if (g := db.get(Goal, gid)) else None),
                "area_id": g.area_id if g else None,
                "budgeted_sessions": budgeted.get(gid),
                "used_sessions": used_by_goal.get(gid, 0),
            }
            for gid in sorted(goal_ids)
        ],
    }


# --------------------------------------------------------------------- roadmap


def roadmap(db: Session, *, today: date) -> dict[str, Any]:
    """Rows for the Gantt, and dated markers for the month calendar.

    Each row can carry three spans: the version-1 baseline, the current
    baseline, and what actually happened. §17 requires version 1 to stay on
    screen -- "three rebaselines in, the user must be able to see that this
    began as ten sessions targeting October" -- so the original is returned
    alongside the current one rather than replaced by it.

    A row with no target date gets `end: null`. The renderer must draw that
    open-ended. Substituting today, or the parent's deadline, would put a date
    on screen that nobody chose.
    """
    goals = db.exec(select(Goal).order_by(Goal.created_at, Goal.id)).all()
    milestones_by_goal: dict[int, list[Milestone]] = defaultdict(list)
    for m in db.exec(select(Milestone).order_by(Milestone.created_at, Milestone.id)).all():
        milestones_by_goal[m.goal_id].append(m)
    trackables_by_milestone: dict[int, list[Trackable]] = defaultdict(list)
    for t in db.exec(select(Trackable).order_by(Trackable.created_at, Trackable.id)).all():
        trackables_by_milestone[t.milestone_id].append(t)

    rows = []
    markers = []
    for goal in goals:
        goal_row = _row(
            kind="goal",
            node_id=goal.id or 0,
            title=goal.title,
            created_at=goal.created_at,
            target=goal.deadline,
            status=goal.status,
            completed_at=goal.completed_at,
        )
        goal_row["area_id"] = goal.area_id
        goal_row["stakes"] = goal.stakes
        goal_row["activation"] = goal.activation
        goal_row["pace_mode"] = goal.pace_mode
        goal_row["reset_period_days"] = goal.reset_period_days
        goal_row["children"] = []
        if goal.deadline:
            markers.append(_marker("goal", goal.id or 0, goal.title, goal.deadline, goal.status))

        for milestone in milestones_by_goal.get(goal.id or 0, []):
            view = metrics_service.milestone_view(db, milestone, today)
            m_row = _row(
                kind="milestone",
                node_id=milestone.id or 0,
                title=milestone.title,
                created_at=milestone.created_at,
                target=milestone.deadline,
                status=milestone.status,
                completed_at=milestone.completed_at,
            )
            m_row["blocked_by"] = milestone.blocked_by
            m_row["exploratory"] = milestone.exploratory
            m_row["feasibility"] = view["feasibility"]
            m_row["baselines"] = _baselines(db, milestone_id=milestone.id)
            m_row["children"] = []
            if milestone.deadline:
                markers.append(
                    _marker(
                        "milestone", milestone.id or 0, milestone.title,
                        milestone.deadline, milestone.status,
                    )
                )

            for trackable in trackables_by_milestone.get(milestone.id or 0, []):
                t_view = metrics_service.trackable_view(db, trackable, today)
                t_row = _row(
                    kind="trackable",
                    node_id=trackable.id or 0,
                    title=trackable.title,
                    created_at=trackable.created_at,
                    target=trackable.target_date,
                    status=trackable.status,
                    completed_at=trackable.completed_at,
                )
                t_row["unit"] = trackable.unit
                t_row["exploratory"] = trackable.exploratory
                t_row["feasibility"] = t_view["feasibility"]
                t_row["progress"] = t_view["progress"]
                t_row["projection"] = t_view["projection"]
                t_row["baselines"] = _baselines(db, trackable_id=trackable.id)
                t_row["children"] = []
                m_row["children"].append(t_row)
                if trackable.target_date:
                    markers.append(
                        _marker(
                            "trackable", trackable.id or 0, trackable.title,
                            trackable.target_date, trackable.status,
                        )
                    )

            goal_row["children"].append(m_row)
        rows.append(goal_row)

    return {
        "as_of": today.isoformat(),
        "rows": rows,
        "markers": sorted(markers, key=lambda m: m["date"]),
    }


def _row(
    *,
    kind: str,
    node_id: int,
    title: str,
    created_at: Any,
    target: date | None,
    status: str,
    completed_at: Any,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": node_id,
        "key": f"{kind[0]}{node_id}",
        "title": title,
        "start": created_at.date().isoformat() if created_at else None,
        "end": target.isoformat() if target else None,
        "status": status,
        # None means the completion date is unknown, which is not the same as
        # unfinished -- every row predating the completed_at column reads that
        # way and must not be drawn as an open bar.
        "completed_at": completed_at.date().isoformat() if completed_at else None,
    }


def _marker(kind: str, node_id: int, title: str, when: date, status: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": node_id,
        "key": f"{kind[0]}{node_id}",
        "title": title,
        "date": when.isoformat(),
        "status": status,
    }


def _baselines(
    db: Session, *, trackable_id: int | None = None, milestone_id: int | None = None
) -> dict[str, Any]:
    """Version 1 and current, always both (§25.3)."""
    stmt = select(Baseline).order_by(Baseline.version)
    stmt = (
        stmt.where(Baseline.trackable_id == trackable_id)
        if trackable_id is not None
        else stmt.where(Baseline.milestone_id == milestone_id)
    )
    rows = db.exec(stmt).all()
    if not rows:
        return {"original": None, "current": None, "versions": 0}

    def dump(b: Baseline) -> dict[str, Any]:
        return {
            "version": b.version,
            "planned_sessions": b.planned_sessions,
            "scope_units": b.scope_units,
            "target_date": b.target_date.isoformat(),
            "resolution": b.resolution,
            "rationale": b.rationale,
            "created_at": b.created_at.isoformat(),
        }

    return {"original": dump(rows[0]), "current": dump(rows[-1]), "versions": len(rows)}
