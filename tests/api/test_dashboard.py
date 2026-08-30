"""Dashboard rollups, manual week shaping, and completion timestamps.

The empty-state and timezone tests come first on purpose. Both are the kind of
bug a metrics dashboard ships with and nobody notices for a month: a fabricated
zero reads as a real measurement, and a day boundary in the wrong zone silently
moves half the user's evening work onto tomorrow.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from tests.db_fixtures import log_session


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


TODAY = datetime.now(UTC).date()
THIS_MONDAY = _monday(TODAY)


@pytest.fixture
def recurring(client: TestClient) -> dict:
    """A gym-style commitment: six sessions a week, resetting every week (§12)."""
    client.post("/api/goals", json={
        "title": "Train six days a week", "kind": "goal",
        "definition_of_done": "Six sessions logged every week",
        "activation": "active", "pace_mode": "reset_period",
        "reset_period_days": 7, "stakes": 4,
    })
    client.post("/api/milestones", json={
        "goal_id": 1, "title": "Weekly training",
        "definition_of_done": "Six sessions this week",
    })
    client.post("/api/trackables", json={
        "milestone_id": 1, "title": "Gym", "unit": "sessions",
        "total_units": 6, "total_units_source": "user_supplied",
        "task_type": "admin", "prior_pace": 1,
    })
    return {"goal_id": 1, "trackable_id": 1}


# --------------------------------------------------------------- empty state


def test_empty_account_reports_nulls_not_fabricated_zeroes(client: TestClient) -> None:
    """P2. Nothing yet must read as "nothing yet", never as a measurement of zero."""
    activity = client.get("/api/dashboard/activity?weeks=4&tz=UTC").json()
    assert activity["peak"] == 0
    assert activity["periods"] == []
    assert all(d["sessions"] == 0 for d in activity["days"])

    throughput = client.get("/api/dashboard/throughput?weeks=4&tz=UTC").json()
    assert throughput["per_session"] == []
    assert all(w["sessions"] == 0 for w in throughput["weeks"])

    portfolio = client.get("/api/dashboard/portfolio").json()
    assert portfolio["goals"] == []
    # Undeclared capacity is unknown, not zero -- a 0 here would read as
    # "you gave yourself no time this week".
    assert portfolio["time_portfolio"]["declared_sessions"] is None

    assert client.get("/api/dashboard/calibration").json() == {"by_task_type": {}}
    assert client.get("/api/dashboard/roadmap").json()["rows"] == []


# ----------------------------------------------------------------- time zones


def test_sessions_bucket_by_local_day_not_utc(client: TestClient, seeded: dict) -> None:
    """A 23:30 session west of UTC belongs to the day the user lived, not the
    day Postgres stored. This is the bug format.ts:localDate() exists to
    prevent on the client, and it has to be prevented here too."""
    local_day = THIS_MONDAY
    # 23:30 in New York on local_day is 03:30 UTC the following morning.
    instant = datetime(local_day.year, local_day.month, local_day.day, 23, 30, tzinfo=UTC)
    instant += timedelta(hours=4)

    client.post("/api/sessions", json={
        "trackable_id": seeded["trackable"]["id"],
        "started_at": instant.isoformat(),
        "actual_output": 12,
    })

    ny = client.get("/api/dashboard/activity?weeks=2&tz=America/New_York").json()
    utc = client.get("/api/dashboard/activity?weeks=2&tz=UTC").json()

    def units_on(payload: dict, day: date) -> float:
        return next(d["units"] for d in payload["days"] if d["date"] == day.isoformat())

    assert units_on(ny, local_day) == 12
    assert units_on(utc, local_day) == 0
    assert units_on(utc, local_day + timedelta(days=1)) == 12


def test_unknown_timezone_is_rejected_rather_than_defaulted(client: TestClient) -> None:
    r = client.get("/api/dashboard/activity?tz=Mars/Olympus")
    assert r.status_code == 422
    assert "Mars/Olympus" in r.json()["detail"]


# ------------------------------------------------------- recurring commitments


def test_recurring_progress_measures_this_period_not_lifetime(
    client: TestClient, recurring: dict
) -> None:
    """§12/D4. The window closes and the shortfall is discarded, so a recurring
    trackable that has run for months is not thereby 100% complete forever."""
    last_week = (THIS_MONDAY - timedelta(days=3)).isoformat() + "T10:00:00+00:00"
    for _ in range(6):
        client.post("/api/sessions", json={
            "trackable_id": recurring["trackable_id"],
            "started_at": last_week, "actual_output": 1,
        })
    log_session(client, recurring["trackable_id"], 1)

    view = client.get(f"/api/trackables/{recurring['trackable_id']}").json()
    # Lifetime is 7; this period is 1 of 6.
    assert view["progress"]["completed_units"] == 1
    assert view["progress"]["remaining_units"] == 5
    assert view["period_start"] == THIS_MONDAY.isoformat()


def test_period_rows_report_met_against_the_committed_target(
    client: TestClient, recurring: dict
) -> None:
    """The grid's period row is met-or-missed against the target, which is the
    only honest summary for work whose shortfall is discarded. No streak is
    computed and none is returned."""
    prior_monday = THIS_MONDAY - timedelta(days=7)
    for offset in range(6):
        client.post("/api/sessions", json={
            "trackable_id": recurring["trackable_id"],
            "started_at": (prior_monday + timedelta(days=offset)).isoformat()
            + "T10:00:00+00:00",
            "actual_output": 1,
        })

    payload = client.get("/api/dashboard/activity?weeks=3&tz=UTC").json()
    rows = {p["start"]: p for p in payload["periods"]}
    assert rows[prior_monday.isoformat()]["done"] == 6
    assert rows[prior_monday.isoformat()]["met"] is True
    # The open window is not yet a miss.
    assert rows[THIS_MONDAY.isoformat()]["met"] is None

    assert "streak" not in payload
    assert not any("streak" in key for row in payload["periods"] for key in row)


# ------------------------------------------------------------------ agreement


def test_dashboard_and_trackable_list_report_identical_numbers(
    client: TestClient, seeded: dict
) -> None:
    """Two sources of truth for pace is the failure this architecture exists to
    prevent, so the dashboard must not recompute what metrics_service returns."""
    log_session(client, seeded["trackable"]["id"], 25)
    log_session(client, seeded["trackable"]["id"], 18)

    from_list = client.get("/api/trackables").json()[0]
    from_dashboard = client.get("/api/dashboard/portfolio").json()["goals"][0]["trackables"][0]

    for field in ("progress", "pace", "feasibility", "drift", "health", "projection"):
        assert from_dashboard[field] == from_list[field], field


# --------------------------------------------------------------------- layout


def test_layout_seeds_a_default_then_round_trips(client: TestClient) -> None:
    seeded_layout = client.get("/api/dashboard/layout").json()
    assert seeded_layout["widgets"], "an empty dashboard is indistinguishable from a broken one"

    widgets = [
        {"i": "a", "kind": "goal_progress", "x": 0, "y": 0, "w": 6, "h": 4, "config": {}},
        {"i": "b", "kind": "pace_vs_required", "x": 6, "y": 0, "w": 6, "h": 4,
         "config": {"trackable_id": 1}},
    ]
    saved = client.put("/api/dashboard/layout", json={"widgets": widgets})
    assert saved.status_code == 200
    assert [w["i"] for w in saved.json()["widgets"]] == ["a", "b"]
    assert client.get("/api/dashboard/layout").json()["widgets"][1]["config"] == {
        "trackable_id": 1
    }


def test_layout_rejects_duplicate_widget_ids(client: TestClient) -> None:
    """react-grid-layout keys positions by id; a duplicate makes one widget
    silently undraggable rather than failing visibly."""
    dup = [
        {"i": "same", "kind": "goal_progress", "x": 0, "y": 0, "w": 4, "h": 4},
        {"i": "same", "kind": "goal_health", "x": 4, "y": 0, "w": 4, "h": 4},
    ]
    r = client.put("/api/dashboard/layout", json={"widgets": dup})
    assert r.status_code == 422
    assert "same" in r.json()["detail"]


def test_unknown_widget_kinds_survive_a_round_trip(client: TestClient) -> None:
    """Version skew must not delete a widget. A client that does not recognise a
    kind renders a placeholder; a server that dropped it would destroy the
    user's layout on one stale page load."""
    widgets = [{"i": "future", "kind": "not_invented_yet", "x": 0, "y": 0, "w": 3, "h": 3}]
    client.put("/api/dashboard/layout", json={"widgets": widgets})
    assert client.get("/api/dashboard/layout").json()["widgets"][0]["kind"] == "not_invented_yet"


def test_dashboard_layout_is_isolated_per_account(client: TestClient) -> None:
    alice = client.post("/api/auth/register", json={
        "email": "alice-dash@example.com", "password": "correct-horse-battery",
    }).json()["token"]
    client.headers["Authorization"] = f"Bearer {alice}"
    client.put("/api/dashboard/layout", json={
        "widgets": [{"i": "alice", "kind": "goal_progress", "x": 0, "y": 0, "w": 4, "h": 4}]
    })

    bob = client.post("/api/auth/register", json={
        "email": "bob-dash@example.com", "password": "correct-horse-battery",
    }).json()["token"]
    client.headers["Authorization"] = f"Bearer {bob}"
    assert [w["i"] for w in client.get("/api/dashboard/layout").json()["widgets"]] != ["alice"]


def test_unknown_api_paths_404_instead_of_serving_the_spa(client: TestClient) -> None:
    """The catch-all must not answer /api with index.html.

    It used to, and the failure was miserable to diagnose: the client called
    .json() on HTML and reported "the string did not match the expected
    pattern", which points at the parser rather than at the real cause -- a
    server older than the frontend it is serving.
    """
    response = client.get("/api/dashboard/not-a-real-widget")
    assert response.status_code == 404
    assert "No such API endpoint" in response.json()["detail"]
    assert "text/html" not in response.headers.get("content-type", "")


def test_the_spa_shell_still_serves_client_routes(client: TestClient) -> None:
    """Non-API paths keep falling through to index.html."""
    response = client.get("/some/client/route")
    assert response.status_code == 200
    assert "text/html" in response.headers.get("content-type", "")
